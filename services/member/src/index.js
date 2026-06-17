/**
 * 会员服务入口 — NekoCafé 猫咪主题餐饮预约平台
 * member service  /  Express.js  /  Node 20
 *
 * 职责：
 *   - 提供会员信息查询接口   GET  /api/members/:id
 *   - 提供会员注册接口       POST /api/members
 *   - 消费 Kafka reservation.confirmed 事件，更新会员积分
 *   - 暴露 /healthz 健康检查端点
 *   - 暴露 /metrics Prometheus 指标端点
 */

"use strict";

const express = require("express");
const { Pool } = require("pg");
const redis = require("redis");
const { Kafka } = require("kafkajs");
const client = require("prom-client");

// ── 环境变量 ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8080", 10);
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://nekocafe:nekocafe@postgres:5432/member_db";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379/1";
const KAFKA_BOOTSTRAP = process.env.KAFKA_BOOTSTRAP_SERVERS || "kafka:9092";

// ── 日志工具（结构化 JSON）────────────────────────────────────────────────
const log = {
  info: (msg, extra = {}) =>
    console.log(JSON.stringify({ time: new Date().toISOString(), level: "INFO", service: "member", message: msg, ...extra })),
  warn: (msg, extra = {}) =>
    console.warn(JSON.stringify({ time: new Date().toISOString(), level: "WARN", service: "member", message: msg, ...extra })),
  error: (msg, extra = {}) =>
    console.error(JSON.stringify({ time: new Date().toISOString(), level: "ERROR", service: "member", message: msg, ...extra })),
};

// ── Prometheus 指标 ───────────────────────────────────────────────────────
client.collectDefaultMetrics({ prefix: "member_" });

const httpRequestsTotal = new client.Counter({
  name: "member_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "endpoint", "status"],
});
const httpRequestDuration = new client.Histogram({
  name: "member_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["endpoint"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1.0, 3.0],
});
const memberCreatedTotal = new client.Counter({
  name: "member_created_total",
  help: "Total members registered",
});
const pointsUpdatedTotal = new client.Counter({
  name: "member_points_updated_total",
  help: "Total member point update events consumed",
});

// ── 数据库连接池 ──────────────────────────────────────────────────────────
const pgPool = new Pool({ connectionString: DATABASE_URL, max: 10 });

// ── Redis 客户端 ──────────────────────────────────────────────────────────
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.on("error", (err) => log.warn("Redis client error", { error: err.message }));

// ── Kafka 消费者（消费 reservation.confirmed 事件）────────────────────────
const kafka = new Kafka({
  clientId: "member-service",
  brokers: [KAFKA_BOOTSTRAP],
  retry: { retries: 5 },
});
const consumer = kafka.consumer({ groupId: "member-service-group" });

// ── 表结构初始化（幂等）────────────────────────────────────────────────────
async function ensureSchema() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(64) NOT NULL,
      phone      VARCHAR(20) UNIQUE NOT NULL,
      points     INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  log.info("DB schema ready");
}

// ── Express 应用 ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// 中间件：请求计时 & 指标收集
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc({ method: req.method, endpoint: req.path, status: res.statusCode });
    httpRequestDuration.observe({ endpoint: req.path }, durationMs);
  });
  next();
});

// ────────────────────────────────────────────────────────────────────────
// 路由
// ────────────────────────────────────────────────────────────────────────

/** 健康检查 */
app.get("/healthz", async (req, res) => {
  const checks = {};

  // DB 检查
  try {
    await pgPool.query("SELECT 1");
    checks.postgres = "ok";
  } catch (err) {
    checks.postgres = `error: ${err.message}`;
  }

  // Redis 检查
  try {
    await redisClient.ping();
    checks.redis = "ok";
  } catch (err) {
    checks.redis = `error: ${err.message}`;
  }

  const healthy = Object.values(checks).every((v) => v === "ok");
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    checks,
  });
});

