/**
 * Integration tests v1.2 — Full message lifecycle
 * 集成测试 v1.2 — 完整消息生命周期
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../helpers/db.js';
import { createBusSend } from '../../src/tools/bus_send.js';
import { createBusRead } from '../../src/tools/bus_read.js';
import { createBusAck } from '../../src/tools/bus_ack.js';
import { createBusStatus } from '../../src/tools/bus_status.js';
import { setAgents } from '../../src/schema.js';
import { revertTimedOutMessages, cleanExpiredMessages, logMetrics } from '../../src/cron.js';

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };

describe('v1.2 message lifecycle', () => {
  let db, send, read, ack, status;

  beforeEach(() => {
    db = createTestDb();
    setAgents(['main', 'ops', 'creator', 'intel', 'strategist', 'chichi']);

    // createBusSend(db, runtime, logger, notifyOpts)
    send = createBusSend(db, {}, logger, { enabled: false })({ agentId: 'main' });
    read = createBusRead(db, logger)({ agentId: 'ops' });
    ack = createBusAck(db, logger)({ agentId: 'ops' });
    status = createBusStatus(db, logger)({ agentId: 'main' });
  });

  // === Task lifecycle (requires explicit ack) ===

  it('task: send → read → ack(processing) → ack(completed) → status', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'deploy v2', type: 'task', priority: 'P0' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    assert.ok(msgId);

    const readResult = await read.execute('tc2', {});
    const readParsed = JSON.parse(readResult.content[0].text);
    assert.equal(readParsed.messages.length, 1);
    assert.equal(readParsed.messages[0].content, 'deploy v2');

    // Status: delivered (task stays delivered until explicit ack)
    let sr = await status.execute('tc3', { msg_id: msgId });
    let sp = JSON.parse(sr.content[0].text);
    assert.equal(sp.status, 'delivered');
    assert.equal(sp.processing_at, null);

    // Ack: processing
    let ar = await ack.execute('tc4', { msg_id: msgId, status: 'processing' });
    let ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.status, 'processing');

    sr = await status.execute('tc5', { msg_id: msgId });
    sp = JSON.parse(sr.content[0].text);
    assert.equal(sp.status, 'processing');
    assert.ok(sp.processing_at);

    // Ack: completed
    ar = await ack.execute('tc6', { msg_id: msgId, status: 'completed', result: 'deployed ok' });
    ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.status, 'completed');
    assert.equal(ap.result, 'deployed ok');

    sr = await status.execute('tc7', { msg_id: msgId });
    sp = JSON.parse(sr.content[0].text);
    assert.equal(sp.status, 'completed');
    assert.ok(sp.completed_at);
    assert.equal(sp.result, 'deployed ok');
  });

  it('task: send → read → ack(completed, skip processing)', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'quick', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});

    const ar = await ack.execute('tc3', { msg_id: msgId, status: 'completed', result: 'done' });
    const ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.status, 'completed');
    assert.equal(ap.prev_status, 'delivered');
  });

  it('task: send → read → ack(failed)', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'risky', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});

    const ar = await ack.execute('tc3', { msg_id: msgId, status: 'failed', reason: 'permission denied' });
    const ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.status, 'failed');
    assert.equal(ap.fail_reason, 'permission denied');

    const sr = await status.execute('tc4', { msg_id: msgId });
    const sp = JSON.parse(sr.content[0].text);
    assert.equal(sp.status, 'failed');
    assert.equal(sp.fail_reason, 'permission denied');
  });

  // === Auto-ack (v1.2): non-task messages complete on read ===

  it('response: auto-completed on bus_read (no ack needed)', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'result data', type: 'response' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;

    const readResult = await read.execute('tc2', {});
    const readParsed = JSON.parse(readResult.content[0].text);
    assert.equal(readParsed.messages.length, 1);
    assert.equal(readParsed.messages[0].content, 'result data');

    // Should be completed immediately after read
    const sr = await status.execute('tc3', { msg_id: msgId });
    const sp = JSON.parse(sr.content[0].text);
    assert.equal(sp.status, 'completed');
    assert.equal(sp.result, 'auto-ack: read');
  });

  it('notify: auto-completed on bus_read', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'heads up', type: 'notify' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});

    const sr = await status.execute('tc3', { msg_id: msgId });
    const sp = JSON.parse(sr.content[0].text);
    assert.equal(sp.status, 'completed');
  });

  it('discuss: auto-completed on bus_read', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'thoughts?', type: 'discuss' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});

    const sr = await status.execute('tc3', { msg_id: msgId });
    const sp = JSON.parse(sr.content[0].text);
    assert.equal(sp.status, 'completed');
  });

  it('mixed read: task stays delivered, response auto-completed', async () => {
    await send.execute('tc1', { to: 'ops', content: 'do this', type: 'task', priority: 'P0' });
    await send.execute('tc2', { to: 'ops', content: 'fyi', type: 'response' });

    const readResult = await read.execute('tc3', {});
    const readParsed = JSON.parse(readResult.content[0].text);
    assert.equal(readParsed.messages.length, 2);

    // Check statuses in DB
    const taskMsg = readParsed.messages.find(m => m.type === 'task');
    const respMsg = readParsed.messages.find(m => m.type === 'response');

    const taskStatus = db.getMessageStatus(taskMsg.msg_id);
    const respStatus = db.getMessageStatus(respMsg.msg_id);

    assert.equal(taskStatus.status, 'delivered');   // task needs explicit ack
    assert.equal(respStatus.status, 'completed');   // response auto-acked
  });

  // === Error handling ===

  it('ack on completed message returns ALREADY_COMPLETED', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'x', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});
    await ack.execute('tc3', { msg_id: msgId, status: 'completed' });

    const ar = await ack.execute('tc4', { msg_id: msgId, status: 'processing' });
    const ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.error, 'ALREADY_COMPLETED');
  });

  it('ack on nonexistent message returns MSG_NOT_FOUND', async () => {
    const ar = await ack.execute('tc1', { msg_id: 'msg_nope' });
    const ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.error, 'MSG_NOT_FOUND');
  });

  it('ack on queued message returns INVALID_TRANSITION', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'x', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    // Don't read — message stays queued

    const ar = await ack.execute('tc2', { msg_id: msgId, status: 'processing' });
    const ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.error, 'INVALID_TRANSITION');
  });

  it('ack on auto-completed response returns ALREADY_COMPLETED', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'info', type: 'response' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {}); // auto-ack

    const ar = await ack.execute('tc3', { msg_id: msgId });
    const ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.error, 'ALREADY_COMPLETED');
  });

  // === Cron jobs ===

  it('cron: processing timeout reverts to queued', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'x', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});
    await ack.execute('tc3', { msg_id: msgId, status: 'processing' });

    db.getDb().prepare("UPDATE messages SET processing_at = ? WHERE msg_id = ?")
      .run(new Date(Date.now() - 15 * 60 * 1000).toISOString(), msgId);

    const result = revertTimedOutMessages(db, logger);
    assert.equal(result.reverted, 1);
    const msg = db.getMessageStatus(msgId);
    assert.equal(msg.status, 'queued');
  });

  it('cron: delivered task expires after 2h', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'x', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});

    db.getDb().prepare("UPDATE messages SET delivered_at = ? WHERE msg_id = ?")
      .run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), msgId);

    const result = cleanExpiredMessages(db, logger);
    assert.equal(result.expiredDeliveredTasks, 1);
  });

  it('cron: metrics include completed/failed', async () => {
    await send.execute('tc1', { to: 'ops', content: 'a', type: 'task' });
    await send.execute('tc2', { to: 'ops', content: 'b', type: 'task' });
    await read.execute('tc3', {});

    const msgs = db.getDb().prepare("SELECT msg_id FROM messages WHERE status = 'delivered'").all();
    db.ackMessage(msgs[0].msg_id, { status: 'completed' });
    db.ackMessage(msgs[1].msg_id, { status: 'failed', reason: 'err' });

    const result = logMetrics(db, {}, logger);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
  });

  // === Send validation ===

  it('send with notify disabled does not spawn child process', async () => {
    const result = await send.execute('tc1', { to: 'ops', content: 'test', type: 'task', priority: 'P0' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.msg_id);
    assert.equal(parsed.status, 'queued');
  });

  it('send to invalid agent returns error', async () => {
    const result = await send.execute('tc1', { to: 'nobody', content: 'test', type: 'task' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'INVALID_PARAM');
  });

  it('send with invalid type returns error', async () => {
    const result = await send.execute('tc1', { to: 'ops', content: 'test', type: 'invalid_type' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'INVALID_PARAM');
  });

  it('send with invalid priority returns error', async () => {
    const result = await send.execute('tc1', { to: 'ops', content: 'test', type: 'task', priority: 'P9' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'INVALID_PARAM');
  });

  // === Thread tracking ===

  it('reply_to creates thread ref chain', async () => {
    const r1 = await send.execute('tc1', { to: 'ops', content: 'start', type: 'task' });
    const msgId1 = JSON.parse(r1.content[0].text).msg_id;
    const ref1 = JSON.parse(r1.content[0].text).ref;

    // ops replies
    const opsSend = createBusSend(db, {}, logger, { enabled: false })({ agentId: 'ops' });
    const r2 = await opsSend.execute('tc2', { to: 'main', content: 'reply', type: 'response', reply_to: msgId1 });
    const ref2 = JSON.parse(r2.content[0].text).ref;

    // Same thread ref
    assert.equal(ref1, ref2);
  });
});
