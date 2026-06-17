.PHONY: up down test lint healthcheck logs clean help

# ─────────────────────────────────────────────────────────────────────────
# NekoCafé 本地开发 Makefile
# 使用方式：make <target>
# ─────────────────────────────────────────────────────────────────────────

## up: 构建并后台启动全栈服务（postgres、redis、kafka、reservation、member）
up:
	docker-compose up -d --build
	@echo ""
	@echo "服务已启动，稍等片刻后运行 make healthcheck 确认状态"

## down: 停止并删除所有容器及 volume（慎用，会清除本地数据库数据）
down:
	docker-compose down -v

## restart: 重启所有服务（不重新构建镜像）
restart:
	docker-compose restart

## rebuild: 强制重新构建镜像并重启
rebuild:
	docker-compose up -d --build --force-recreate

## test: 在容器内运行 reservation 单元测试
test:
	docker-compose exec reservation pytest tests/ -v --tb=short

## test-unit: 在本地 Python 环境运行单元测试（不需要启动 Docker）
test-unit:
	cd services/reservation && \
	  pip install -q -r requirements.txt -r requirements-dev.txt && \
	  pytest tests/ -v --tb=short

## lint: 对所有服务执行代码检查
lint:
	@echo "==> Linting reservation (ruff)..."
	cd services/reservation && python -m ruff check src/ || true
	@echo "==> Linting member (eslint)..."
	cd services/member && npx eslint src/ || true

## healthcheck: 检查各服务健康状态
healthcheck:
	@echo "==> reservation healthz"
	@curl -sf http://localhost:8081/healthz | python3 -m json.tool || echo "FAILED"
	@echo ""
	@echo "==> member healthz"
	@curl -sf http://localhost:8082/healthz | python3 -m json.tool || echo "FAILED"

## smoke: 快速冒烟测试（创建预约 + 查询可用桌位）
smoke:
	@echo "==> POST /api/reserve"
	@curl -sf -X POST http://localhost:8081/api/reserve \
	  -H "Content-Type: application/json" \
	  -d '{"table_id":1,"customer":"smoke-test","date":"2099-12-31","slot":"18:00-20:00"}' \
	  | python3 -m json.tool
	@echo ""
	@echo "==> GET /api/tables/available"
	@curl -sf "http://localhost:8081/api/tables/available?date=2099-12-31&slot=18:00-20:00" \
	  | python3 -m json.tool

## logs: 实时查看所有服务日志
logs:
	docker-compose logs -f

## logs-reservation: 只看预约服务日志
logs-reservation:
	docker-compose logs -f reservation

## logs-member: 只看会员服务日志
logs-member:
	docker-compose logs -f member

## ps: 查看容器运行状态
ps:
	docker-compose ps

## clean: 清理本地构建缓存和临时文件
clean:
	docker system prune -f
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true

## help: 显示此帮助信息
help:
	@grep -E '^##' Makefile | sed 's/## //' | column -t -s ':'
