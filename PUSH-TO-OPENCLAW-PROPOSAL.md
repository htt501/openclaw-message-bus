# Proposal: Message Bus Plugin for OpenClaw
# 提案：OpenClaw 消息总线插件

> **Issue**: https://github.com/openclaw/openclaw/issues/52290  
> **Repository**: https://github.com/htt501/openclaw-message-bus  
> **Version**: 1.2.0  
> **License**: MIT  
> **Author**: htt501

---

## Problem / 问题

OpenClaw's multi-agent systems lack a reliable async communication channel between agents. The current `sessions_send` approach is synchronous and blocking — when the target agent is busy, the sender blocks until timeout. There is no message persistence, no priority routing, no delivery tracking, and no audit trail.

OpenClaw 的多 Agent 系统缺少可靠的异步通信通道。当前的 `sessions_send` 是同步阻塞的 — 目标 agent 忙碌时发送方会阻塞直到超时。没有消息持久化、优先级路由、投递追踪和审计记录。

**Real-world issues observed in production (7 agents, 28 cron jobs):**
- `sessions_send` timeout when target agent is processing another request
- Messages lost when agent crashes mid-processing
- No way to track if a message was received, read, or processed
- Agents sending duplicate messages because they can't verify delivery
- No priority mechanism — urgent P0 tasks wait behind routine P3 notifications

**生产环境实际问题（7 个 agent，28 个 cron 任务）：**
- 目标 agent 处理其他请求时 `sessions_send` 超时
- agent 处理中崩溃导致消息丢失
- 无法追踪消息是否被接收、读取或处理
- agent 因无法确认投递而重复发送消息
- 没有优先级机制 — 紧急 P0 任务排在常规 P3 通知后面

---

## Solution / 解决方案

`openclaw-message-bus` is an OpenClaw plugin that provides a SQLite-backed async message queue with 4 tools:

| Tool | Description |
|------|-------------|
| `bus_send` | Send a message to another agent (async, non-blocking) |
| `bus_read` | Read pending messages (atomic, no duplicate delivery) |
| `bus_ack` | Acknowledge task completion (processing → completed/failed) |
| `bus_status` | Query message status and delivery history |

### Key Design Decisions / 核心设计决策

1. **Auto-ack on read (v1.2)**: Non-task messages (response, notify, discuss) are automatically marked `completed` when read via `bus_read`. Only `task` type requires explicit `bus_ack`. This eliminates the reliability issue of agents forgetting to ack.

   **读取即确认（v1.2）**：非 task 类型消息在 `bus_read` 时自动标记为 `completed`。只有 `task` 类型需要显式 `bus_ack`。从代码层面消除 agent 忘记 ack 的可靠性问题。

2. **Fire-and-forget push notify**: Uses `spawn(detached:true) + unref()` to wake target agents via CLI without blocking the sender. Includes 30s per-agent cooldown to prevent notification storms.

   **Fire-and-forget 推送通知**：使用 `spawn(detached:true) + unref()` 通过 CLI 唤醒目标 agent，不阻塞发送方。包含 30 秒防抖防止通知风暴。

3. **SQLite + WAL**: Single-file database with Write-Ahead Logging for concurrent read/write. `UPDATE...RETURNING` for atomic message delivery (no duplicate reads).

   **SQLite + WAL**：单文件数据库，WAL 模式支持并发读写。`UPDATE...RETURNING` 实现原子消息投递（无重复读取）。

4. **Thread tracking with round limit**: Automatic conversation threading via `ref` field. Configurable round limit (default 10) prevents infinite agent-to-agent loops.

   **话题链追踪 + 轮次限制**：通过 `ref` 字段自动追踪对话线程。可配置轮次上限（默认 10）防止 agent 间无限循环对话。

---

## Architecture / 架构

```
┌─────────┐  bus_send   ┌──────────────┐  bus_read   ┌─────────┐
│ Agent A │ ──────────→ │   SQLite DB  │ ──────────→ │ Agent B │
│ (sender)│             │  (WAL mode)  │             │ (reader)│
└─────────┘             └──────────────┘             └─────────┘
     │                        │                           │
     │  spawn(detached)       │  cron (5min)              │  bus_ack
     └──→ openclaw agent      │  - timeout revert         └──→ completed
          (push notify)       │  - fallback recovery           / failed
                              │  - stale notification
                              │  cron (1h)
                              │  - expiry cleanup
                              │  - metrics logging
```

### Message Lifecycle (v1.2)

```
                    ┌─────────────────────────────────────┐
                    │           bus_read                    │
queued ─────────────┤                                      │
                    │  type=task    → delivered (need ack)  │
                    │  type=other   → completed (auto-ack)  │
                    └─────────────────────────────────────┘
                              │
                    delivered (task only)
                         │         │         │
                    bus_ack    bus_ack    timeout(2h)
                    processing completed   expired
                         │
                    bus_ack
                    completed / failed
```

---

## Test Coverage / 测试覆盖

```
57 tests, 57 pass, 0 fail

Unit tests (38):
  - db operations: insert, read, ack state transitions, thread counting
  - auto-ack: non-task messages auto-complete on read
  - terminal states: ALREADY_COMPLETED, ALREADY_FAILED, MSG_EXPIRED
  - cron: timeout revert, expiry cleanup, stale detection, heartbeat
  - format: result/error formatting
  - id: message ID generation

Integration tests (19):
  - task lifecycle: send → read → ack(processing) → ack(completed)
  - task lifecycle: send → read → ack(failed)
  - auto-ack: response/notify/discuss auto-completed on read
  - mixed read: task stays delivered, response auto-completed
  - error handling: ALREADY_COMPLETED, MSG_NOT_FOUND, INVALID_TRANSITION
  - cron: processing timeout, delivered task expiry, metrics
  - validation: invalid agent, invalid type, invalid priority
  - thread tracking: reply_to creates ref chain
```

---

## Production Stats / 生产数据

Running in production since 2026-03-22 with 7 agents:

| Metric | Value |
|--------|-------|
| Total messages processed | 550+ |
| Agents | 7 (main, ops, creator, intel, strategist, chichi, secretary) |
| Cron jobs using bus | 28 |
| Average delivery time | < 10 seconds |
| Message types | task, response, notify, discuss, escalation, request |
| Database size | < 1MB |
| Uptime | 72+ hours continuous |

---

## Installation / 安装

```bash
cd ~/.openclaw/extensions
git clone https://github.com/htt501/openclaw-message-bus.git
cd openclaw-message-bus && npm install
```

Add to `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "openclaw-message-bus": {
        "enabled": true,
        "config": {
          "agents": ["main", "ops", "creator", "intel", "strategist"],
          "notify": { "enabled": true, "timeoutSeconds": 120 }
        }
      }
    }
  }
}
```

---

## What We're Asking For / 我们的请求

1. **Review and feedback** on the plugin design and API
2. **Consideration for official plugin listing** or documentation mention
3. **Guidance on integration path** — should this be a core feature, official plugin, or community plugin?

We're happy to adapt the code to match OpenClaw's coding standards and plugin conventions.

我们希望：
1. 对插件设计和 API 的审核反馈
2. 考虑纳入官方插件列表或文档提及
3. 集成路径指导 — 应该作为核心功能、官方插件还是社区插件？

我们愿意根据 OpenClaw 的编码规范和插件约定调整代码。
