"""
预约服务入口 — NekoCafé 猫咪主题餐饮预约平台
reservation service  /  FastAPI  /  Python 3.12

职责：
  - 提供可预约桌位查询接口（GET /api/tables/available）  → CQRS 读路径，走 Redis 缓存
  - 提供创建预约接口（POST /api/reserve）               → CQRS 写路径，写 PostgreSQL
  - 发布 ReservationConfirmed 事件到 Kafka
  - 暴露 /healthz 健康检查端点
  - 暴露 /metrics Prometheus 指标端点
"""

import os
import logging
import time
from contextlib import asynccontextmanager
from datetime import date as date_type

import redis.asyncio as aioredis
import asyncpg
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

# ── 日志配置：结构化 JSON ──────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","service":"reservation","message":"%(message)s"}',
)
logger = logging.getLogger("reservation")

# ── 环境变量 ──────────────────────────────────────────────────────────────
DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql://nekocafe:nekocafe@postgres:5432/reservation_db",
)
REDIS_URL: str = os.getenv("REDIS_URL", "redis://redis:6379/0")
KAFKA_BOOTSTRAP: str = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
SERVICE_PORT: int = int(os.getenv("PORT", "8080"))

# ── Prometheus 指标 ────────────────────────────────────────────────────────
REQUEST_COUNT = Counter(
    "reservation_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status"],
)
REQUEST_LATENCY = Histogram(
    "reservation_request_latency_seconds",
    "HTTP request latency",
    ["endpoint"],
    buckets=[0.01, 0.05, 0.1, 0.3, 0.5, 1.0, 3.0],
)
RESERVATION_CREATED = Counter(
    "reservation_created_total",
    "Total reservations created",
)

# ── 全局连接池（在 lifespan 中初始化）──────────────────────────────────────
db_pool: asyncpg.Pool | None = None
redis_client: aioredis.Redis | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：连接数据库 & Redis；关闭时释放连接。"""
    global db_pool, redis_client
    logger.info("reservation service starting — connecting to DB and Redis …")

    # 连接 PostgreSQL（重试最多 5 次，适配 Docker Compose 启动顺序）
    for attempt in range(5):
        try:
            db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
            await _ensure_schema()
            logger.info("PostgreSQL connected ✓")
            break
        except Exception as exc:
            logger.warning("DB connect attempt %d failed: %s", attempt + 1, exc)
            time.sleep(2 ** attempt)
    else:
        logger.error("Cannot connect to PostgreSQL after 5 attempts — aborting")
        raise RuntimeError("DB unavailable")

    # 连接 Redis
    redis_client = await aioredis.from_url(REDIS_URL, decode_responses=True)
    logger.info("Redis connected ✓")

    yield  # 应用运行阶段

    # 关闭时释放
    if db_pool:
        await db_pool.close()
    if redis_client:
        await redis_client.aclose()
    logger.info("reservation service stopped — connections closed")


async def _ensure_schema():
    """初始化表结构（幂等）。生产环境应改用 Flyway。"""
    async with db_pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS reservations (
                id          SERIAL PRIMARY KEY,
                table_id    INTEGER NOT NULL,
                customer    VARCHAR(64) NOT NULL,
                date        DATE NOT NULL,
                slot        VARCHAR(16) NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            );
        """)


# ── FastAPI 应用 ───────────────────────────────────────────────────────────
app = FastAPI(title="NekoCafé Reservation Service", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    """统一拦截请求，记录耗时与计数。"""
    start = time.perf_counter()
    response = await call_next(request)
    elapsed = time.perf_counter() - start
    REQUEST_COUNT.labels(
        method=request.method,
        endpoint=request.url.path,
        status=response.status_code,
    ).inc()
    REQUEST_LATENCY.labels(endpoint=request.url.path).observe(elapsed)
    return response


# ────────────────────────────────────────────────────────────────────────────
# 数据模型
# ────────────────────────────────────────────────────────────────────────────

class ReservationRequest(BaseModel):
    table_id: int = Field(..., ge=1, le=50, description="桌位编号 1~50")
    customer: str = Field(..., min_length=1, max_length=64, description="顾客姓名")
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$", description="预约日期 YYYY-MM-DD")
    slot: str = Field(..., description="时间段，如 18:00-20:00")


class ReservationResponse(BaseModel):
    id: int
    table_id: int
    customer: str
    date: str
    slot: str
    message: str = "预约成功"


# ────────────────────────────────────────────────────────────────────────────
# 路由
# ────────────────────────────────────────────────────────────────────────────

@app.get("/healthz", summary="健康检查", tags=["ops"])
async def healthz():
    """供 Kubernetes liveness probe / docker-compose healthcheck 使用。"""
    checks: dict[str, str] = {}

    # DB 检查
    try:
        async with db_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        checks["postgres"] = "ok"
    except Exception as exc:
        checks["postgres"] = f"error: {exc}"

    # Redis 检查
    try:
        await redis_client.ping()
        checks["redis"] = "ok"
    except Exception as exc:
        checks["redis"] = f"error: {exc}"

    healthy = all(v == "ok" for v in checks.values())
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "degraded", "checks": checks},
    )


