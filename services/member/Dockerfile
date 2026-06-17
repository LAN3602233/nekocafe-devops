# syntax=docker/dockerfile:1.6
# ──────────────────────────────────────────────────────────────────────────
# 阶段 1: deps — 安装依赖（利用层缓存加速重复构建）
# ──────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# 只拷贝 package 文件，避免代码变更使依赖缓存失效
COPY package.json package-lock.json* ./

# 仅安装生产依赖
RUN npm ci --omit=dev

# ──────────────────────────────────────────────────────────────────────────
# 阶段 2: runtime — 最小化运行镜像
# ──────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# 安全：创建非 root 用户（符合 D3-1 §8 最小权限要求）
RUN addgroup -S app && adduser -S -G app app

WORKDIR /app

# 从 deps 阶段复制生产依赖和源码
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 切换到非 root 用户
USER app

# 暴露服务端口
EXPOSE 8080

# 健康检查（供 docker compose / Kubernetes liveness probe 使用）
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

# 启动服务
CMD ["node", "src/index.js"]
