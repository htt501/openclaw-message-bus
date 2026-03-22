/**
 * Error Handling and Retry Example
 * 
 * This example demonstrates how the message bus handles failures,
 * retries, and dead-letter messages.
 */

// ============================================================================
// Scenario 1: Message delivery failure and automatic retry
// ============================================================================

// --- Agent: main sends a message ---

await bus_send({
  to: "ops",
  content: "Check server status",
  type: "request",
  priority: "P1",
  ref: "server-check-001"
});

// Message is delivered to ops
const messages = await bus_read({ limit: 10 });
const msg = messages.messages[0];

// ops processes the message but crashes before acknowledging
// ... (ops agent crashes) ...

// After 5 minutes (processing timeout):
// - Message status changes from 'delivered' back to 'queued'
// - retry_count increments (1/3)
// - Cron job automatically reverts the message

// ops restarts and reads again
const messages2 = await bus_read({ limit: 10 });
// Same message is re-delivered (retry 1)

// ============================================================================
// Scenario 2: Reaching max retries (dead-letter)
// ============================================================================

// After 3 failed delivery attempts:
// - Message status changes to 'dead_letter'
// - last_error field is populated
// - Message is no longer delivered via bus_read

// Query dead-letter messages
const status = await bus_status({
  msg_id: "msg_main_1234567890_00a1"
});

console.log("Dead-letter message:", status);
// Output:
// {
//   "msg_id": "msg_main_1234567890_00a1",
//   "from_agent": "main",
//   "to_agent": "ops",
//   "status": "dead_letter",
//   "retry_count": 3,
//   "max_retries": 3,
//   "last_error": "Processing timeout exceeded 3 times",
//   "created_at": "2026-03-22T14:00:00.000Z",
//   "processing_at": "2026-03-22T14:15:00.000Z"
// }

// Manual recovery from dead-letter:
// 1. Fix the underlying issue (e.g., ops agent bug)
// 2. Manually update the database to retry:
//    UPDATE messages SET status='queued', retry_count=0 
//    WHERE msg_id='msg_main_1234567890_00a1'
// 3. Or re-send the message with a new msg_id

// ============================================================================
// Scenario 3: SQLite write failure and fallback
// ============================================================================

// If SQLite write fails (e.g., disk full, permissions):
const result = await bus_send({
  to: "ops",
  content: "Critical alert",
  priority: "P0"
});

console.log("Fallback result:", result);
// Output (if SQLite failed):
// {
//   "msg_id": "msg_main_1234567891_00a2",
//   "status": "fallback",
//   "ref": "msg_main_1234567891_00a2",
//   "fallback_path": "/tmp/bus-fallback/msg_main_1234567891_00a2.json"
// }

// Message is saved to /tmp/bus-fallback/ as JSON
// Cron job (every 5 minutes) automatically recovers fallback messages:
// 1. Read /tmp/bus-fallback/*.json files
// 2. Attempt to insert into SQLite
// 3. Delete JSON file on success
// 4. Retry on next cron run if still failing

// ============================================================================
// Scenario 4: Message expiry (24-hour TTL)
// ============================================================================

// Messages not acknowledged within 24 hours are automatically expired
// Cron job (hourly) updates status to 'expired'

const expiredStatus = await bus_status({
  msg_id: "msg_main_1234567892_00a3"
});

console.log("Expired message:", expiredStatus);
// Output:
// {
//   "msg_id": "msg_main_1234567892_00a3",
//   "status": "expired",
//   "expired_at": "2026-03-23T14:00:00.000Z"
// }

// Expired messages are no longer delivered
// They are deleted after 7 days (configurable)

// ============================================================================
// Scenario 5: Idempotent acknowledgment
// ============================================================================

// Acknowledging the same message multiple times is safe
await bus_ack({ msg_id: "msg_main_1234567893_00a4" });
// Output: { "status": "SUCCESS" }

await bus_ack({ msg_id: "msg_main_1234567893_00a4" });
// Output: { "status": "ALREADY_ACKED" }

// ============================================================================
// Error Monitoring and Debugging:
// ============================================================================

// 1. Check message status
const status2 = await bus_status({
  msg_id: "msg_main_1234567894_00a5"
});

// 2. Monitor retry counts
console.log("Retry count:", status2.retry_count);

// 3. Check last error
console.log("Last error:", status2.last_error);

// 4. Query all dead-letter messages (via SQLite query)
// SELECT * FROM messages WHERE status='dead_letter' ORDER BY created_at DESC

// 5. Monitor fallback directory
// ls -la /tmp/bus-fallback/

// ============================================================================
// Best Practices:
// ============================================================================
// 
// 1. Always call bus_ack after successful processing
// 2. Implement graceful shutdown to avoid mid-processing crashes
// 3. Monitor dead-letter messages regularly
// 4. Set up alerts for fallback directory growth
// 5. Test retry logic in development
// 6. Log errors before agent crashes
// 7. Use bus_status to debug message delivery issues
// 8. Consider implementing custom retry logic for critical messages
// 
// ============================================================================
// Configuration:
// ============================================================================
// 
// Adjust timeouts and limits in openclaw.json:
// 
// {
//   "plugins": {
//     "entries": {
//       "openclaw-message-bus": {
//         "config": {
//           "processingTimeoutMinutes": 5,    // Processing timeout
//           "maxRetries": 3,                   // Max retry attempts
//           "messageExpiryHours": 24,          // Message TTL
//           "fallbackPath": "/tmp/bus-fallback/",
//           "fallbackRecoveryMinutes": 5       // Fallback recovery interval
//         }
//       }
//     }
//   }
// }