@app.get("/metrics", summary="Prometheus 指标", tags=["ops"])
async def metrics():
    """Prometheus scrape 端点，返回文本格式指标。"""
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/api/tables/available", summary="查询可预约桌位（CQRS 读路径）", tags=["reservation"])
async def get_available_tables(date: str, slot: str):
    """
    读路径：先查 Redis 缓存，命中直接返回；未命中查 DB 后写入缓存（TTL=60s）。
    符合 D3-1 §1.2 CQRS 读写分离要求。
    """
    cache_key = f"available:{date}:{slot}"

    # 转换日期字符串为 date 对象（asyncpg 要求）
    try:
        parsed_date = date_type.fromisoformat(date)
    except ValueError:
        raise HTTPException(status_code=422, detail="日期格式错误，需为 YYYY-MM-DD")

    # 1. 尝试命中缓存
    cached = await redis_client.get(cache_key)
    if cached:
        logger.info("cache HIT key=%s", cache_key)
        import json
        return {"source": "cache", "tables": json.loads(cached)}

    # 2. 缓存未命中 → 查 DB
    logger.info("cache MISS key=%s — querying DB", cache_key)
    async with db_pool.acquire() as conn:
        booked = await conn.fetch(
            "SELECT table_id FROM reservations WHERE date=$1 AND slot=$2",
            parsed_date, slot,
        )
    booked_ids = {row["table_id"] for row in booked}
    available = [t for t in range(1, 21) if t not in booked_ids]  # 共 20 张桌

    # 3. 写入缓存，TTL=60 秒
    import json
    await redis_client.setex(cache_key, 60, json.dumps(available))

    return {"source": "db", "tables": available}


@app.post("/api/reserve", response_model=ReservationResponse, status_code=201,
          summary="创建预约（CQRS 写路径）", tags=["reservation"])
async def create_reservation(body: ReservationRequest):
    """
    写路径：写入 PostgreSQL，失效 Redis 缓存，发布 ReservationConfirmed 事件。
    符合 D3-1 §1.2 写路径要求。
    """
    # 检查桌位是否已被占用
    try:
        parsed_date = date_type.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(status_code=422, detail="日期格式错误，需为 YYYY-MM-DD")

    async with db_pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT id FROM reservations WHERE table_id=$1 AND date=$2 AND slot=$3",
            body.table_id, parsed_date, body.slot,
        )
        if exists:
            raise HTTPException(status_code=409, detail="该桌位在此时间段已被预约")

        # 写入预约记录
        row_id = await conn.fetchval(
            """
            INSERT INTO reservations (table_id, customer, date, slot)
            VALUES ($1, $2, $3, $4)
            RETURNING id
            """,
            body.table_id, body.customer, parsed_date, body.slot,
        )

    # 失效缓存
    cache_key = f"available:{body.date}:{body.slot}"
    await redis_client.delete(cache_key)
    logger.info("cache invalidated key=%s", cache_key)

    # 发布事件（异步、容错：Kafka 不可用时仅记录日志，不影响主流程）
    _publish_event(body.table_id, body.customer, body.date, body.slot)

    RESERVATION_CREATED.inc()
    logger.info(
        "reservation created id=%d table=%d customer=%s date=%s slot=%s",
        row_id, body.table_id, body.customer, body.date, body.slot,
    )

    return ReservationResponse(
        id=row_id,
        table_id=body.table_id,
        customer=body.customer,
        date=body.date,
        slot=body.slot,
    )


def _publish_event(table_id: int, customer: str, date: str, slot: str):
    """
    向 Kafka 发布 ReservationConfirmed 事件（同步发送，容错处理）。
    实际生产环境应使用 aiokafka 异步发送。
    """
    try:
        from kafka import KafkaProducer
        import json as _json
        producer = KafkaProducer(
            bootstrap_servers=KAFKA_BOOTSTRAP,
            value_serializer=lambda v: _json.dumps(v).encode("utf-8"),
        )
        producer.send("reservation.confirmed", {
            "type": "ReservationConfirmed",
            "table_id": table_id,
            "customer": customer,
            "date": date,
            "slot": slot,
        })
        producer.flush()
        logger.info("event published to Kafka: ReservationConfirmed table=%d", table_id)
    except Exception as exc:
        logger.warning("Kafka publish failed (non-fatal): %s", exc)


# ────────────────────────────────────────────────────────────────────────────
# 入口（本地开发直接运行）
# ────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.main:app", host="0.0.0.0", port=SERVICE_PORT, reload=True)
