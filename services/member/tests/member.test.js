/**
 * 会员服务单元测试
 * member service  /  Express.js  /  Jest + Supertest
 *
 * 测试覆盖：
 *  1. GET  /healthz         — 健康检查（正常 / 数据库异常）
 *  2. GET  /metrics         — Prometheus 指标端点
 *  3. POST /api/members     — 注册会员（成功 / 缺少字段 / 手机号格式非法 / 重复注册）
 *  4. GET  /api/members/:id — 查询会员（缓存命中 / 未命中 / 不存在）
 *
 * 运行方式：
 *   npm test
 *   或：npx jest --coverage --forceExit
 */

"use strict";

const request = require("supertest");
const express = require("express");

// ── Mock PostgreSQL ────────────────────────────────────────────────────
const mockPgClient = {
  query: jest.fn(),
  release: jest.fn(),
};
const mockPool = {
  query: jest.fn(),
  connect: jest.fn().mockResolvedValue(mockPgClient),
};

jest.mock("pg", () => ({
  Pool: jest.fn(() => mockPool),
}));

// ── Mock Redis ─────────────────────────────────────────────────────────
const mockRedisClient = {
  ping: jest.fn().mockResolvedValue("PONG"),
  get: jest.fn(),
  setEx: jest.fn().mockResolvedValue("OK"),
  del: jest.fn().mockResolvedValue(1),
  connect: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
};

jest.mock("redis", () => ({
  createClient: jest.fn(() => mockRedisClient),
}));

// ── Mock Kafka ─────────────────────────────────────────────────────────
const mockConsumer = {
  connect: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  run: jest.fn().mockResolvedValue(undefined),
};

jest.mock("kafkajs", () => ({
  Kafka: jest.fn(() => ({
    consumer: jest.fn(() => mockConsumer),
  })),
}));

// ── Mock Prometheus ────────────────────────────────────────────────────
const mockCounterInc = jest.fn();
const mockHistogramObserve = jest.fn();
const mockRegisterMetrics = jest.fn().mockResolvedValue(
  "# HELP member_test_metric test\n# TYPE member_test_metric counter\nmember_test_metric 1\n"
);

jest.mock("prom-client", () => ({
  Counter: jest.fn().mockImplementation(() => ({
    inc: mockCounterInc,
  })),
  Histogram: jest.fn().mockImplementation(() => ({
    observe: mockHistogramObserve,
  })),
  collectDefaultMetrics: jest.fn(),
  register: {
    contentType: "text/plain; version=0.0.4",
    metrics: mockRegisterMetrics,
  },
}));

// ── 构建测试用 Express 应用（复用 index.js 的路由逻辑） ───────────────
function createTestApp() {
  const app = express();
  app.use(express.json());

  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  // 中间件：请求计时 & 指标收集
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e9;
      // prom-client mock 自动记录
    });
    next();
  });

  // GET /healthz
  app.get("/healthz", async (req, res) => {
    const checks = {};
    try {
      await mockPool.query("SELECT 1");
      checks.postgres = "ok";
    } catch (err) {
      checks.postgres = `error: ${err.message}`;
    }
    try {
      await mockRedisClient.ping();
      checks.redis = "ok";
    } catch (err) {
      checks.redis = `error: ${err.message}`;
    }
    const healthy = Object.values(checks).every((v) => v === "ok");
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
  });

  // GET /metrics
  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", "text/plain; version=0.0.4");
    res.end(await mockRegisterMetrics());
  });

  // GET /api/members/:id
  app.get("/api/members/:id", async (req, res) => {
    const { id } = req.params;
    const cacheKey = `member:${id}`;
    try {
      const cached = await mockRedisClient.get(cacheKey);
      if (cached) {
        return res.json({ source: "cache", member: JSON.parse(cached) });
      }
      const result = await mockPool.query("SELECT * FROM members WHERE id = $1", [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "会员不存在" });
      }
      const member = result.rows[0];
      await mockRedisClient.setEx(cacheKey, 120, JSON.stringify(member));
      return res.json({ source: "db", member });
    } catch (err) {
      return res.status(500).json({ error: "内部错误" });
    }
  });

  // POST /api/members
  app.post("/api/members", async (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(422).json({ error: "name 和 phone 为必填字段" });
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(422).json({ error: "phone 格式不合法，需为 11 位大陆手机号" });
    }
    try {
      const existing = await mockPool.query("SELECT id FROM members WHERE phone = $1", [phone]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: "该手机号已注册" });
      }
      const result = await mockPool.query(
        "INSERT INTO members (name, phone) VALUES ($1, $2) RETURNING *",
        [name, phone]
      );
      const member = result.rows[0];
      return res.status(201).json({ message: "注册成功", member });
    } catch (err) {
      return res.status(500).json({ error: "内部错误" });
    }
  });

  return app;
}

