/**
 * Thread Tracking Example
 * 
 * This example shows how to maintain conversation context across
 * multiple message exchanges using reply_to and ref fields.
 */

// ============================================================================
// Scenario: Multi-round conversation between main and ops
// ============================================================================

// --- Round 1: main asks ops to check disk space ---

const round1 = await bus_send({
  to: "ops",
  content: "Check disk space on all servers",
  type: "request",
  priority: "P1",
  ref: "disk-check-2026-03-22"
});

console.log("Round 1 sent:", round1);
// Output:
// {
//   "msg_id": "msg_main_1234567890_00a1",
//   "status": "queued",
//   "ref": "msg_main_1234567890_00a1",
//   "round": 1  // First message in thread
// }

// --- ops reads and responds ---

const messages = await bus_read({ limit: 10 });
const msg1 = messages.messages[0];

// ops checks disk space...

const round2 = await bus_send({
  to: "main",
  content: "Server A: 45%, Server B: 78%, Server C: 92%",
  type: "response",
  priority: "P1",
  ref: "disk-check-2026-03-22",
  reply_to: msg1.msg_id  // Link to previous message
});

await bus_ack({ msg_id: msg1.msg_id });

console.log("Round 2 sent:", round2);
// Output:
// {
//   "msg_id": "msg_ops_1234567891_00a2",
//   "status": "queued",
//   "ref": "msg_ops_1234567891_00a2",
//   "round": 2  // Second message in thread
// }

// --- Round 3: main asks ops to clean Server C ---

const messages2 = await bus_read({ limit: 10 });
const msg2 = messages2.messages[0];

const round3 = await bus_send({
  to: "ops",
  content: "Server C is critical. Clean up old logs",
  type: "task",
  priority: "P0",  // Escalate to urgent
  ref: "disk-check-2026-03-22",
  reply_to: msg2.msg_id  // Continue the thread
});

await bus_ack({ msg_id: msg2.msg_id });

console.log("Round 3 sent:", round3);
// Output:
// {
//   "msg_id": "msg_main_1234567892_00a3",
//   "status": "queued",
//   "ref": "msg_main_1234567892_00a3",
//   "round": 3  // Third message in thread
// }

// --- ops completes the task ---

const messages3 = await bus_read({ limit: 10 });
const msg3 = messages3.messages[0];

// ops cleans up Server C...

const round4 = await bus_send({
  to: "main",
  content: "Server C cleaned. Usage now 68%",
  type: "response",
  priority: "P1",
  ref: "disk-check-2026-03-22",
  reply_to: msg3.msg_id
});

await bus_ack({ msg_id: msg3.msg_id });

console.log("Round 4 sent:", round4);
// Output:
// {
//   "msg_id": "msg_ops_1234567893_00a4",
//   "status": "queued",
//   "ref": "msg_ops_1234567893_00a4",
//   "round": 4  // Fourth message in thread
// }

// ============================================================================
// Thread limit reached:
// ============================================================================

// After 10 rounds (default limit), the bus will return ROUND_LIMIT:

// Round 11 attempt:
const round11 = await bus_send({
  to: "ops",
  content: "...",
  ref: "disk-check-2026-03-22",
  reply_to: "msg_main_1234567899_00aa"
});

console.log("Round 11 response:", round11);
// Output:
// {
//   "status": "ROUND_LIMIT",
//   "message": "Thread limit reached (10 rounds). Use a new ref or escalate."
// }

// Solution: Start a new thread with a new ref
const newThread = await bus_send({
  to: "ops",
  content: "Follow-up: Setup disk monitoring alerts",
  type: "task",
  priority: "P2",
  ref: "disk-monitoring-setup-2026-03-22"  // New ref = new thread
});

console.log("New thread started:", newThread);
// Output:
// {
//   "msg_id": "msg_main_1234567900_00ab",
//   "status": "queued",
//   "ref": "msg_main_1234567900_00ab",
//   "round": 1  // New thread, back to round 1
// }

// ============================================================================
// Query thread history:
// ============================================================================

// Get all messages in a thread using bus_status
const threadHistory = await bus_status({
  msg_id: "msg_main_1234567890_00a1"  // First message in thread
});

console.log("Thread history:", threadHistory);
// Output shows full conversation with all rounds

// ============================================================================
// Best Practices:
// ============================================================================
// 
// 1. Always use reply_to for responses
// 2. Use consistent ref for the entire conversation
// 3. Start a new ref when hitting ROUND_LIMIT
// 4. Use escalation type when bumping priority in a thread
// 5. Call bus_ack after processing each message
// 6. Monitor thread depth to avoid hitting the limit
// 7. Consider using ref as a task ID or correlation ID
// 
// ============================================================================
// Thread Limit Configuration:
// ============================================================================
// 
// Default: 10 rounds (configurable in plugin config)
// 
// To change the limit, update openclaw.json:
// 
// {
//   "plugins": {
//     "entries": {
//       "openclaw-message-bus": {
//         "config": {
//           "threadLimit": 20  // Increase to 20 rounds
//         }
//       }
//     }
//   }
// }
