# openclaw-message-bus v3.0.0 Release Notes

## 发布日期：2026-03-27

## 概述

v3.0.0 是一次重大升级，解决了 v1.x 在生产环境中暴露的三个关键问题：垃圾 session 泛滥（1309+）、确认循环浪费线程轮次（29.4% 消息过期率）、缺少广播支持。同时完全向后兼容 v1.x API。

## 新功能

### 1. 广播支持（Broadcast）
- `bus_send` 的 `to` 参数现在接受字符串数组，一次发送给多个 agent
- 所有广播消息共享同一个 `ref`（线程分组）
- 自动去重目标列表
- 返回格式：`{ messages: [...], ref, broadcast: true }`

### 2. 智能线程计数（Smart Thread Counting）
- 只有可操作类型（task/request/discuss/escalation）计入 MAX_THREAD_ROUNDS
- response 和 notify 类型不再消耗轮次预算
- 解决了确认循环（"收到"/"好的"）导致线程过早阻塞的问题

### 3. 会话感知推送通知（Session-Aware Push Notify）
- 新增 Session Resolver 组件，读取 `~/.openclaw/agents/{agentId}/sessions/sessions.json`
- 推送通知使用 `--session-id` 注入现有飞书群 session，不再用 `--agent` 创建孤立 session
- 无 session 时跳过通知（不创建垃圾 session）
- 支持 `{agentId}` 模板变量的 preferredSessionKey 配置

### 4. 推送通知模块提取
- 从 bus_send 提取为独立 `src/notify.js` 模块
- 每 agent 30 秒冷却防止通知风暴
- 永不抛异常，所有错误优雅处理

## 配置变更

新增两个 notify 配置字段：
```json
{
  "notify": {
    "sessionAware": true,
    "preferredSessionKey": "agent:{agentId}:feishu:group:oc_YOUR_GROUP_ID"
  }
}
```

## 测试覆盖

- 79 个单元测试
- 24 个集成测试（含 v3 新增：thread counting lifecycle、broadcast lifecycle、session-aware notify）
- 7 个 property-based 测试（fast-check）
- 总计 110 个测试，0 失败

## 向后兼容

- 单字符串 `to` 参数行为与 v1.x 完全一致
- 所有 v1.x 集成测试零修改通过
- 无数据库 schema 变更

## 文件变更

- 新增：`src/notify.js`、`src/session-resolver.js`
- 新增：9 个测试文件（unit + property + integration）
- 修改：`index.js`、`src/tools/bus_send.js`、`src/schema.js`、`src/db.js`
- 修改：`openclaw.plugin.json`（v3.0.0 + 新配置字段）
- 修改：`README.md`、`ARCHITECTURE.md`（v3 文档）

---

## ⚠️ 已知问题：openclaw 框架 agent 进程泄漏

### 问题描述

openclaw 框架为每个 agent 创建独立的 cron worker 进程（`openclaw-cron`），每个进程占用约 450MB 内存。7 个 agent = 7 个 cron 进程 = 3.1GB 内存。加上 gateway（660MB）和其他进程，总计 4.5GB，在 16GB Mac mini 上容易导致内存耗尽和 kernel panic。

此外，v1.x 的 push notify 使用 `--agent` 方式 spawn 进程，每次都在 `~/.openclaw/agents/` 下创建新的 agent 目录。property-based testing 和生产运行累积产生了 209 个垃圾 agent 目录。

### 影响

- 内存耗尽导致 macOS kernel panic（WindowServer watchdog timeout）
- `~/.openclaw/agents/` 目录污染
- 系统不稳定

### 建议修复（openclaw 框架层面）

1. **合并 cron worker**：将 7 个独立的 `openclaw-cron` 进程合并为 1 个共享进程，或在 gateway 进程内用 setInterval 执行
2. **agent 目录清理 cron**：定期扫描 `~/.openclaw/agents/`，删除不在配置列表中的垃圾 agent 目录
3. **push notify 进程限制**：限制同时 spawn 的 notify 进程数量，防止内存累积

### 临时缓解措施（已实施）

- 手动清理了 209 个垃圾 agent 目录
- 手动 kill 了 7 个 openclaw-cron 进程
- message-bus 插件的 cron 改为 in-process setInterval（不 fork 子进程）
- 删除了 openclaw 的 4 个 LaunchAgent 自启动服务和 3 个 crontab 定时任务
