# NekoCafé 故障处理手册（Runbook）

> **目标：** 在 3 分钟内定位故障，在 10 分钟内完成处置（符合 D3-1 §1.1 硬性要求）

---

## 一、常用快速命令

```bash
# 查看所有服务 Pod 状态
kubectl get pods -n prod

# 查看某 Pod 实时日志
kubectl logs -f <pod-name> -n prod

# 查看服务 Deployment 状态
kubectl get deploy -n prod

# 立即回滚（详见 rollback.md）
helm rollback nekocafe-reservation -n prod
```

---

## 二、服务异常告警处理流程

```
告警触发（Grafana / Alertmanager）
       ↓
1. 查看 Grafana 仪表盘确认指标
       ↓
2. 在 Loki 检索最近 5min ERROR 日志
       ↓
3. 在 Tempo 找出涉事 traceId，定位慢调用链路
       ↓
4. 判断根因 → 选择对应处置方案（见下方各场景）
```

---

## 三、告警场景与处置

### 场景 A：预约服务 HTTP 5xx 错误率 > 1%

**告警名：** `ReservationHighErrorRate`
**阈值：** 5xx 错误率 > 1%，持续 1 分钟（符合 D3-1 §6.2）
**处置步骤：**

```bash
# 1. 查看 Grafana - reservation_error_rate 面板（最近 15 分钟）
#    如果错误集中在 POST /api/reserve → 可能是 DB 写入问题
#    如果错误集中在 GET /api/tables/available → 可能是 Redis 或 DB 读问题

# 2. 在 Loki 检索错误日志（过去 5 分钟）
#    {service="reservation"} |= "ERROR" | logfmt | line_format "{{.message}}"

# 3. 检查 PostgreSQL 连接池状态
kubectl exec -n prod deploy/nekocafe-reservation -- \
  python3 -c "import asyncio, asyncpg; asyncio.run(asyncpg.connect('$DATABASE_URL'))" 2>&1

# 4. 检查 Redis 连通性
kubectl exec -n prod deploy/nekocafe-reservation -- \
  python3 -c "import redis; r=redis.Redis.from_url('$REDIS_URL'); print(r.ping())"

# 5. 若确认是代码问题 → 立即回滚（见 rollback.md）
helm rollback nekocafe-reservation -n prod
```

**预期恢复时间：** < 3 分钟（回滚 + 健康检查）

---

### 场景 B：预约接口 P95 延迟 > 300ms

**告警名：** `ReservationHighLatency`
**阈值：** `/api/reserve` P95 延迟 > 300ms，持续 2 分钟（符合 D3-1 §6.2）
**处置步骤：**

```bash
# 1. Grafana - reservation_request_latency_seconds P95 面板
#    关注 /api/tables/available 和 /api/reserve 两个端点

# 2. 检查 Redis 缓存命中率
#    Grafana 指标：cache_hit_rate = cache_hit / (cache_hit + cache_miss)
#    如果命中率突降 → 检查 Redis 内存使用量（maxmemory-policy: allkeys-lru）

# 3. 检查数据库慢查询
kubectl exec -n prod svc/postgres -- psql -U nekocafe -d reservation_db -c "
  SELECT query, calls, mean_exec_time, total_exec_time
  FROM pg_stat_statements
  ORDER BY mean_exec_time DESC
  LIMIT 10;
"

# 4. 检查 Pod CPU/内存使用情况
kubectl top pods -n prod -l app=nekocafe-reservation

# 5. 如果 CPU 使用率高 → 手动扩容
kubectl scale deploy nekocafe-reservation --replicas=4 -n prod

# 6. 如果确认是代码问题（如 N+1 查询）→ 回滚后在 staging 修复
helm rollback nekocafe-reservation -n prod
```

---

### 场景 C：CPU 限流率 > 20%（ThrottlingHigh）

**告警名：** `ReservationCpuThrottling`
**阈值：** CPU 限流率 > 20%，持续 3 分钟（符合 D3-1 §6.2）
**处置步骤：**

