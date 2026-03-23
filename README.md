# openclaw-message-bus

Agent-to-Agent (A2A) async message bus plugin for [OpenClaw](https://github.com/nicktao/openclaw).

SQLite-backed message queue with priority routing, thread tracking, auto-retry, dead-letter handling, and CLI push notifications.

## Features

- **4 tools**: `bus_send`, `bus_read`, `bus_ack`, `bus_status`
- **SQLite persistence** with WAL mode for concurrent access
- **Priority queuing**: P0 (urgent) → P3 (low)
- **Thread tracking**: automatic conversation threading with configurable round limit (default 10)
- **Atomic read**: `UPDATE...RETURNING` ensures no duplicate delivery under concurrency
- **Auto-retry & dead-letter**: processing timeout → retry up to 3x → dead_letter
- **Cron jobs**: timeout revert (5min), fallback recovery (5min), expiry cleanup (1h), metrics logging (1h)
- **Fallback**: SQLite write failure → `/tmp/bus-fallback/` JSON files → auto-recovered by cron
- **CLI push notification**: fire-and-forget `openclaw agent` call to wake target agent

## Quick Start

### 1. Install

```bash
cd ~/.openclaw/extensions
git clone https://github.com/nicktao/openclaw-message-bus.git
cd openclaw-message-bus
npm install
```

### 2. Register plugin

Add to `~/.openclaw/openclaw.json` under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-message-bus": {
        "enabled": true,
        "config": {
          "agents": ["main", "ops", "creator", "intel", "strategist"],
          "notify": {
            "enabled": true,
            "timeoutSeconds": 120,
            "replyChannel": "feishu",
            "replyTo": "chat:oc_YOUR_GROUP_CHAT_ID"
          }
        }
      }
    },
    "installs": {
      "openclaw-message-bus": {
        "source": "path",
        "installPath": "~/.openclaw/extensions/openclaw-message-bus",
        "version": "1.0.0",
        "spec": "~/.openclaw/extensions/openclaw-message-bus"
      }
    },
    "allow": ["openclaw-message-bus"]
  }
}
```

### 3. Restart gateway

```bash
launchctl stop ai.openclaw.gateway
launchctl start ai.openclaw.gateway
```

### 4. Verify

Check logs for `message-bus initialized`:
```bash
tail -f ~/.openclaw/logs/gateway.err.log
```

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agents` | `string[]` | `[]` | Valid agent IDs. Empty = accept any agent |
| `notify.enabled` | `boolean` | `true` | Enable CLI push notification on send |
| `notify.timeoutSeconds` | `number` | `120` | CLI notification timeout |
| `notify.replyChannel` | `string` | `""` | Channel hint in notification (e.g. `feishu`) |
| `notify.replyTo` | `string` | `""` | Destination hint (e.g. group chat ID) |

## Tools

### bus_send — Send a message

```js
bus_send({
  to: "ops",                    // target agent ID
  content: "Check disk space",  // message body (max 10KB)
  type: "request",              // task | discuss | notify | request | response | escalation
  priority: "P1",               // P0 | P1 | P2 | P3 (default P2)
  ref: "task-123",              // optional: correlation ID
  reply_to: "msg_main_xxx"     // optional: reply to a specific message
})
```

### bus_read — Read pending messages

```js
bus_read({
  from: "main",    // optional: filter by sender
  type: "request", // optional: filter by type
  limit: 10        // optional: max messages (default 10)
})
// Reads messages addressed to the calling agent, sorted by priority then time
// Messages are atomically marked as 'delivered' on read
```

### bus_ack — Acknowledge / transition message status (v1.1)

```js
// Mark as processing (optional intermediate step)
bus_ack({ msg_id: "msg_main_1234_00a1", status: "processing" })

// Mark as completed with result summary
bus_ack({ msg_id: "msg_main_1234_00a1", status: "completed", result: "deployed ok" })

// Mark as failed with reason
bus_ack({ msg_id: "msg_main_1234_00a1", status: "failed", reason: "permission denied" })

// Backward compatible: no status = completed
bus_ack({ msg_id: "msg_main_1234_00a1" })
```

