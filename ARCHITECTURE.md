# OpenClaw A2A Message Bus — 技术架构文档

## 1. 项目背景

OpenClaw 是一个多 Agent 协作系统，多个 AI Agent 通过飞书群聊协作。原有 Agent 间通信使用同步阻塞的 `sessions_send`，存在死锁、消息丢失、无审计记录等问题。

本插件以 OpenClaw Plugin 形式提供基于 SQLite 的异步消息总线，解决上述问题。

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                      │
│                                                         │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ...     │
│  │ main │ │ ops  │ │creator│ │intel │ │strat │          │
│  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘          │
│     │        │        │        │        │               │
│     ▼        ▼        ▼        ▼        ▼               │
│  ┌──────────────────────────────────────────────┐       │
│  │         openclaw-message-bus plugin            │       │
│  │                                                │       │
│  │  bus_send  bus_read  bus_ack  bus_status       │       │
│  │      │        │        │        │              │       │
│  │      ▼        ▼        ▼        ▼              │       │
│  │  ┌─────────────────────────────────────┐      │       │
│  │  │     SQLite (WAL) message-bus.sqlite  │      │       │
│  │  └─────────────────────────────────────┘      │       │
│  │      │                                         │       │
│  │      ├─→ CLI Notify (fire & forget)            │       │
│  │      │   openclaw agent --agent <to> --message │       │
│  │      │                                         │       │
│  │      └─→ Cron Jobs (setInterval)               │       │
│  │          ├ 5min: revert timeout + recover fb   │       │
│  │          └ 1hr:  clean expired + log metrics   │       │
│  └────────────────────────────────────────────────┘       │
│                                                         │
│  /tmp/bus-fallback/  ← SQLite 写入失败时的降级存储       │
└─────────────────────────────────────────────────────────┘
```

## 3. 核心设计决策

### 3.1 异步非阻塞通信

bus_send 写入 SQLite 后立即返回，CLI 推送异步执行（fire-and-forget）。解决了原 sessions_send 的同步阻塞和死锁问题。

### 3.2 推送机制选型

| 方案 | 结果 |
|------|------|
| runtime.subagent.run | ❌ sessionKey 无法路由到飞书群上下文 |
| --session-key CLI 选项 | ❌ OpenClaw 2026.3.13 不支持 |
| --deliver --reply-channel feishu | ❌ 内置 LarkClient 缺少 appId/appSecret |
| **openclaw agent --agent CLI** | ✅ 通知 Agent 后由 Agent 自行通过 message tool 回复飞书群 |

最终采用 `child_process.exec` 调用 `openclaw agent --agent <to> --message "..."` 方式。

### 3.2.1 Notify 消息内容（v1.1.1 修复）

v1.0 的 notify 消息仅告知 agent "read and process"，导致 agent 只执行 bus_read + bus_ack 就结束，不会用 bus_send 回复发送者（0% 回复率）。

v1.1.1 修改 notify 消息为明确的 4 步指令：bus_read → process → bus_ack(completed) → bus_send(response, reply_to)，并标注 "Step 4 is MANDATORY"。修复后回复率恢复正常。

教训：LLM Agent 的行为完全由指令驱动，notify 消息就是 agent 的"任务指令"，必须明确列出所有期望步骤。

### 3.3 并发安全

使用 SQLite `UPDATE...RETURNING` 原子操作，在一条 SQL 中完成消息选取和状态标记，保证多 Agent 并发读取时每条消息仅被一个 Agent 获取。

### 3.4 话题链追踪

通过 ref 字段自动串联相关消息，形成话题链。设置 MAX_THREAD_ROUNDS=10 防止 Agent 间无限循环对话。

### 3.5 bus_read 直接标记 delivered

初始设计为 queued → processing → delivered（需要 bus_ack），实际简化为 queued → delivered（bus_read 直接标记）。bus_ack 保留为幂等兼容接口。减少了 Agent 的调用步骤。

### 3.6 配置化

Agent 列表和通知参数从硬编码改为 config 驱动，通过 openclaw.json 的 `plugins.entries.openclaw-message-bus.config` 配置。

## 4. 分层架构

```
index.js              → 插件入口，register(api) 读取 config，注册工具和 cron
src/schema.js         → TypeBox Schema + 动态 Agent 列表（setAgents/getAgents）
src/db.js             → SQLite 操作层（prepared statements，所有读写封装）
src/tools/bus_send.js → 发送消息 + 话题链追踪 + CLI 推送
src/tools/bus_read.js → 原子读取（UPDATE...RETURNING 直接标记 delivered）
src/tools/bus_ack.js  → 确认消息（幂等，兼容接口）
src/tools/bus_status.js → 查询消息状态（只读）
src/cron.js           → 4 个定时任务
src/fallback.js       → 降级文件读写
src/id.js             → msg_id 生成（递增计数器 + 随机起点）
src/format.js         → 统一返回值格式化
```

## 5. 数据模型

### messages 表

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| msg_id | TEXT | PRIMARY KEY | `msg_{agent}_{ts}_{hex4}` |
| from_agent | TEXT | NOT NULL | 发送者 |
| to_agent | TEXT | NOT NULL | 接收者 |
| type | TEXT | DEFAULT 'notify' | task/discuss/notify/request/response/escalation |
| priority | TEXT | DEFAULT 'P2' | P0/P1/P2/P3 |
| content | TEXT | NOT NULL | 消息内容（≤10KB） |
| ref | TEXT | | 话题链标识 |
| reply_to | TEXT | | 回复的 msg_id |
| status | TEXT | DEFAULT 'queued' | queued/processing/delivered/completed/failed/dead_letter/expired |
| retry_count | INTEGER | DEFAULT 0 | 重试次数 |
| max_retries | INTEGER | DEFAULT 3 | 最大重试次数 |
| last_error | TEXT | | 最后错误信息 |
| created_at | TEXT | NOT NULL | ISO 8601 |
| processing_at | TEXT | | 开始处理时间 |
| delivered_at | TEXT | | 投递确认时间 |
| expired_at | TEXT | | 过期时间 |
| completed_at | TEXT | | v1.1: 完成时间 |
| failed_at | TEXT | | v1.1: 失败时间 |
| result | TEXT | | v1.1: 完成结果摘要（≤2KB） |
| fail_reason | TEXT | | v1.1: 失败原因（≤2KB） |

### 索引

| 索引名 | 字段 | 用途 |
|--------|------|------|
| idx_to_status | (to_agent, status) | bus_read 核心查询 |
| idx_type | (type) | 按类型筛选 |
| idx_created | (created_at) | 过期清理 |

## 6. 消息生命周期 (v1.1)

```
queued → delivered (bus_read 直接标记)
delivered → processing (bus_ack status=processing)
delivered → completed (bus_ack status=completed, 可跳过 processing)
delivered → failed (bus_ack status=failed)
processing → completed (bus_ack status=completed)
processing → failed (bus_ack status=failed)
processing → queued (超时重试, 最多 3 次)
processing → dead_letter (重试耗尽)
queued → expired (24h 未读)
delivered[task] → expired (2h 未处理)
dead_letter → expired (24h 后)
completed → deleted (7 天后清理)
failed → deleted (7 天后清理)
delivered → deleted (7 天后清理)
```

### 终态保护

| 当前状态 | 尝试操作 | 返回错误码 |
|----------|----------|------------|
| completed | 任何 ack | ALREADY_COMPLETED |
| failed | 任何 ack | ALREADY_FAILED |
| expired | 任何 ack | MSG_EXPIRED |
| dead_letter | 任何 ack | MSG_DEAD_LETTER |
| queued | ack(processing) | INVALID_TRANSITION |

## 7. 降级策略

```
bus_send
  ├─ SQLite 写入成功 → { status: 'queued' }
  └─ SQLite 写入失败
       ├─ /tmp/bus-fallback/ 写入成功 → { status: 'queued_fallback' }
       │    └─ cron 每 5 分钟回补
       └─ 降级也失败 → FALLBACK_FAILED 错误