```bash
# 1. 查看当前资源配置
kubectl get deploy nekocafe-reservation -n prod -o jsonpath='{.spec.template.spec.containers[0].resources}'

# 2. 查看 HPA 状态
kubectl get hpa -n prod

# 3. 临时调整副本数（HPA 未能及时扩容时）
kubectl scale deploy nekocafe-reservation --replicas=6 -n prod

# 4. 更新资源限制（在 Helm values 中修改后重新发布）
# 修改 helm/values-prod.yaml 中的 resources.limits.cpu
# 然后：helm upgrade nekocafe-reservation ./helm -n prod -f ./helm/values-prod.yaml
```

---

### 场景 D：Kafka 消息积压（ConsumerLag 过高）

**告警名：** `KafkaConsumerLagHigh`
**阈值：** `reservation.confirmed` topic consumer lag > 1000，持续 5 分钟
**处置步骤：**

```bash
# 1. 查看消费者组 lag
kubectl exec -n prod svc/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --describe --group member-service-group

# 2. 检查 member 服务 Pod 是否正常
kubectl get pods -n prod -l app=nekocafe-member

# 3. 检查 member 服务日志中的消费错误
kubectl logs -n prod deploy/nekocafe-member --since=10m | grep ERROR

# 4. 扩容 member 服务（增加消费者数量）
kubectl scale deploy nekocafe-member --replicas=3 -n prod

# 5. 若积压严重且需要跳过历史消息（谨慎操作！）
kubectl exec -n prod svc/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group member-service-group \
    --reset-offsets --to-latest \
    --topic reservation.confirmed \
    --execute
```

---

### 场景 E：数据库连接池耗尽

**症状：** 日志出现 `too many clients` 或 `connection pool timeout`

```bash
# 1. 查看当前连接数
kubectl exec -n prod svc/postgres -- \
  psql -U nekocafe -c "
    SELECT datname, count(*) as connections
    FROM pg_stat_activity
    GROUP BY datname
    ORDER BY connections DESC;
  "

# 2. 终止空闲连接（谨慎操作）
kubectl exec -n prod svc/postgres -- \
  psql -U nekocafe -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE state = 'idle'
      AND state_change < NOW() - INTERVAL '10 minutes'
      AND datname = 'reservation_db';
  "

# 3. 临时降低服务副本数以减少连接数
kubectl scale deploy nekocafe-reservation --replicas=1 -n prod

# 4. 长期方案：引入 PgBouncer 连接池（在 Helm Chart 中配置）
```

---

## 四、可观测性快速入口

| 工具 | 地址 | 用途 |
|------|------|------|
| Grafana | https://grafana.nekocafe.internal | 指标仪表盘 |
| Prometheus | https://prometheus.nekocafe.internal | 原始指标查询 |
| Loki | Grafana > Explore > Loki | 日志检索 |
| Tempo | Grafana > Explore > Tempo | 链路追踪 |
| Alertmanager | https://alertmanager.nekocafe.internal | 告警管理 |

**关键 Grafana 面板：**
- `reservation_qps` — 预约服务请求量
- `reservation_request_latency_seconds` — 请求延迟分布（P50/P95/P99）
- `reservation_error_rate` — 错误率
- `member_p99_latency_ms` — 会员服务 P99 延迟
- `cpu_usage_ratio` — CPU 使用率与限流率

**Loki 查询示例：**
```logql
# 最近 5 分钟 reservation 服务 ERROR 日志
{service="reservation"} |= "ERROR" | logfmt

# 按 trace_id 检索（从 Tempo 拿到 trace_id 后）
{service="reservation"} | logfmt | trace_id="<your-trace-id>"
```

---

## 五、紧急联系

| 角色 | 联系方式 | 负责范围 |
|------|----------|----------|
| On-call 工程师 | 钉钉告警群 | 第一响应人，负责初步判断 |
| 数据库管理员 | 内部工单系统 | PostgreSQL 生产数据库操作 |
| Kafka 运维 | 内部工单系统 | Kafka 集群配置变更 |
