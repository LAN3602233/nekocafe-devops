# syntax=docker/dockerfile:1.6
# ──────────────────────────────────────────────────────────────────────────
# 阶段 1: builder — 安装依赖（利用层缓存加速重复构建）
# ──────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# 仅先拷贝依赖清单，避免代码变更导致依赖层缓存失效
COPY requirements.txt ./

# 安装生产依赖到独立目录（不写入系统 site-packages，方便后续多阶段复制）
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# 拷贝源代码
COPY . .

# ──────────────────────────────────────────────────────────────────────────
# 阶段 2: runtime — 最小化运行镜像
# ──────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

# 安全：创建非 root 用户运行服务（符合 D3-1 §8 最小权限要求）
RUN addgroup --system app && adduser --system --ingroup app app

WORKDIR /app

# 从 builder 阶段复制已安装的依赖和源码
COPY --from=builder /install /usr/local
COPY --from=builder /app /app

# 切换到非 root 用户
USER app

# 暴露服务端口
EXPOSE 8080

# 健康检查（供 docker compose / Kubernetes liveness probe 使用）
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/healthz')" || exit 1

# 使用 uvicorn 启动 FastAPI 应用
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
