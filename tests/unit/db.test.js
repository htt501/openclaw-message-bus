import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../helpers/db.js';

describe('Database Schema', () => {
  let dbOps;

  beforeEach(() => {
    dbOps = createTestDb();
  });

  it('should create messages table with all 16 fields', () => {
    const db = dbOps.getDb();
    const columns = db.prepare("PRAGMA table_info(messages)").all();
    const columnNames = columns.map(c => c.name);

    const expected = [
      'msg_id', 'from_agent', 'to_agent', 'type', 'priority',
      'content', 'ref', 'reply_to', 'status', 'retry_count',
      'max_retries', 'last_error', 'created_at', 'processing_at',
      'delivered_at', 'expired_at'
    ];

    assert.equal(columns.length, 16);
    for (const name of expected) {
      assert.ok(columnNames.includes(name), `missing column: ${name}`);
    }
  });

  it('should have correct default values', () => {
    const db = dbOps.getDb();
    const columns = db.prepare("PRAGMA table_info(messages)").all();
    const byName = Object.fromEntries(columns.map(c => [c.name, c]));

    assert.equal(byName.type.dflt_value, "'notify'");
    assert.equal(byName.priority.dflt_value, "'P2'");
    assert.equal(byName.status.dflt_value, "'queued'");
    assert.equal(byName.retry_count.dflt_value, '0');
    assert.equal(byName.max_retries.dflt_value, '3');
  });

  it('should have NOT NULL constraints on required fields', () => {
    const db = dbOps.getDb();
    const columns = db.prepare("PRAGMA table_info(messages)").all();
    const byName = Object.fromEntries(columns.map(c => [c.name, c]));

    assert.equal(byName.from_agent.notnull, 1);
    assert.equal(byName.to_agent.notnull, 1);
    assert.equal(byName.content.notnull, 1);
    assert.equal(byName.created_at.notnull, 1);
  });

  it('should create all 3 indexes', () => {
    const db = dbOps.getDb();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all();
    const indexNames = indexes.map(i => i.name);

    assert.ok(indexNames.includes('idx_to_status'), 'missing idx_to_status');
    assert.ok(indexNames.includes('idx_type'), 'missing idx_type');
    assert.ok(indexNames.includes('idx_created'), 'missing idx_created');
  });
});

