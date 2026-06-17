# NekoCafé 猫咪主题餐饮预约平台

> **实验三 · DevOps 流水线与容器化部署 — PoC 仓库**
> 北京林业大学 · 信息学院 · 软件工程课程

---

## 项目概述

NekoCafé 是一个猫咪主题餐饮预约平台，本仓库是实验三的 PoC（概念验证）实现，包含以下微服务：

| 服务 | 技术栈 | 说明 |
|------|--------|------|
| `reservation` | Python 3.12 / FastAPI | 预约服务：桌位查询（CQRS 读路径）、创建预约（CQRS 写路径）|
| `member` | Node.js 20 / Express | 会员服务：会员注册、积分管理、消费 Kafka 事件 |

基础设施：

| 组件 | 版本 | 用途 |
|------|------|------|
| PostgreSQL | 16-alpine | 业务数据持久化（一服务一库） |
| Redis | 7-alpine | 读缓存（CQRS 读路径加速） |
| Kafka | 3.7（KRaft）| 事件总线（ReservationConfirmed 事件） |

---

## 快速启动

**前提条件：** Docker 24+ 和 Docker Compose V2

```bash
# 1. 克隆仓库
git clone <repo-url> && cd nekocafe

# 2. 一键启动全栈
make up

# 3. 等待约 30 秒后，验证服务健康
make healthcheck

# 4. 运行冒烟测试（创建预约 + 查询桌位）
make smoke
```

服务地址：

| 服务 | 地址 | 说明 |
|------|------|------|
| reservation API | http://localhost:8081 | 预约服务 |
| member API | http://localhost:8082 | 会员服务 |
| reservation healthz | http://localhost:8081/healthz | 健康检查 |
| reservation metrics | http://localhost:8081/metrics | Prometheus 指标 |

---

## 目录结构

```
.
├── .github/
│   └── workflows/
│       ├── ci.yml          # CI 流水线：Lint → 测试 → SAST → 构建 → 扫描 → 集成测试
│       └── cd.yml          # CD 流水线：dev 自动部署 / prod 金丝雀发布
├── services/
│   ├── reservation/        # 预约服务（Python / FastAPI）
│   │   ├── src/
│   │   │   ├── __init__.py
│   │   │   └── main.py     # FastAPI 应用入口
│   │   ├── tests/
│   │   │   └── test_smoke.py
│   │   ├── Dockerfile      # 多阶段构建
│   │   ├── requirements.txt
│   │   └── requirements-dev.txt
│   └── member/             # 会员服务（Node.js / Express）
│       ├── src/
│       │   └── index.js    # Express 应用入口
│       ├── Dockerfile      # 多阶段构建
│       └── package.json
├── scripts/
│   └── init-db.sh          # PostgreSQL 初始化脚本（创建多数据库）
├── docs/
│   ├── runbook.md          # 故障处理手册
│   └── rollback.md         # 回滚操作指南
├── docker-compose.yml      # 本地开发全栈编排
├── Makefile                # 常用命令入口
└── README.md               # 本文件
```

---

## 常用命令

```bash
make up              # 构建并启动全栈
make down            # 停止并删除容器（含 volume）
make test            # 在容器内运行单元测试
make test-unit       # 在本地 Python 环境运行测试
make lint            # 代码检查（ruff + eslint）
make healthcheck     # 检查服务健康状态
make smoke           # 冒烟测试（API 联调）
make logs            # 实时查看所有服务日志
make help            # 显示所有可用命令
```

---

## 架构说明

### CQRS 读写分离（reservation 服务）

```
写路径：POST /api/reserve
  → 写入 PostgreSQL reservation_db
  → 失效 Redis 缓存
  → 发布 ReservationConfirmed 事件到 Kafka

读路径：GET /api/tables/available
  → 优先读 Redis 缓存（TTL=60s）
  → 缓存未命中 → 查询 PostgreSQL → 写入缓存
```

### 事件驱动（member 服务）

```
Kafka Topic: reservation.confirmed
  ← reservation 服务发布
  → member 服务消费 → 更新会员积分（+10 分/次）
```

### CI/CD 流程

```
代码推送 / PR
  → Lint（ruff / eslint）
  → 单元测试（pytest / jest）
  → SAST（GitHub CodeQL）
  → Docker 镜像构建（多阶段）
  → Trivy 安全扫描（HIGH/CRITICAL 阻断）
  → 集成测试（docker compose 全栈）
  → [main] 自动部署到 dev 环境
  → [tag v*] 金丝雀发布 5% → 50% → 100% 到 prod
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | `postgresql://nekocafe:nekocafe@postgres:5432/reservation_db` | PostgreSQL 连接串 |
| `REDIS_URL` | `redis://redis:6379/0` | Redis 连接串 |
| `KAFKA_BOOTSTRAP_SERVERS` | `kafka:9092` | Kafka Bootstrap 地址 |
| `PORT` | `8080` | 服务监听端口 |

---

## 分支策略

采用 **Trunk-Based Development**（符合 D3-1 §3）：

- `main`：主干分支，始终可发布，受 PR 保护
- `feature/*`：功能分支，通过 PR 合并到 main
- `release/*`：紧急热修复分支

---

## 相关文档

- [故障处理手册 (Runbook)](docs/runbook.md)
- [回滚操作指南](docs/rollback.md)
- [D3-1 DevOps 设计方案](../D3-1_DevOps设计方案_模板.docx)
- [D3-5 K8s 部署清单与 Helm Chart](../D3-5_K8s部署清单与Helm_Chart/)
