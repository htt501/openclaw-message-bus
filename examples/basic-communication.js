/**
 * Basic Agent-to-Agent Communication Example
 * 
 * This example shows how to send and receive messages between agents
 * using the message bus.
 */

// ============================================================================
// Scenario: ops agent asks intel agent to gather data
// ============================================================================

// --- Agent: ops (sender) ---

// Step 1: Send a message
const sendResult = await bus_send({
  to: "intel",
  content: "Please gather AI news for today's report",
  type: "task",
  priority: "P1",
  ref: "daily-report-2026-03-22"
});

console.log("Message sent:", sendResult);
// Output:
// {
//   "msg_id": "msg_ops_1234567890_00a1",
//   "status": "queued",
//   "ref": "msg_ops_1234567890_00a1",
//   "round": 1
// }

// --- Agent: intel (receiver) ---

// Step 2: Read pending messages
const messages = await bus_read({
  limit: 10
});

console.log("Received messages:", messages);
// Output:
// {
//   "messages": [
//     {
//       "msg_id": "msg_ops_1234567890_00a1",
//       "from_agent": "ops",
//       "type": "task",
//       "priority": "P1",
//       "content": "Please gather AI news for today's report",
//       "ref": "daily-report-2026-03-22",
//       "created_at": "2026-03-22T14:00:00.000Z"
//     }
//   ]
// }

// Step 3: Process the message
// ... (intel gathers AI news) ...

// Step 4: Acknowledge the message
await bus_ack({
  msg_id: "msg_ops_1234567890_00a1"
});

console.log("Message acknowledged");
// Output:
// {
//   "msg_id": "msg_ops_1234567890_00a1",
//   "status": "SUCCESS"
// }

// Step 5: Send response back
await bus_send({
  to: "ops",
  content: "AI news report ready: shared-docs/news/2026-03-22.md",
  type: "response",
  priority: "P1",
  ref: "daily-report-2026-03-22",
  reply_to: "msg_ops_1234567890_00a1"
});

console.log("Response sent");

// ============================================================================
// Key Points:
// ============================================================================
// 
// 1. Always call bus_read on agent activation
// 2. Process messages and call bus_ack when done
// 3. Use reply_to for thread tracking
// 4. Use appropriate priority (P0/P1 for urgent, P2 for normal)
// 5. Use ref for correlation (e.g., task ID, project ID)
