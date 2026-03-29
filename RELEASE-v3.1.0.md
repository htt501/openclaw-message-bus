# Release v3.1.0 — Auto-Deliver Push Notify

**发布日期**: 2026-03-29

## 核心变化

bus_send 发送消息后，插件层自动通过 CLI `openclaw agent --deliver` 唤醒目标 agent 并投递到飞书群。不再依赖 agent 自觉调 sessions_send。

## 改动范围

### src/notify.js
- 新增 `broadcastNotify()` 函数：通过 `openclaw agent --agent <id> --deliver --reply-channel feishu --reply-to <chatId>` 唤醒目标
- 唤醒消息包含原始消息内容摘要（截断 500 字）和 4 步执行指令
- 明确禁止 NO_REPLY，要求 agent 必须在群里回复
- 独立 cooldown 命名空间（`broadcast:<agent>`），30 秒防重复

### src/tools/bus_send.js
- 广播路径：从 `pushNotify` 改为 `broadcastNotify`，所有类型都唤醒
- 单播路径：同样改为 `broadcastNotify`，不再区分 type
- 传入 `content` 和 `type` 参数给 broadcastNotify

### index.js
- 修复 `api.config` 读取问题：gateway 传入的是完整 openclaw.json，需要从 `plugins.entries["openclaw-message-bus"].config` 提取插件配置
- 之前 `notify.replyTo` 和 `notify.replyChannel` 一直为空，导致 broadcastNotify 跳过

### docs/message-bus-rules-v3.md
- 新增广播唤醒规则：广播消息无论什么 type 都必须 sessions_send 唤醒
- 单播 response/notify 不唤醒的规则改为仅限单播场景

### scripts/setup-agent-rules.sh
- BOOTSTRAP_RULE 模板新增"📢 广播必须唤醒"章节

## 防风暴机制

- 30 秒 per-agent cooldown
- MAX_THREAD_ROUNDS = 4 轮次限制
- 两层保护足够防止乒乓风暴

## 测试结果

- 79 个单元测试全部通过
- 实际广播测试：4/4 agent 唤醒成功，3/4 completed + 1 回复
