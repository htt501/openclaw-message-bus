# openclaw-message-bus Examples

This directory contains practical examples demonstrating how to use the message bus plugin in various scenarios.

## Examples

### 1. [basic-communication.js](./basic-communication.js)
**What it demonstrates:**
- Sending and receiving messages between agents
- Using `bus_send`, `bus_read`, and `bus_ack`
- Basic request-response pattern

**Use case:** Simple agent-to-agent task delegation

---

### 2. [priority-routing.js](./priority-routing.js)
**What it demonstrates:**
- Using priority levels (P0-P3)
- How messages are delivered in priority order
- When to use each priority level

**Use case:** Ensuring urgent messages (P0) are handled before routine tasks (P2/P3)

---

### 3. [thread-tracking.js](./thread-tracking.js)
**What it demonstrates:**
- Maintaining conversation context with `reply_to`
- Multi-round conversations
- Thread limit (10 rounds) and how to handle it

**Use case:** Long-running conversations between agents (e.g., debugging, iterative tasks)

---

### 4. [error-handling.js](./error-handling.js)
**What it demonstrates:**
- Automatic retry on failure
- Dead-letter handling (max retries exceeded)
- SQLite write failure and fallback mechanism
- Message expiry (24-hour TTL)
- Idempotent acknowledgment

**Use case:** Building resilient agent workflows that handle failures gracefully

---

## Quick Start

### Run an example

```bash
# 1. Ensure the plugin is installed and OpenClaw gateway is running
openclaw status

# 2. Run an example in an agent session
openclaw agent --agent=main --message="Run examples/basic-communication.js"

# Or use the OpenClaw REPL
openclaw repl --agent=main
> // Paste code from examples/basic-communication.js
```

### Adapt for your use case

1. Copy an example to your agent's workspace
2. Modify agent IDs and message content
3. Add your business logic between `bus_read` and `bus_ack`

---

## Common Patterns

### Pattern 1: Task Delegation

```javascript
// Manager agent
await bus_send({
  to: "worker",
  content: "Process batch #123",
  type: "task",
  ref: "batch-123"
});

// Worker agent
const messages = await bus_read();
// ... process batch ...
await bus_ack({ msg_id: messages.messages[0].msg_id });
await bus_send({
  to: "manager",
  content: "Batch #123 complete",
  type: "response",
  reply_to: messages.messages[0].msg_id
});
```

---

### Pattern 2: Broadcasting

```javascript
// Send to multiple agents
for (const agent of ["ops", "intel", "creator"]) {
  await bus_send({
    to: agent,
    content: "System maintenance in 10 minutes",
    type: "notify",
    priority: "P1"
  });
}
```

---

### Pattern 3: Escalation

```javascript
// Start with normal priority
await bus_send({
  to: "ops",
  content: "Disk usage high",
  priority: "P2",
  ref: "disk-001"
});

// If no response within 5 minutes, escalate
await bus_send({
  to: "ops",
  content: "Disk usage CRITICAL - no response to alert",
  priority: "P0",
  type: "escalation",
  ref: "disk-001",
  reply_to: "msg_strategist_xxx_001"
});
```

---

## Testing

### Unit test your message handling

```javascript
// test/message-handler.test.js
import { test } from 'node:test';
import assert from 'node:assert';

test('should process message and ack', async () => {
  const messages = await bus_read({ limit: 1 });
  assert.equal(messages.messages.length, 1);
  
  const msg = messages.messages[0];
  // ... process message ...
  
  const result = await bus_ack({ msg_id: msg.msg_id });
  assert.equal(result.status, 'SUCCESS');
});
```

---

## Troubleshooting

### Message not delivered?

```javascript
// Check message status
const status = await bus_status({
  msg_id: "msg_xxx"
});
console.log("Status:", status.status);
console.log("Retry count:", status.retry_count);
console.log("Last error:", status.last_error);
```

### Too many messages in queue?

```javascript
// Read in batches
while (true) {
  const messages = await bus_read({ limit: 50 });
  if (messages.messages.length === 0) break;
  
  for (const msg of messages.messages) {
    // ... process ...
    await bus_ack({ msg_id: msg.msg_id });
  }
}
```

### Need to filter messages?

```javascript
// Filter by sender
const messages = await bus_read({
  from: "main",
  limit: 10
});

// Filter by type
const messages = await bus_read({
  type: "escalation",
  limit: 10
});
```

---

## Next Steps

1. Read the [main README](../README.md) for installation and configuration
2. Check [ARCHITECTURE.md](../ARCHITECTURE.md) for design details
3. Review [tests/](../tests/) for more examples
4. Join the OpenClaw Discord for support: https://discord.com/invite/clawd

---

## Contributing

Have a useful pattern or example? Please open a PR!

Examples should:
- Be self-contained
- Include comments explaining each step
- Follow the existing format
- Demonstrate a specific use case

---

**License:** MIT