describe('Database Operations', () => {
  let dbOps;

  beforeEach(() => {
    dbOps = createTestDb();
  });

  describe('insertMessage', () => {
    it('should insert a message with queued status', () => {
      dbOps.insertMessage({
        msg_id: 'msg_main_1000_abcd',
        from_agent: 'main',
        to_agent: 'ops',
        type: 'task',
        priority: 'P1',
        content: 'hello',
        created_at: new Date().toISOString()
      });

      const msg = dbOps.getMessageStatus('msg_main_1000_abcd');
      assert.equal(msg.status, 'queued');
      assert.equal(msg.from_agent, 'main');
      assert.equal(msg.to_agent, 'ops');
      assert.equal(msg.type, 'task');
      assert.equal(msg.priority, 'P1');
      assert.equal(msg.content, 'hello');
    });
  });

  describe('readMessages', () => {
    it('should atomically read and mark messages as delivered', () => {
      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001',
        from_agent: 'main',
        to_agent: 'ops',
        type: 'notify',
        priority: 'P2',
        content: 'msg1',
        created_at: new Date().toISOString()
      });

      const messages = dbOps.readMessages('ops', null, null, 10);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].msg_id, 'msg_main_1000_0001');

      // Verify status changed to delivered directly
      const msg = dbOps.getMessageStatus('msg_main_1000_0001');
      assert.equal(msg.status, 'delivered');
      assert.ok(msg.delivered_at);
    });

    it('should filter by from_agent', () => {
      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'from main',
        created_at: new Date().toISOString()
      });
      dbOps.insertMessage({
        msg_id: 'msg_creator_1000_0002', from_agent: 'creator', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'from creator',
        created_at: new Date().toISOString()
      });

      const messages = dbOps.readMessages('ops', 'main', null, 10);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].from_agent, 'main');
    });

    it('should respect limit', () => {
      for (let i = 0; i < 5; i++) {
        dbOps.insertMessage({
          msg_id: `msg_main_1000_000${i}`, from_agent: 'main', to_agent: 'ops',
          type: 'notify', priority: 'P2', content: `msg${i}`,
          created_at: new Date().toISOString()
        });
      }

      const messages = dbOps.readMessages('ops', null, null, 3);
      assert.equal(messages.length, 3);
    });

    it('should select by priority (P0 before P2) when limit constrains', () => {
      const base = Date.now();
      dbOps.insertMessage({
        msg_id: 'msg_main_1000_p2', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'low',
        created_at: new Date(base).toISOString()
      });
      dbOps.insertMessage({
        msg_id: 'msg_main_1001_p0', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P0', content: 'urgent',
        created_at: new Date(base + 1).toISOString()
      });

      // With limit=1, only the P0 message should be selected
      const messages = dbOps.readMessages('ops', null, null, 1);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].msg_id, 'msg_main_1001_p0');
    });
  });

  describe('ackMessage', () => {
    it('should transition processing to delivered', () => {
      const db = dbOps.getDb();
      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'test',
        created_at: new Date().toISOString()
      });
      // Manually set to processing (since readMessages now marks delivered directly)
      db.prepare("UPDATE messages SET status = 'processing', processing_at = ? WHERE msg_id = ?")
        .run(new Date().toISOString(), 'msg_main_1000_0001');

      const result = dbOps.ackMessage('msg_main_1000_0001');
      assert.equal(result.status, 'delivered');

      const msg = dbOps.getMessageStatus('msg_main_1000_0001');
      assert.equal(msg.status, 'delivered');
      assert.ok(msg.delivered_at);
    });

    it('should return ALREADY_ACKED for delivered messages', () => {
      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'test',
        created_at: new Date().toISOString()
      });
      // readMessages marks as delivered directly
      dbOps.readMessages('ops', null, null, 10);

      const result = dbOps.ackMessage('msg_main_1000_0001');
      assert.equal(result.status, 'ALREADY_ACKED');
    });

    it('should return null for non-existent msg_id', () => {
      const result = dbOps.ackMessage('msg_nonexistent_0000_0000');
      assert.equal(result, null);
    });
  });

  describe('revertTimedOut', () => {
    it('should revert timed-out processing messages to queued', () => {
      const db = dbOps.getDb();
      const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();

      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'test',
        created_at: new Date().toISOString()
      });

      // Manually set to processing with old timestamp
      db.prepare("UPDATE messages SET status = 'processing', processing_at = ? WHERE msg_id = ?")
        .run(oldTime, 'msg_main_1000_0001');

      const result = dbOps.revertTimedOut(10);
      assert.equal(result.reverted, 1);

      const msg = dbOps.getMessageStatus('msg_main_1000_0001');
      assert.equal(msg.status, 'queued');
      assert.equal(msg.retry_count, 1);
    });

    it('should mark as dead_letter when retry_count >= max_retries', () => {
      const db = dbOps.getDb();
      const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();

      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'test',
        created_at: new Date().toISOString()
      });

      db.prepare("UPDATE messages SET status = 'processing', processing_at = ?, retry_count = 3 WHERE msg_id = ?")
        .run(oldTime, 'msg_main_1000_0001');

      const result = dbOps.revertTimedOut(10);
      assert.equal(result.deadLettered, 1);

      const msg = dbOps.getMessageStatus('msg_main_1000_0001');
      assert.equal(msg.status, 'dead_letter');
    });
  });

  describe('cleanExpired', () => {
    it('should delete delivered messages older than 7 days', () => {
      const db = dbOps.getDb();
      const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'test',
        created_at: oldTime
      });

      db.prepare("UPDATE messages SET status = 'delivered', delivered_at = ? WHERE msg_id = ?")
        .run(oldTime, 'msg_main_1000_0001');

      const result = dbOps.cleanExpired();
      assert.equal(result.deletedDelivered, 1);
      assert.equal(dbOps.getMessageStatus('msg_main_1000_0001'), undefined);
    });

    it('should expire queued messages older than 24h', () => {
      const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'test',
        created_at: oldTime
      });

      const result = dbOps.cleanExpired();
      assert.equal(result.expiredQueued, 1);

      const msg = dbOps.getMessageStatus('msg_main_1000_0001');
      assert.equal(msg.status, 'expired');
      assert.ok(msg.expired_at);
    });
  });

  describe('getMetrics', () => {
    it('should return correct counts for empty database', () => {
      const metrics = dbOps.getMetrics();
      assert.equal(metrics.total, 0);
      assert.equal(metrics.queued, 0);
      assert.equal(metrics.processing, 0);
      assert.equal(metrics.delivered, 0);
      assert.equal(metrics.dead_letter, 0);
      assert.equal(metrics.expired, 0);
    });

    it('should count messages by status', () => {
      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0001', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'test1',
        created_at: new Date().toISOString()
      });
      dbOps.insertMessage({
        msg_id: 'msg_main_1000_0002', from_agent: 'main', to_agent: 'ops',
        type: 'notify', priority: 'P2', content: 'test2',
        created_at: new Date().toISOString()
      });

      const metrics = dbOps.getMetrics();
      assert.equal(metrics.total, 2);
      assert.equal(metrics.queued, 2);
    });
  });
});