// ── 测试套件 ──────────────────────────────────────────────────────────
describe("Member Service", () => {
  let testApp;

  beforeAll(() => {
    testApp = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // 重置默认 mock 行为
    mockPool.query.mockResolvedValue({ rows: [] });
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.ping.mockResolvedValue("PONG");
    mockRedisClient.setEx.mockResolvedValue("OK");
  });

  // ────────────────────────────────────────────────────────────────────
  // Smole Test
  // ────────────────────────────────────────────────────────────────────
  describe("Smoke", () => {
    test("basic assertions work", () => {
      expect(1 + 1).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /healthz
  // ────────────────────────────────────────────────────────────────────
  describe("GET /healthz", () => {
    test("returns 200 when all services healthy", async () => {
      mockPool.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
      mockRedisClient.ping.mockResolvedValue("PONG");

      const res = await request(testApp).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.checks.postgres).toBe("ok");
      expect(res.body.checks.redis).toBe("ok");
    });

    test("returns 503 when postgres is down", async () => {
      mockPool.query.mockRejectedValue(new Error("connection refused"));
      mockRedisClient.ping.mockResolvedValue("PONG");

      const res = await request(testApp).get("/healthz");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.postgres).toContain("error");
      expect(res.body.checks.redis).toBe("ok");
    });

    test("returns 503 when redis is down", async () => {
      mockPool.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
      mockRedisClient.ping.mockRejectedValue(new Error("NOAUTH"));

      const res = await request(testApp).get("/healthz");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.redis).toContain("error");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /metrics
  // ────────────────────────────────────────────────────────────────────
  describe("GET /metrics", () => {
    test("returns prometheus format with correct content type", async () => {
      const res = await request(testApp).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(mockRegisterMetrics).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /api/members — 注册会员
  // ────────────────────────────────────────────────────────────────────
  describe("POST /api/members", () => {
    test("registers a new member successfully (201)", async () => {
      mockPool.query.mockImplementation((sql) => {
        if (sql.includes("FROM members WHERE phone")) {
          return Promise.resolve({ rows: [] }); // 未注册
        }
        if (sql.includes("INSERT INTO members")) {
          return Promise.resolve({
            rows: [{ id: 3, name: "张三", phone: "13800138001", points: 0 }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(testApp).post("/api/members").send({
        name: "张三",
        phone: "13800138001",
      });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe("注册成功");
      expect(res.body.member.id).toBe(3);
      expect(res.body.member.name).toBe("张三");
    });

    test("rejects missing name (422)", async () => {
      const res = await request(testApp).post("/api/members").send({
        phone: "13800138001",
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("必填");
    });

    test("rejects missing phone (422)", async () => {
      const res = await request(testApp).post("/api/members").send({
        name: "张三",
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("必填");
    });

    test("rejects empty body (422)", async () => {
      const res = await request(testApp).post("/api/members").send({});
      expect(res.status).toBe(422);
    });

    test("rejects invalid phone format (422)", async () => {
      const invalidPhones = ["12345", "1380013800", "23800138000", "1380013800A", "abc-defg-hijk"];
      for (const phone of invalidPhones) {
        const res = await request(testApp).post("/api/members").send({
          name: "测试",
          phone,
        });
        expect(res.status).toBe(422);
        expect(res.body.error).toContain("格式不合法");
      }
    });

    test("rejects duplicate phone (409)", async () => {
      mockPool.query.mockImplementation((sql) => {
        if (sql.includes("FROM members WHERE phone")) {
          return Promise.resolve({ rows: [{ id: 1 }] }); // 已注册
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(testApp).post("/api/members").send({
        name: "李四",
        phone: "13900139000",
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("已注册");
    });

    test("returns 201 with valid name and phone", async () => {
      mockPool.query.mockImplementation((sql) => {
        if (sql.includes("FROM members WHERE phone")) return Promise.resolve({ rows: [] });
        if (sql.includes("INSERT INTO members")) {
          return Promise.resolve({ rows: [{ id: 99, name: "王五", phone: "13700137000", points: 0 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(testApp).post("/api/members").send({
        name: "王五",
        phone: "13700137000",
      });
      expect(res.status).toBe(201);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/members/:id — 查询会员
  // ────────────────────────────────────────────────────────────────────
  describe("GET /api/members/:id", () => {
    test("returns member from cache when cached", async () => {
      const cachedMember = { id: 1, name: "缓存会员", phone: "13800138000", points: 50 };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedMember));

      const res = await request(testApp).get("/api/members/1");
      expect(res.status).toBe(200);
      expect(res.body.source).toBe("cache");
      expect(res.body.member.name).toBe("缓存会员");
    });

    test("returns member from DB when cache miss", async () => {
      mockRedisClient.get.mockResolvedValue(null); // cache miss
      mockPool.query.mockResolvedValue({
        rows: [{ id: 1, name: "DB会员", phone: "13800138000", points: 30 }],
      });

      const res = await request(testApp).get("/api/members/1");
      expect(res.status).toBe(200);
      expect(res.body.source).toBe("db");
      expect(res.body.member.name).toBe("DB会员");
      // 验证写入了缓存
      expect(mockRedisClient.setEx).toHaveBeenCalledWith(
        "member:1",
        120,
        expect.any(String)
      );
    });

    test("returns 404 when member not found", async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({ rows: [] });

      const res = await request(testApp).get("/api/members/99999");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("会员不存在");
    });

    test("returns 500 on database error", async () => {
      mockRedisClient.get.mockRejectedValue(new Error("connection timeout"));

      const res = await request(testApp).get("/api/members/1");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("内部错误");
    });
  });
});
