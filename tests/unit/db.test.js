/**
 * db.js 单元测试 v1.1
 * 覆盖：消息插入、读取、v1.1 状态转换、超时回退、过期清理、指标
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../helpers/db.js';

describe('db operations v1.1', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('insertMessage + getMessageStatus', () => {
    it('inserts and retrieves a message', () => {
      db.insertMessage({
        msg_id: 'msg_001', from_agent: 'main', to_agent: 'ops',
        type: 'task', priority: 'P1', content: 'hello',
        created_at: new Date().toISOString()
      });
      const msg = db.getMessageStatus('msg_001');
      assert.ok(msg);
      assert.equal(msg.status, 'queued');
      assert.equal(msg.from_agent, 'main');
      assert.equal(msg.processing_at, null);
      assert.equal(msg.completed_at, null);
      assert.equal(msg.failed_at, null);
      assert.equal(msg.result, null);
      assert.equal(msg.fail_reason, null);
    });
  });

  describe('readMessages v1.1', () => {
    it('marks as delivered without setting processing_at', () => {
      db.insertMessage({
        msg_id: 'msg_001', from_agent: 'main', to_agent: 'ops',
        type: 'task', priority: 'P1', content: 'hello',
        created_at: new Date().toISOString()
      });
      const rows = db.readMessages('ops', null, null, 10);
      assert.equal(rows.length, 1);

      const msg = db.getMessageStatus('msg_001');
      assert.equal(msg.status, 'delivered');
      assert.ok(msg.delivered_at);
      assert.equal(msg.processing_at, null); // v1.1: no longer set by read
    });

    it('returns messages sorted by priority then created_at', () => {
      const now = new Date();
      db.insertMessage({ msg_id: 'p2', from_agent: 'a', to_agent: 'b', type: 'notify', priority: 'P2', content: 'low', created_at: new Date(now.getTime() - 1000).toISOString() });
      db.insertMessage({ msg_id: 'p0', from_agent: 'a', to_agent: 'b', type: 'task', priority: 'P0', content: 'high', created_at: now.toISOString() });
      const rows = db.readMessages('b', null, null, 10);
      assert.equal(rows[0].msg_id, 'p0');
      assert.equal(rows[1].msg_id, 'p2');
    });
  });

  describe('ackMessage v1.1 state transitions', () => {
    beforeEach(() => {
      db.insertMessage({
        msg_id: 'msg_t', from_agent: 'main', to_agent: 'ops',
        type: 'task', priority: 'P1', content: 'do something',
        created_at: new Date().toISOString()
      });
      db.readMessages('ops', null, null, 10);
    });

    it('delivered → processing', () => {
      const r = db.ackMessage('msg_t', { status: 'processing' });
      assert.equal(r.status, 'processing');
      assert.equal(r.prev_status, 'delivered');
      const msg = db.getMessageStatus('msg_t');
      assert.equal(msg.status, 'processing');
      assert.ok(msg.processing_at);
    });

    it('delivered → completed (skip processing)', () => {
      const r = db.ackMessage('msg_t', { status: 'completed' });
      assert.equal(r.status, 'completed');
      assert.equal(r.prev_status, 'delivered');
      const msg = db.getMessageStatus('msg_t');
      assert.equal(msg.status, 'completed');
      assert.ok(msg.completed_at);
    });

    it('delivered → completed with result', () => {
      const r = db.ackMessage('msg_t', { status: 'completed', result: 'done: https://example.com' });
      assert.equal(r.status, 'completed');
      assert.equal(r.result, 'done: https://example.com');
      const msg = db.getMessageStatus('msg_t');
      assert.equal(msg.result, 'done: https://example.com');
    });

    it('delivered → failed with reason', () => {
      const r = db.ackMessage('msg_t', { status: 'failed', reason: 'disk full' });
      assert.equal(r.status, 'failed');
      assert.equal(r.fail_reason, 'disk full');
      const msg = db.getMessageStatus('msg_t');
      assert.equal(msg.status, 'failed');
      assert.ok(msg.failed_at);
      assert.equal(msg.fail_reason, 'disk full');
    });

    it('processing → completed', () => {
      db.ackMessage('msg_t', { status: 'processing' });
      const r = db.ackMessage('msg_t', { status: 'completed', result: 'all good' });
      assert.equal(r.status, 'completed');
      assert.equal(r.prev_status, 'processing');
    });

    it('processing → failed', () => {
      db.ackMessage('msg_t', { status: 'processing' });
      const r = db.ackMessage('msg_t', { status: 'failed', reason: 'timeout' });
      assert.equal(r.status, 'failed');
      assert.equal(r.prev_status, 'processing');
    });

    it('default status is completed (backward compat)', () => {
      const r = db.ackMessage('msg_t');
      assert.equal(r.status, 'completed');
    });

    it('completed → * returns ALREADY_COMPLETED', () => {
      db.ackMessage('msg_t', { status: 'completed' });
      const r = db.ackMessage('msg_t', { status: 'processing' });
      assert.equal(r.status, 'ALREADY_COMPLETED');
    });

    it('failed → * returns ALREADY_FAILED', () => {
      db.ackMessage('msg_t', { status: 'failed', reason: 'err' });
      const r = db.ackMessage('msg_t', { status: 'completed' });
      assert.equal(r.status, 'ALREADY_FAILED');
    });

    it('queued → processing returns INVALID_TRANSITION', () => {
      db.insertMessage({
        msg_id: 'msg_q', from_agent: 'a', to_agent: 'b',
        type: 'task', priority: 'P1', content: 'x',
        created_at: new Date().toISOString()
      });
      const r = db.ackMessage('msg_q', { status: 'processing' });
      assert.equal(r.status, 'INVALID_TRANSITION');
    });

    it('nonexistent msg returns null', () => {
      const r = db.ackMessage('msg_nope');
      assert.equal(r, null);
    });

    it('truncates result > 2KB', () => {
      const longResult = 'x'.repeat(3000);
      const r = db.ackMessage('msg_t', { status: 'completed', result: longResult });
      assert.equal(r.status, 'completed');
      assert.ok(Buffer.byteLength(r.result, 'utf8') <= 2048);
      assert.ok(r.result.endsWith('...'));
    });

    it('truncates reason > 2KB', () => {
      const longReason = '错'.repeat(1500);
      const r = db.ackMessage('msg_t', { status: 'failed', reason: longReason });
      assert.equal(r.status, 'failed');
      assert.ok(Buffer.byteLength(r.fail_reason, 'utf8') <= 2048);
      assert.ok(r.fail_reason.endsWith('...'));
    });

    it('invalid status returns INVALID_STATUS', () => {
      const r = db.ackMessage('msg_t', { status: 'bogus' });
      assert.equal(r.status, 'INVALID_STATUS');
    });
  });

  describe('ackMessage terminal states', () => {
    it('expired → * returns MSG_EXPIRED', () => {
      db.insertMessage({
        msg_id: 'msg_exp', from_agent: 'a', to_agent: 'b',
        type: 'task', priority: 'P1', content: 'x',
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
      });
      db.getDb().prepare("UPDATE messages SET status = 'expired', expired_at = ? WHERE msg_id = ?")
        .run(new Date().toISOString(), 'msg_exp');
      const r = db.ackMessage('msg_exp', { status: 'completed' });
      assert.equal(r.status, 'MSG_EXPIRED');
    });

    it('dead_letter → * returns MSG_DEAD_LETTER', () => {
      db.insertMessage({
        msg_id: 'msg_dl', from_agent: 'a', to_agent: 'b',
        type: 'task', priority: 'P1', content: 'x',
        created_at: new Date().toISOString()
      });
      db.getDb().prepare("UPDATE messages SET status = 'dead_letter' WHERE msg_id = ?")
        .run('msg_dl');
      const r = db.ackMessage('msg_dl', { status: 'completed' });
      assert.equal(r.status, 'MSG_DEAD_LETTER');
    });
  });

  describe('revertTimedOut', () => {
    it('reverts processing messages after timeout', () => {
      db.insertMessage({
        msg_id: 'msg_to', from_agent: 'a', to_agent: 'b',
        type: 'task', priority: 'P1', content: 'x',
        created_at: new Date().toISOString()
      });
      db.readMessages('b', null, null, 10);
      db.ackMessage('msg_to', { status: 'processing' });

      db.getDb().prepare("UPDATE messages SET processing_at = ? WHERE msg_id = ?")
        .run(new Date(Date.now() - 15 * 60 * 1000).toISOString(), 'msg_to');

      const result = db.revertTimedOut(10);
      assert.equal(result.reverted, 1);
      const msg = db.getMessageStatus('msg_to');
      assert.equal(msg.status, 'queued');
      assert.equal(msg.retry_count, 1);
    });
  });

  describe('cleanExpired v1.1', () => {
    it('deletes completed messages older than 7 days', () => {
      db.insertMessage({
        msg_id: 'msg_old', from_agent: 'a', to_agent: 'b',
        type: 'task', priority: 'P1', content: 'x',
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      });
      db.readMessages('b', null, null, 10);
      db.ackMessage('msg_old', { status: 'completed' });
      db.getDb().prepare("UPDATE messages SET completed_at = ? WHERE msg_id = ?")
        .run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), 'msg_old');

      const result = db.cleanExpired();
      assert.equal(result.deletedCompleted, 1);
    });

    it('deletes failed messages older than 7 days', () => {
      db.insertMessage({
        msg_id: 'msg_fail', from_agent: 'a', to_agent: 'b',
        type: 'task', priority: 'P1', content: 'x',
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      });
      db.readMessages('b', null, null, 10);
      db.ackMessage('msg_fail', { status: 'failed', reason: 'err' });
      db.getDb().prepare("UPDATE messages SET failed_at = ? WHERE msg_id = ?")
        .run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), 'msg_fail');

      const result = db.cleanExpired();
      assert.equal(result.deletedFailed, 1);
    });

    it('expires delivered task messages older than 2h', () => {
      db.insertMessage({
        msg_id: 'msg_stale', from_agent: 'a', to_agent: 'b',
        type: 'task', priority: 'P1', content: 'x',
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      });
      db.readMessages('b', null, null, 10);
      db.getDb().prepare("UPDATE messages SET delivered_at = ? WHERE msg_id = ?")
        .run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), 'msg_stale');

      const result = db.cleanExpired();
      assert.equal(result.expiredDeliveredTasks, 1);
      const msg = db.getMessageStatus('msg_stale');
      assert.equal(msg.status, 'expired');
    });

    it('does NOT expire auto-completed notify messages (v1.2: auto-ack)', () => {
      db.insertMessage({
        msg_id: 'msg_notify', from_agent: 'a', to_agent: 'b',
        type: 'notify', priority: 'P2', content: 'info',
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      });
      db.readMessages('b', null, null, 10);

      // v1.2: notify is auto-completed on read, not delivered
      const msg = db.getMessageStatus('msg_notify');
      assert.equal(msg.status, 'completed');

      // cleanExpired should not touch completed messages (only 7-day cleanup)
      const result = db.cleanExpired();
      assert.equal(result.expiredDeliveredTasks, 0);
    });
  });

  describe('getMetrics v1.1', () => {
    it('includes completed and failed counts', () => {
      const now = new Date().toISOString();
      db.insertMessage({ msg_id: 'm1', from_agent: 'a', to_agent: 'b', type: 'task', priority: 'P1', content: 'x', created_at: now });
      db.insertMessage({ msg_id: 'm2', from_agent: 'a', to_agent: 'b', type: 'task', priority: 'P1', content: 'y', created_at: now });
      db.insertMessage({ msg_id: 'm3', from_agent: 'a', to_agent: 'b', type: 'task', priority: 'P1', content: 'z', created_at: now });
      db.readMessages('b', null, null, 10);
      db.ackMessage('m1', { status: 'completed' });
      db.ackMessage('m2', { status: 'failed', reason: 'err' });

      const metrics = db.getMetrics();
      assert.equal(metrics.completed, 1);
      assert.equal(metrics.failed, 1);
      assert.equal(metrics.delivered, 1);
      assert.equal(metrics.total, 3);
    });
  });

  describe('countThreadMessages', () => {
    it('counts messages with same ref', () => {
      const now = new Date().toISOString();
      db.insertMessage({ msg_id: 't1', from_agent: 'a', to_agent: 'b', type: 'discuss', priority: 'P2', content: 'x', ref: 'thread-1', created_at: now });
      db.insertMessage({ msg_id: 't2', from_agent: 'b', to_agent: 'a', type: 'discuss', priority: 'P2', content: 'y', ref: 'thread-1', created_at: now });
      assert.equal(db.countThreadMessages('thread-1'), 2);
      assert.equal(db.countThreadMessages('thread-2'), 0);
    });
  });

  describe('findStaleMessages v1.1.2', () => {
    it('returns delivered/processing task messages', () => {
      const now = new Date().toISOString();
      db.insertMessage({ msg_id: 'stale1', from_agent: 'main', to_agent: 'ops', type: 'task', priority: 'P1', content: 'do it', created_at: now });
      db.insertMessage({ msg_id: 'stale2', from_agent: 'main', to_agent: 'intel', type: 'task', priority: 'P0', content: 'urgent', created_at: now });
      db.insertMessage({ msg_id: 'notify1', from_agent: 'main', to_agent: 'ops', type: 'notify', priority: 'P2', content: 'info', created_at: now });
      db.readMessages('ops', null, null, 10);
      db.readMessages('intel', null, null, 10);

      const stale = db.findStaleMessages();
      // should include 2 task messages, not the notify
      assert.equal(stale.length, 2);
      const ids = stale.map(m => m.msg_id).sort();
      assert.deepEqual(ids, ['stale1', 'stale2']);
    });

    it('does not return completed/failed tasks', () => {
      const now = new Date().toISOString();
      db.insertMessage({ msg_id: 'done1', from_agent: 'a', to_agent: 'b', type: 'task', priority: 'P1', content: 'x', created_at: now });
      db.insertMessage({ msg_id: 'fail1', from_agent: 'a', to_agent: 'b', type: 'task', priority: 'P1', content: 'y', created_at: now });
      db.readMessages('b', null, null, 10);
      db.ackMessage('done1', { status: 'completed' });
      db.ackMessage('fail1', { status: 'failed', reason: 'err' });

      const stale = db.findStaleMessages();
      assert.equal(stale.length, 0);
    });

    it('includes priority field for threshold filtering', () => {
      const now = new Date().toISOString();
      db.insertMessage({ msg_id: 'p0task', from_agent: 'a', to_agent: 'b', type: 'task', priority: 'P0', content: 'x', created_at: now });
      db.readMessages('b', null, null, 10);

      const stale = db.findStaleMessages();
      assert.equal(stale.length, 1);
      assert.equal(stale[0].priority, 'P0');
    });
  });

  describe('heartbeat (processing → processing refresh)', () => {
    it('refreshes processing_at on re-ack processing', () => {
      const now = new Date().toISOString();
      db.insertMessage({ msg_id: 'hb1', from_agent: 'a', to_agent: 'b', type: 'task', priority: 'P1', content: 'x', created_at: now });
      db.readMessages('b', null, null, 10);
      db.ackMessage('hb1', { status: 'processing' });

      const msg1 = db.getMessageStatus('hb1');
      const firstProcessingAt = msg1.processing_at;

      // Simulate time passing then heartbeat
      db.getDb().prepare("UPDATE messages SET processing_at = ? WHERE msg_id = ?")
        .run(new Date(Date.now() - 5 * 60 * 1000).toISOString(), 'hb1');

      const r = db.ackMessage('hb1', { status: 'processing' });
      assert.equal(r.status, 'processing');
      assert.equal(r.prev_status, 'processing');

      const msg2 = db.getMessageStatus('hb1');
      assert.notEqual(msg2.processing_at, new Date(Date.now() - 5 * 60 * 1000).toISOString());
    });
  });
});