/** Prometheus 指标 */
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

/** 查询会员信息（读路径：优先 Redis 缓存）*/
app.get("/api/members/:id", async (req, res) => {
  const { id } = req.params;
  const cacheKey = `member:${id}`;

  try {
    // 1. 尝试读缓存
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      log.info("cache HIT", { key: cacheKey });
      return res.json({ source: "cache", member: JSON.parse(cached) });
    }

    // 2. 缓存未命中 → 查 DB
    const result = await pgPool.query("SELECT * FROM members WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "会员不存在" });
    }
    const member = result.rows[0];

    // 3. 写入缓存，TTL=120s
    await redisClient.setEx(cacheKey, 120, JSON.stringify(member));
    log.info("cache MISS — written to cache", { key: cacheKey });

    return res.json({ source: "db", member });
  } catch (err) {
    log.error("get member failed", { id, error: err.message });
    return res.status(500).json({ error: "内部错误" });
  }
});

/** 注册会员（写路径）*/
app.post("/api/members", async (req, res) => {
  const { name, phone } = req.body;

  if (!name || !phone) {
    return res.status(422).json({ error: "name 和 phone 为必填字段" });
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(422).json({ error: "phone 格式不合法，需为 11 位大陆手机号" });
  }

  try {
    const existing = await pgPool.query("SELECT id FROM members WHERE phone = $1", [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "该手机号已注册" });
    }

    const result = await pgPool.query(
      "INSERT INTO members (name, phone) VALUES ($1, $2) RETURNING *",
      [name, phone]
    );
    const member = result.rows[0];
    memberCreatedTotal.inc();
    log.info("member registered", { id: member.id, phone });

    return res.status(201).json({ message: "注册成功", member });
  } catch (err) {
    log.error("create member failed", { phone, error: err.message });
    return res.status(500).json({ error: "内部错误" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Kafka 消费者：监听 reservation.confirmed → 增加会员积分
// ────────────────────────────────────────────────────────────────────────
async function startKafkaConsumer() {
  try {
    await consumer.connect();
    await consumer.subscribe({ topic: "reservation.confirmed", fromBeginning: false });
    log.info("Kafka consumer connected and subscribed to reservation.confirmed");

    await consumer.run({
      eachMessage: async ({ topic: _topic, partition: _partition, message }) => {
        const raw = message.value?.toString();
        if (!raw) return;

        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          log.warn("invalid Kafka message — skipping", { raw });
          return;
        }

        log.info("consumed event", { type: event.type, customer: event.customer });

        if (event.type === "ReservationConfirmed" && event.customer) {
          // 根据顾客姓名查找会员并加 10 积分
          try {
            const result = await pgPool.query(
              "UPDATE members SET points = points + 10 WHERE name = $1 RETURNING id, points",
              [event.customer]
            );
            if (result.rowCount > 0) {
              const { id, points } = result.rows[0];
              // 失效该会员的 Redis 缓存
              await redisClient.del(`member:${id}`);
              pointsUpdatedTotal.inc();
              log.info("member points updated", { id, points, customer: event.customer });
            }
          } catch (err) {
            log.error("update points failed", { customer: event.customer, error: err.message });
          }
        }
      },
    });
  } catch (err) {
    log.warn("Kafka consumer start failed (non-fatal, will retry on restart)", { error: err.message });
  }
}

// ────────────────────────────────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────────────────────────────────
async function start() {
  await redisClient.connect();
  log.info("Redis connected");

  await ensureSchema();

  // Kafka 消费者（失败不影响 HTTP 服务启动）
  startKafkaConsumer().catch((err) =>
    log.warn("Kafka consumer startup error", { error: err.message })
  );

  app.listen(PORT, () => {
    log.info(`member service listening on port ${PORT}`);
  });
}

start().catch((err) => {
  log.error("fatal startup error", { error: err.message });
  process.exit(1);
});