### bus_status — Query message status

```js
bus_status({ msg_id: "msg_main_1234_00a1" })
// Returns full message record including status, timestamps, retry count
```

## Message Lifecycle (v1.1)

```
queued → delivered (on bus_read)
delivered → processing (bus_ack status=processing)
delivered → completed (bus_ack status=completed, skip processing)
delivered → failed (bus_ack status=failed)
processing → completed (bus_ack status=completed)
processing → failed (bus_ack status=failed)
processing → queued (timeout retry, up to 3x)
processing → dead_letter (max retries exceeded)
queued → expired (after 24h)
delivered[task] → expired (after 2h)
dead_letter → expired (after 24h)
completed → deleted (after 7 days)
failed → deleted (after 7 days)
delivered → deleted (after 7 days)
```

## Agent Rules Template

Copy this to each agent's SOUL.md and rules directory (e.g. `~/.openclaw/workspace-{agent}/rules/message-bus.md`):

```markdown
# Message Bus Rules

1. **On activation, always call bus_read first** — check for pending messages
2. **After reading a task message, follow this exact flow:**
   - bus_ack({ msg_id, status: "processing" })
   - Execute the task
   - bus_ack({ msg_id, status: "completed", result: "summary" })
   - bus_send({ to: sender, content: "detailed result", type: "response", reply_to: msg_id })
3. **Step 4 (bus_send reply) is MANDATORY** — the sender reads your reply via bus_read
4. **Use appropriate priority** — P0/P1 for urgent, P2 for normal, P3 for low
5. **Use reply_to when responding** — maintains thread tracking
6. **Thread limit is 10 rounds** — escalate if you hit ROUND_LIMIT
```

## Project Structure

```
openclaw-message-bus/
├── index.js                    # Plugin entry point
├── openclaw.plugin.json        # Plugin manifest & config schema
├── package.json
├── src/
│   ├── schema.js               # TypeBox schemas & constants
│   ├── db.js                   # SQLite layer (better-sqlite3)
│   ├── id.js                   # Message ID generator
│   ├── format.js               # Response formatting
│   ├── fallback.js             # /tmp fallback read/write
│   ├── cron.js                 # Scheduled jobs
│   └── tools/
│       ├── bus_send.js         # Send message tool
│       ├── bus_read.js         # Read messages tool
│       ├── bus_ack.js          # Acknowledge tool
│       └── bus_status.js       # Status query tool
└── tests/
    ├── unit/                   # Unit tests
    ├── integration/            # Integration tests
    └── property/               # Property-based tests
```

## Development

```bash
npm test                    # unit tests
npm run test:integration    # integration tests
npm run test:all            # all tests
```

## Changelog

### v1.1.1 — Notify Message Fix

- CLI notify message now explicitly instructs target agent to `bus_send` reply back to sender
- Previous notify only said "read and process", causing 0% reply rate
- All agent SOUL.md updated with mandatory bus_send reply rule

### v1.1.0 — Extended State Machine

- `bus_ack` now supports `status` param: `processing` / `completed` / `failed`
- New fields: `completed_at`, `failed_at`, `result` (≤2KB), `fail_reason` (≤2KB)
- Delivered task messages auto-expire after 2h
- Completed/failed messages auto-cleaned after 7 days
- Database migration mechanism (`user_version` pragma) for v1.0 → v1.1
- Backward compatible: `bus_ack` without `status` defaults to `completed`
- Terminal state guards: ALREADY_COMPLETED, ALREADY_FAILED, MSG_EXPIRED, MSG_DEAD_LETTER
- Invalid transition detection: INVALID_TRANSITION error code

## License

MIT
