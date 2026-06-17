"""
预约服务冒烟测试 & 单元测试
使用 FastAPI TestClient（无需真实 DB/Redis/Kafka）

测试覆盖：
  1. /healthz       - 健康检查端点存在
  2. /metrics       - Prometheus 指标端点存在
  3. POST /api/reserve  - 参数校验（缺失字段返回 422）
  4. GET /api/tables/available - 参数校验
  5. 日期格式非法   - 返回 422

运行方式：
  pytest services/reservation/tests/ -v
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient


# ── 在导入 app 之前 Mock 掉数据库和 Redis 连接 ────────────────────────────

@pytest.fixture(scope="module")
def mock_app():
    """
    使用 Mock 替代数据库、Redis 等外部依赖，
    避免测试时需要真实基础设施。
    """
    mock_pool = MagicMock()
    mock_pool.acquire = MagicMock()
    mock_pool.close = AsyncMock()

    mock_redis = AsyncMock()
    mock_redis.ping = AsyncMock(return_value=True)
    mock_redis.get = AsyncMock(return_value=None)
    mock_redis.setex = AsyncMock()
    mock_redis.delete = AsyncMock()

    # 模拟 asyncpg.Pool.acquire() 返回的 async context manager
    mock_conn = AsyncMock()
    mock_conn.fetchval = AsyncMock(return_value=1)
    mock_conn.fetch = AsyncMock(return_value=[])
    mock_conn.execute = AsyncMock()

    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

    with patch("asyncpg.create_pool", AsyncMock(return_value=mock_pool)), \
         patch("redis.asyncio.from_url", AsyncMock(return_value=mock_redis)):
        from src.main import app as fastapi_app
        import src.main as m
        m.db_pool = mock_pool
        m.redis_client = mock_redis
        yield fastapi_app, mock_conn, mock_redis


@pytest.fixture(scope="module")
def client(mock_app):
    app, _, _ = mock_app
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ── 冒烟测试 ────────────────────────────────────────────────────────────────

def test_smoke():
    """最基本的逻辑冒烟：确保测试框架正常运行。"""
    assert 1 + 1 == 2


# ── 健康检查 ────────────────────────────────────────────────────────────────

def test_healthz_exists(client):
    """健康检查端点应返回 200 或 503，但必须存在（非 404）。"""
    resp = client.get("/healthz")
    assert resp.status_code in (200, 503), f"Unexpected status: {resp.status_code}"
    data = resp.json()
    assert "status" in data
    assert "checks" in data


def test_metrics_exists(client):
    """/metrics 端点应返回 Prometheus 文本格式。"""
    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert "reservation_requests_total" in resp.text or "python_gc" in resp.text


# ── 参数校验测试 ─────────────────────────────────────────────────────────────

def test_create_reservation_missing_fields(client):
    """POST /api/reserve 缺少必填字段应返回 422。"""
    resp = client.post("/api/reserve", json={})
    assert resp.status_code == 422
    body = resp.json()
    assert "detail" in body


def test_create_reservation_invalid_date(client):
    """日期格式非法（非 YYYY-MM-DD）应返回 422。"""
    resp = client.post("/api/reserve", json={
        "table_id": 1,
        "customer": "测试顾客",
        "date": "2026/06/01",   # 使用了 / 而非 -
        "slot": "18:00-20:00",
    })
    assert resp.status_code == 422


def test_create_reservation_table_out_of_range(client):
    """桌位编号超出范围（>50）应返回 422。"""
    resp = client.post("/api/reserve", json={
        "table_id": 99,
        "customer": "测试顾客",
        "date": "2026-06-01",
        "slot": "18:00-20:00",
    })
    assert resp.status_code == 422


def test_get_available_tables_missing_params(client):
    """GET /api/tables/available 缺少 date/slot 参数应返回 422。"""
    resp = client.get("/api/tables/available")
    assert resp.status_code == 422


def test_get_available_tables_with_params(client, mock_app):
    """提供合法参数时应返回 200，包含 tables 字段。"""
    _, mock_conn, mock_redis = mock_app
    mock_redis.get.return_value = None          # 缓存未命中
    mock_conn.fetch.return_value = []           # DB 无占用记录

    resp = client.get("/api/tables/available", params={"date": "2026-06-01", "slot": "18:00-20:00"})
    assert resp.status_code == 200
    data = resp.json()
    assert "tables" in data
    assert isinstance(data["tables"], list)
