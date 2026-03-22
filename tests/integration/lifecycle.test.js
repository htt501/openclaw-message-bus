/**
 * 集成测试：完整消息生命周期
 * 模拟 OpenClaw 插件 API，验证 T1-T17 验收场景
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../helpers/db.js';
import { setAgents } from '../../src/schema.js';
import { createBusSend } from '../../src/tools/bus_send.js';
import { createBusRead } from '../../src/tools/bus_read.js';
import { createBusAck } from '../../src/tools/bus_ack.js';
import { createBusStatus } from '../../src/tools/bus_status.js';
import { revertTimedOutMessages, cleanExpiredMessages, logMetrics } from '../../src/cron.js';

// Mock runtime (kept for API compat, CLI notify is fire-and-forget)
function createMockRuntime() {
  return {};
}

// Mock logger
function createMockLogger() {
  const logs = [];
  return {
    logs,
    info: (msg) => logs.push({ level: 'info', msg }),
    warn: (msg) => logs.push({ level: 'warn', msg }),
    error: (msg) => logs.push({ level: 'error', msg })
  };
}

describe('Integration: Message Lifecycle', () => {
  let db, runtime, logger;
  let sendTool, readTool, ackTool, statusTool;

  beforeEach(() => {
    db = createTestDb();
    runtime = createMockRuntime();
    logger = createMockLogger();

    // Set valid agents for tests
    setAgents(['main', 'ops', 'creator', 'intel', 'strategist', 'chichi', 'secretary']);

    // Notify disabled in tests to avoid real CLI calls
    const notifyOpts = { enabled: false };

    const sendFactory = createBusSend(db, runtime, logger, notifyOpts);
    const readFactory = createBusRead(db, logger);
    const ackFactory = createBusAck(db, logger);
    const statusFactory = createBusStatus(db, logger);

    sendTool = sendFactory({ agentId: 'main' });
    readTool = readFactory({ agentId: 'ops' });
    ackTool = ackFactory({ agentId: 'ops' });
    statusTool = statusFactory({ agentId: 'ops' });
  });

  // T1: bus_send 基本发送
  it('T1: bus_send should create a queued message', async () => {
    const result = await sendTool.execute('tc1', {
      to: 'ops',
      content: 'Hello ops',
      type: 'task',
      priority: 'P1'
    });
    assert.ok(result.details.msg_id, 'Should return msg_id');
    assert.equal(result.details.status, 'queued');
    assert.ok(result.content[0].type === 'text');

    const msg = db.getMessageStatus(result.details.msg_id);
    assert.equal(msg.from_agent, 'main');
    assert.equal(msg.to_agent, 'ops');
    assert.equal(msg.type, 'task');
    assert.equal(msg.priority, 'P1');
    assert.equal(msg.status, 'queued');
  });

  // T2: bus_send 默认值
  it('T2: bus_send should apply default type=notify and priority=P2', async () => {
    const result = await sendTool.execute('tc2', {
      to: 'ops',
      content: 'Default test'
    });
    const msg = db.getMessageStatus(result.details.msg_id);
    assert.equal(msg.type, 'notify');
    assert.equal(msg.priority, 'P2');
  });

  // T3: bus_send 参数校验 — 非法 to
  it('T3: bus_send should reject invalid to agent', async () => {
    const result = await sendTool.execute('tc3', {
      to: 'unknown_agent',
      content: 'test'
    });
    assert.equal(result.details.error, 'INVALID_PARAM');
  });

  // T4: bus_send 参数校验 — content 超长
  it('T4: bus_send should reject content > 10KB', async () => {
    const bigContent = 'x'.repeat(10241);
    const result = await sendTool.execute('tc4', {
      to: 'ops',
      content: bigContent
    });
    assert.equal(result.details.error, 'INVALID_PARAM');
  });

  // T5: bus_send 参数校验 — 非法 type/priority
  it('T5: bus_send should reject invalid type and priority', async () => {
    const r1 = await sendTool.execute('tc5a', {
      to: 'ops', content: 'test', type: 'invalid_type'
    });
    assert.equal(r1.details.error, 'INVALID_PARAM');

    const r2 = await sendTool.execute('tc5b', {
      to: 'ops', content: 'test', priority: 'P9'
    });
    assert.equal(r2.details.error, 'INVALID_PARAM');
  });

  // T6: bus_send CLI notify (verify it doesn't crash when enabled)
  it('T6: bus_send with notify enabled should not crash', async () => {
    const notifyOpts = { enabled: true, timeoutSeconds: 5, replyChannel: '', replyTo: '' };
    const notifySendFactory = createBusSend(db, runtime, logger, notifyOpts);
    const notifySendTool = notifySendFactory({ agentId: 'main' });

    const result = await notifySendTool.execute('tc6', { to: 'ops', content: 'push test' });
    assert.equal(result.details.status, 'queued');
    // CLI exec is fire-and-forget, may fail in test env but bus_send still succeeds
  });

  // T7: bus_read 原子读取 — marks as delivered directly
  it('T7: bus_read should atomically read and mark as delivered', async () => {
    await sendTool.execute('tc7a', { to: 'ops', content: 'msg1' });
    await sendTool.execute('tc7b', { to: 'ops', content: 'msg2' });
    await sendTool.execute('tc7c', { to: 'ops', content: 'msg3' });

    const result = await readTool.execute('tc7', {});
    assert.equal(result.details.count, 3);
    assert.equal(result.details.messages.length, 3);

    // Verify status is delivered (not processing)
    for (const m of result.details.messages) {
      const dbMsg = db.getMessageStatus(m.msg_id);
      assert.equal(dbMsg.status, 'delivered');
      assert.ok(dbMsg.delivered_at);
    }
  });

  // T8: bus_read 筛选
  it('T8: bus_read should filter by from and type', async () => {
    await sendTool.execute('tc8a', { to: 'ops', content: 'task1', type: 'task' });
    await sendTool.execute('tc8b', { to: 'ops', content: 'notify1', type: 'notify' });

    const notifyOpts = { enabled: false };
    const intelSend = createBusSend(db, runtime, logger, notifyOpts)({ agentId: 'intel' });
    await intelSend.execute('tc8c', { to: 'ops', content: 'from intel', type: 'task' });

    const result = await readTool.execute('tc8', { from: 'main', type: 'task' });
    assert.equal(result.details.count, 1);
    assert.equal(result.details.messages[0].from_agent, 'main');
    assert.equal(result.details.messages[0].type, 'task');
  });

  // T9: bus_read limit
  it('T9: bus_read should respect limit', async () => {
    for (let i = 0; i < 5; i++) {
      await sendTool.execute(`tc9_${i}`, { to: 'ops', content: `msg${i}` });
    }
    const result = await readTool.execute('tc9', { limit: 2 });
    assert.equal(result.details.count, 2);
  });

  // T10: bus_read 优先级排序
  it('T10: bus_read should return P0 before P2', async () => {
    const now = new Date().toISOString();
    db.insertMessage({
      msg_id: 'msg_main_t10_0001', from_agent: 'main', to_agent: 'ops',
      type: 'notify', priority: 'P2', content: 'low', created_at: now
    });
    db.insertMessage({
      msg_id: 'msg_main_t10_0002', from_agent: 'main', to_agent: 'ops',
      type: 'notify', priority: 'P0', content: 'high', created_at: now
    });

    const result = await readTool.execute('tc10', { limit: 2 });
    assert.equal(result.details.messages[0].content, 'high');
    assert.equal(result.details.messages[1].content, 'low');
  });

  // T11: bus_ack on already-delivered message returns ALREADY_ACKED (idempotent)
  it('T11: bus_ack should return ALREADY_ACKED for delivered messages', async () => {
    await sendTool.execute('tc11a', { to: 'ops', content: 'ack test' });
    const readResult = await readTool.execute('tc11b', {});
    const msgId = readResult.details.messages[0].msg_id;

    // bus_read already marked as delivered, so ack returns ALREADY_ACKED
    const ackResult = await ackTool.execute('tc11c', { msg_id: msgId });
    assert.equal(ackResult.details.error, 'ALREADY_ACKED');
  });

  // T12: bus_ack double ack is idempotent
  it('T12: bus_ack double ack returns ALREADY_ACKED', async () => {
    await sendTool.execute('tc12a', { to: 'ops', content: 'idempotent test' });
    const readResult = await readTool.execute('tc12b', {});
    const msgId = readResult.details.messages[0].msg_id;

    const firstAck = await ackTool.execute('tc12c', { msg_id: msgId });
    assert.equal(firstAck.details.error, 'ALREADY_ACKED');
    const secondAck = await ackTool.execute('tc12d', { msg_id: msgId });
    assert.equal(secondAck.details.error, 'ALREADY_ACKED');
  });

  // T13: bus_ack MSG_NOT_FOUND
  it('T13: bus_ack should return MSG_NOT_FOUND for unknown msg_id', async () => {
    const result = await ackTool.execute('tc13', { msg_id: 'msg_fake_0_0000' });
    assert.equal(result.details.error, 'MSG_NOT_FOUND');
  });

  // T14: bus_status 查询
  it('T14: bus_status should return full message record', async () => {
    const sendResult = await sendTool.execute('tc14a', {
      to: 'ops', content: 'status test', type: 'discuss', priority: 'P1', ref: 'ref123'
    });
    const msgId = sendResult.details.msg_id;

    const statusResult = await statusTool.execute('tc14b', { msg_id: msgId });
    assert.equal(statusResult.details.msg_id, msgId);
    assert.equal(statusResult.details.from_agent, 'main');
    assert.equal(statusResult.details.to_agent, 'ops');
    assert.equal(statusResult.details.type, 'discuss');
    assert.equal(statusResult.details.priority, 'P1');
    assert.equal(statusResult.details.ref, 'ref123');
    assert.equal(statusResult.details.status, 'queued');
  });

  // T15: bus_status MSG_NOT_FOUND
  it('T15: bus_status should return MSG_NOT_FOUND for unknown msg_id', async () => {
    const result = await statusTool.execute('tc15', { msg_id: 'msg_nonexistent_0_0000' });
    assert.equal(result.details.error, 'MSG_NOT_FOUND');
  });

  // T16: 完整生命周期 send → read → status(delivered)
  it('T16: full lifecycle send → read → status', async () => {
    const sendResult = await sendTool.execute('tc16a', { to: 'ops', content: 'lifecycle' });
    const msgId = sendResult.details.msg_id;
    assert.equal(sendResult.details.status, 'queued');

    let status = await statusTool.execute('tc16b', { msg_id: msgId });
    assert.equal(status.details.status, 'queued');

    const readResult = await readTool.execute('tc16c', {});
    assert.equal(readResult.details.messages[0].msg_id, msgId);

    // bus_read marks as delivered directly
    status = await statusTool.execute('tc16d', { msg_id: msgId });
    assert.equal(status.details.status, 'delivered');
    assert.ok(status.details.delivered_at);
  });

  // T17: bus_read 并发安全 — 两次 read 不返回相同消息
  it('T17: concurrent bus_read should not return overlapping messages', async () => {
    for (let i = 0; i < 10; i++) {
      await sendTool.execute(`tc17_${i}`, { to: 'ops', content: `msg${i}` });
    }

    const r1 = await readTool.execute('tc17a', { limit: 5 });
    const r2 = await readTool.execute('tc17b', { limit: 5 });

    const ids1 = new Set(r1.details.messages.map(m => m.msg_id));
    const ids2 = new Set(r2.details.messages.map(m => m.msg_id));

    for (const id of ids1) {
      assert.ok(!ids2.has(id), `msg_id ${id} appeared in both reads`);
    }
    assert.equal(ids1.size + ids2.size, 10);
  });
});

describe('Integration: Cron Jobs', () => {
  let db, logger;

  beforeEach(() => {
    db = createTestDb();
    logger = createMockLogger();
  });

  it('should revert timed-out processing messages', () => {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    db.insertMessage({
      msg_id: 'msg_main_1_0001', from_agent: 'main', to_agent: 'ops',
      type: 'task', priority: 'P1', content: 'timeout test', created_at: fifteenMinAgo
    });
    db.getDb().prepare('UPDATE messages SET status = ?, processing_at = ? WHERE msg_id = ?')
      .run('processing', fifteenMinAgo, 'msg_main_1_0001');

    const result = revertTimedOutMessages(db, logger);
    assert.equal(result.reverted, 1);

    const msg = db.getMessageStatus('msg_main_1_0001');
    assert.equal(msg.status, 'queued');
    assert.equal(msg.retry_count, 1);
  });

  it('should mark as dead_letter when max retries exceeded', () => {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    db.insertMessage({
      msg_id: 'msg_main_2_0001', from_agent: 'main', to_agent: 'ops',
      type: 'task', priority: 'P1', content: 'dead letter test', created_at: fifteenMinAgo
    });
    db.getDb().prepare('UPDATE messages SET status = ?, processing_at = ?, retry_count = 3 WHERE msg_id = ?')
      .run('processing', fifteenMinAgo, 'msg_main_2_0001');

    const result = revertTimedOutMessages(db, logger);
    assert.equal(result.deadLettered, 1);

    const msg = db.getMessageStatus('msg_main_2_0001');
    assert.equal(msg.status, 'dead_letter');
  });

  it('should clean expired messages correctly', () => {
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    db.insertMessage({
      msg_id: 'msg_main_3_0001', from_agent: 'main', to_agent: 'ops',
      type: 'notify', priority: 'P2', content: 'old delivered', created_at: eightDaysAgo
    });
    db.getDb().prepare('UPDATE messages SET status = ?, delivered_at = ? WHERE msg_id = ?')
      .run('delivered', eightDaysAgo, 'msg_main_3_0001');

    db.insertMessage({
      msg_id: 'msg_main_4_0001', from_agent: 'main', to_agent: 'ops',
      type: 'notify', priority: 'P2', content: 'old queued', created_at: twoDaysAgo
    });

    const result = cleanExpiredMessages(db, logger);
    assert.equal(result.deletedDelivered, 1);
    assert.equal(result.expiredQueued, 1);

    assert.equal(db.getMessageStatus('msg_main_3_0001'), undefined);
    const msg = db.getMessageStatus('msg_main_4_0001');
    assert.equal(msg.status, 'expired');
    assert.ok(msg.expired_at);
  });

  it('should log metrics correctly', () => {
    db.insertMessage({
      msg_id: 'msg_main_5_0001', from_agent: 'main', to_agent: 'ops',
      type: 'notify', priority: 'P2', content: 'metrics test', created_at: new Date().toISOString()
    });

    const metrics = logMetrics(db, {}, logger);
    assert.equal(metrics.total, 1);
    assert.equal(metrics.queued, 1);
    assert.ok(logger.logs.some(l => l.msg.includes('cron/metrics')));
  });
});
