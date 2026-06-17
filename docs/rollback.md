# NekoCafé 回滚操作指南

> **目标：** 任意服务在 3 分钟内完成回滚（符合 D3-1 §1.1 恢复时间要求）

---

## 一、一键回滚命令（最常用）

```bash
# 回滚 reservation 服务到上一个稳定版本
helm rollback nekocafe-reservation -n prod

# 回滚 member 服务
helm rollback nekocafe-member -n prod
```

执行后 Helm 会自动将 Deployment 切换回上一个 revision，Kubernetes 会滚动更新 Pod。

---

## 二、查看可回滚的历史版本

```bash
# 查看 reservation 服务的发布历史
helm history nekocafe-reservation -n prod

# 示例输出：
# REVISION  UPDATED                   STATUS     CHART         APP VERSION  DESCRIPTION
# 1         2026-06-01 10:00:00 CST   superseded nekocafe-0.1.0 v1.0.0      Install complete
# 2         2026-06-02 09:30:00 CST   deployed   nekocafe-0.1.0 v1.1.0      Upgrade complete
```

---

## 三、回滚到指定版本

```bash
# 回滚到指定 revision（如回滚到 revision 1）
helm rollback nekocafe-reservation 1 -n prod

# 带等待确认（等待 Pod 就绪后返回）
helm rollback nekocafe-reservation 1 -n prod --wait --timeout 5m
```

---

## 四、金丝雀发布中止 & 回滚

若金丝雀发布（5% 流量）出现问题，需立即中止：

```bash
# 1. 删除金丝雀 release（流量立即切回 stable）
helm uninstall nekocafe-reservation-canary -n prod

# 2. 确认 stable 服务健康
kubectl get pods -n prod -l app=nekocafe-reservation

# 3. 验证健康端点
curl -sf https://nekocafe.example.com/api/reservation/healthz
```

---

## 五、kubectl 原生回滚（备用方案）

当 Helm 不可用时，可使用 kubectl 直接回滚 Deployment：

```bash
# 查看 Deployment 发布历史
kubectl rollout history deploy/nekocafe-reservation -n prod

# 回滚到上一个版本
kubectl rollout undo deploy/nekocafe-reservation -n prod

# 回滚到指定版本（--to-revision=<n>）
kubectl rollout undo deploy/nekocafe-reservation -n prod --to-revision=2

# 查看回滚进度
kubectl rollout status deploy/nekocafe-reservation -n prod
```

---

## 六、数据库迁移回滚

若本次发布包含数据库 Schema 变更（Flyway），需额外处理：

```bash
# 1. 查看当前 migration 版本
kubectl exec -n prod deploy/nekocafe-reservation -- \
  flyway -url=$DATABASE_URL info

# 2. 回退到上一个 migration（需确保迁移脚本为可逆操作）
kubectl exec -n prod deploy/nekocafe-reservation -- \
  flyway -url=$DATABASE_URL -target=<previous-version> migrate

# ⚠️ 注意：
# - 所有 DDL 语句必须向后兼容（D3-1 §9 要求）
# - 禁止在 migration 中执行不可逆的 DROP TABLE / DROP COLUMN
# - 如有破坏性 Schema 变更，需提前与 DBA 确认回滚方案
```

---

## 七、回滚验证清单

回滚完成后，依次执行以下验证：

```bash
# 1. 检查 Pod 状态（所有 Pod 应为 Running/Ready）
kubectl get pods -n prod -l 'app in (nekocafe-reservation,nekocafe-member)'

# 2. 检查健康端点
curl -sf https://nekocafe.example.com/api/reservation/healthz | python3 -m json.tool
curl -sf https://nekocafe.example.com/api/member/healthz     | python3 -m json.tool

# 3. 在 Grafana 确认错误率恢复到基线（< 0.1%）
#    面板：reservation_error_rate（观察 2 分钟趋势）

# 4. 确认 Kafka 消费者 lag 无异常增长
kubectl exec -n prod svc/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --describe --group member-service-group

# 5. 通知团队回滚完成，在事故记录中填写根因分析
```

---

## 八、本地开发环境回滚（docker compose）

```bash
# 回退到指定镜像标签（修改 docker-compose.yml 中的 image tag 后）
docker compose up -d --no-build

# 或者直接回滚到之前的构建缓存
docker compose down -v
git checkout <previous-commit>
make up
```

---

## 九、回滚决策树

```
服务异常告警触发
        ↓
检查是否为本次发布引入（对比发布时间与告警时间）
        ↓
    是 → 立即执行 helm rollback
        ↓
    否 → 检查基础设施（DB/Redis/Kafka）
        ↓
     若基础设施异常 → 执行对应基础设施应急预案
        ↓
     若基础设施正常 → 分析日志/链路，提 Hotfix PR
```

---

## 十、相关文档

- [故障处理手册 (Runbook)](runbook.md)
- [D3-1 §6.2 自动回滚阈值配置](../../D3-1_DevOps设计方案_模板.docx)
- [Helm Chart values](../../D3-5_K8s部署清单与Helm_Chart/helm/)
