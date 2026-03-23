/**
 * 集成测试 v1.1 — 完整消息生命周期
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

describe('v1.1 message lifecycle', () => {
  let db, send, read, ack, status;

  beforeEach(() => {
    db = createTestDb();
    setAgents(['main', 'ops', 'creator', 'intel', 'strategist', 'chichi']);

    const notifyOpts = { enabled: false };
    send = createBusSend(db, notifyOpts, logger)({ agentId: 'main' });
    read = createBusRead(db, logger)({ agentId: 'ops' });
    ack = createBusAck(db, logger)({ agentId: 'ops' });
    status = createBusStatus(db, logger)({ agentId: 'main' });
  });

  it('send → read → ack(processing) → ack(completed) → status', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'deploy v2', type: 'task', priority: 'P0' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    assert.ok(msgId);

    const readResult = await read.execute('tc2', {});
    const readParsed = JSON.parse(readResult.content[0].text);
    assert.equal(readParsed.messages.length, 1);
    assert.equal(readParsed.messages[0].content, 'deploy v2');

    // Status: delivered, processing_at null
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

  it('send → read → ack(completed, skip processing)', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'quick', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});

    const ar = await ack.execute('tc3', { msg_id: msgId, status: 'completed', result: 'done' });
    const ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.status, 'completed');
    assert.equal(ap.prev_status, 'delivered');
  });

  it('send → read → ack(failed)', async () => {
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

  it('ack without status defaults to completed (backward compat)', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'simple', type: 'notify' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});

    const ar = await ack.execute('tc3', { msg_id: msgId });
    const ap = JSON.parse(ar.content[0].text);
    assert.equal(ap.status, 'completed');
  });

  it('ack on completed message returns error', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'x', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;
    await read.execute('tc2', {});
    await ack.execute('tc3', { msg_id: msgId, status: 'completed' });

    const ar = await ack.execute('tc4', { msg_id: msgId, status: 'processing' });
    assert.equal(ar.isError, true);
    assert.ok(ar.content[0].text.includes('ALREADY_COMPLETED'));
  });

  it('ack on nonexistent message returns error', async () => {
    const ar = await ack.execute('tc1', { msg_id: 'msg_nope' });
    assert.equal(ar.isError, true);
    assert.ok(ar.content[0].text.includes('MSG_NOT_FOUND'));
  });

  it('ack on queued message returns INVALID_TRANSITION', async () => {
    const sendResult = await send.execute('tc1', { to: 'ops', content: 'x', type: 'task' });
    const msgId = JSON.parse(sendResult.content[0].text).msg_id;

    const ar = await ack.execute('tc2', { msg_id: msgId, status: 'processing' });
    assert.equal(ar.isError, true);
    assert.ok(ar.content[0].text.includes('INVALID_TRANSITION'));
  });

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

  it('send with notify disabled does not throw', async () => {
    const result = await send.execute('tc1', { to: 'ops', content: 'test', type: 'task', priority: 'P0' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.msg_id);
    assert.equal(parsed.notified, false);
  });
});