```

## 8. 定时任务

| 周期 | 任务 | 说明 |
|------|------|------|
| 5 min | revertTimedOut | processing 超时 10min → queued（retry<3）或 dead_letter |
| 5 min | recoverFallback | /tmp/bus-fallback/ → SQLite 回补 |
| 1 hour | cleanExpired | delivered/completed/failed 7天删除；queued/dead_letter 24h → expired；delivered task 2h → expired |
| 1 hour | logMetrics | 输出统计（含 completed/failed 计数）+ 数据库大小告警（>50MB） |

## 9. 错误码

| 错误码 | 触发条件 |
|--------|----------|
| INVALID_PARAM | to/type/priority 不合法，content 超 10KB |
| FALLBACK_FAILED | SQLite 和文件系统同时失败 |
| MSG_NOT_FOUND | msg_id 不存在 |
| ALREADY_COMPLETED | 对已 completed 的消息重复 ack |
| ALREADY_FAILED | 对已 failed 的消息重复 ack |
| MSG_EXPIRED | 对已 expired 的消息 ack |
| MSG_DEAD_LETTER | 对 dead_letter 消息 ack |
| INVALID_STATUS | 未知的目标状态 |
| INVALID_TRANSITION | 非法状态转换（如 queued → processing） |
| ROUND_LIMIT | 话题链超过 10 轮 |

## 10. 技术栈

| 包 | 版本 | 用途 |
|----|------|------|
| better-sqlite3 | ^11.0.0 | SQLite 同步驱动（WAL 模式） |
| @sinclair/typebox | ^0.34.0 | JSON Schema 定义 |
| fast-check | ^3.0.0 | Property-based testing (dev) |

## 11. 测试覆盖

- 34 个单元测试：db operations v1.1、format、id
- 11 个集成测试：完整生命周期 + cron 任务 + 错误处理
- 测试使用内存 SQLite (`:memory:`) + mock logger/runtime
- bus_send 测试中 notify.enabled=false 避免真实 CLI 调用
- 实际飞书群测试验证：agent 间 task 分发 + bus_send 回复闭环

## 12. 需求变更记录

| 变更项 | 初始设计 | 实际实现 | 原因 |
|--------|----------|----------|------|
| Agent 数量 | 5 个 | 7 个 + 配置化 | 业务扩展 |
| 消息类型 | 3 种 | 6 种 | 更精细的语义区分 |
| 优先级 | 3 级 | 4 级（+P3） | 需要低优先级标记 |
| 推送机制 | runtime.subagent.run | CLI exec | sessionKey 路由问题 |
| bus_read 状态 | queued → processing | queued → delivered | 简化流程 |
| 话题链追踪 | 无 | ref + 10 轮限制 | 防循环 |
| Agent 列表 | 硬编码 | config 驱动 | 多环境部署 |
| 通知配置 | 硬编码 | config 驱动 | 同上 |

## 13. v1.1 变更摘要

| 变更项 | v1.0 | v1.1 |
|--------|------|------|
| bus_ack | 幂等确认（delivered→delivered） | 状态机转换（processing/completed/failed） |
| 新字段 | — | completed_at, failed_at, result, fail_reason |
| bus_read | 设置 processing_at | 仅设置 delivered_at |
| delivered task 超时 | 无 | 2h 自动 expired |
| completed/failed 清理 | 无 | 7 天自动删除 |
| 数据库迁移 | 无 | user_version pragma 机制 |
| result/reason 截断 | 无 | ≤2KB 自动截断 |
| 终态保护 | 无 | ALREADY_COMPLETED/ALREADY_FAILED/MSG_EXPIRED/MSG_DEAD_LETTER |
| 向后兼容 | — | bus_ack 不传 status 默认 completed |
| notify 消息 | "read and process" | 明确 4 步指令含强制 bus_send 回复 |
