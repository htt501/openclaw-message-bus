/**
 * Priority Routing Example
 * 
 * This example demonstrates how to use priority levels to ensure
 * urgent messages are delivered first.
 */

// ============================================================================
// Scenario: Multiple agents send messages with different priorities
// ============================================================================

// --- Agent: creator (sender) ---

// Low priority: content creation request
await bus_send({
  to: "ops",
  content: "Create thumbnails for last week's blog posts",
  type: "task",
  priority: "P3",  // Low priority
  ref: "content-batch-001"
});

// --- Agent: intel (sender) ---

// Normal priority: daily report
await bus_send({
  to: "ops",
  content: "Daily report ready for review",
  type: "notify",
  priority: "P2",  // Normal priority (default)
  ref: "daily-report-2026-03-22"
});

// --- Agent: strategist (sender) ---

// High priority: system alert
await bus_send({
  to: "ops",
  content: "Disk usage critical: 95% on main server",
  type: "escalation",
  priority: "P1",  // High priority
  ref: "alert-disk-001"
});

// --- Agent: main (sender) ---

// Urgent: production incident
await bus_send({
  to: "ops",
  content: "Production down: gateway process crashed",
  type: "escalation",
  priority: "P0",  // Urgent (highest priority)
  ref: "incident-gateway-001"
});

// ============================================================================
// Message delivery order (ops reads messages):
// ============================================================================

// --- Agent: ops (receiver) ---

const messages = await bus_read({
  limit: 10
});

console.log("Messages received in priority order:");

// Output (sorted by priority first, then timestamp):
// [
//   {
//     "msg_id": "msg_main_1234567894_00a4",      // P0 (urgent)
//     "from_agent": "main",
//     "content": "Production down: gateway process crashed",
//     "priority": "P0"
//   },
//   {
//     "msg_id": "msg_strategist_1234567893_00a3", // P1 (high)
//     "from_agent": "strategist",
//     "content": "Disk usage critical: 95% on main server",
//     "priority": "P1"
//   },
//   {
//     "msg_id": "msg_intel_1234567892_00a2",      // P2 (normal)
//     "from_agent": "intel",
//     "content": "Daily report ready for review",
//     "priority": "P2"
//   },
//   {
//     "msg_id": "msg_creator_1234567891_00a1",    // P3 (low)
//     "from_agent": "creator",
//     "content": "Create thumbnails for last week's blog posts",
//     "priority": "P3"
//   }
// ]

// ============================================================================
// Priority Guidelines:
// ============================================================================
// 
// P0 (Urgent):
// - Production incidents
// - Security alerts
// - System crashes
// - Data loss risks
// 
// P1 (High):
// - Performance degradation
// - Resource warnings (disk, memory)
// - Critical bug reports
// - Escalated tasks
// 
// P2 (Normal) - Default:
// - Daily reports
// - Standard tasks
// - General notifications
// - Non-urgent requests
// 
// P3 (Low):
// - Background tasks
// - Batch operations
// - Nice-to-have features
// - Non-critical notifications
// 
// ============================================================================
// Best Practices:
// ============================================================================
// 
// 1. Use P0 sparingly (only for true emergencies)
// 2. P2 is the default (most messages should be P2)
// 3. Reserve P3 for batch operations that can wait
// 4. Consider using escalation type for P0/P1 messages
// 5. Monitor message queue to ensure P0/P1 are handled quickly
