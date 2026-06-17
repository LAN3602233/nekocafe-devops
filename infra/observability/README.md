# NekoCafé 可观测性配置

> 详细配置文件见 D3-6 产出。此处为 IaC 引用入口。

## 文件说明

| 文件 | 用途 |
|------|------|
| `prometheus-alerts.yaml` | Prometheus 告警规则（5 条规则，对齐 D3-1 §6.2） |
| `grafana-dashboard.json` | Grafana Dashboard JSON 模型（D3-6 产出） |
| `loki-config.yaml` | Loki 日志收集配置（结构化 JSON 日志） |
| `tempo-config.yaml` | Tempo 分布式链路追踪配置 |
| `otel-collector-config.yaml` | OpenTelemetry Collector 配置 |

## 可观测性三件套（与 D3-1 §7 对齐）

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Metrics  │    │  Logs    │    │  Traces  │
│Prometheus│    │  Loki    │    │  Tempo   │
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │
     └───────┬───────┴───────┬───────┘
             │   Grafana     │
             │ Alertmanager  │
             └───────────────┘
```

## 关键指标

| 指标 | 来源 | 用途 |
|------|------|------|
| `reservation_qps` | Prometheus | 预约服务请求量 |
| `reservation_p99_latency_ms` | Prometheus | P99 延迟监控 |
| `reservation_error_rate` | Prometheus | 错误率（触发自动回滚） |
| `member_p99_latency_ms` | Prometheus | 会员服务 P99 延迟 |
| `cpu_usage_ratio` | Prometheus | CPU 使用率与限流率 |
| `trace_id` | OpenTelemetry | 分布式链路追踪关联 |
