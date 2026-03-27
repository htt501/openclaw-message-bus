/**
 * Unit tests for broadcast send (v3)
 * Sub-task 3.7: multiple targets, shared ref, dedup
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../helpers/db.js';
import { createBusSend } from '../../src/tools/bus_send.js';
import { setAgents } from '../../src/schema.js';

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };

describe('broadcast send', () => {
  let db, send;

  beforeEach(() => {
    db = createTestDb();
    setAgents(['main', 'ops', 'creator', 'intel', 'strategist']);
    send = createBusSend(db, {}, logger, { enabled: false })({ agentId: 'main' });
  });

  it('broadcasts to multiple targets with shared ref', async () => {
    const result = await send.execute('tc1', {
      to: ['ops', 'creator', 'intel'],
      content: 'meeting notes',
      type: 'notify'
    });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.broadcast, true);
    assert.equal(parsed.messages.length, 3);
    assert.ok(parsed.ref);

    // All messages share the same ref
    const refs = new Set(parsed.messages.map(() => parsed.ref));
    assert.equal(refs.size, 1);

    // Each message has unique msg_id and correct target
    const msgIds = parsed.messages.map(m => m.msg_id);
    assert.equal(new Set(msgIds).size, 3);

    const targets = parsed.messages.map(m => m.to);
    assert.deepEqual(targets.sort(), ['creator', 'intel', 'ops']);

    // All statuses are queued
    for (const m of parsed.messages) {
      assert.equal(m.status, 'queued');
    }
  });

  it('deduplicates targets in broadcast', async () => {
    const result = await send.execute('tc1', {
      to: ['ops', 'creator', 'ops', 'creator', 'ops'],
      content: 'dedup test',
      type: 'notify'
    });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.broadcast, true);
    assert.equal(parsed.messages.length, 2);
    const targets = parsed.messages.map(m => m.to).sort();
    assert.deepEqual(targets, ['creator', 'ops']);
  });

  it('rejects empty array with INVALID_PARAM', async () => {
    const result = await send.execute('tc1', {
      to: [],
      content: 'empty',
      type: 'notify'
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'INVALID_PARAM');
  });

  it('validates each target in broadcast against agents list', async () => {
    const result = await send.execute('tc1', {
      to: ['ops', 'nobody'],
      content: 'invalid target',
      type: 'notify'
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'INVALID_PARAM');
    assert.ok(parsed.message.includes('nobody'));
  });

  it('single string to still returns v1.x format', async () => {
    const result = await send.execute('tc1', {
      to: 'ops',
      content: 'single target',
      type: 'task',
      priority: 'P0'
    });
    const parsed = JSON.parse(result.content[0].text);

    // v1.x format: { msg_id, status, ref, round }
    assert.ok(parsed.msg_id);
    assert.equal(parsed.status, 'queued');
    assert.ok(parsed.ref);
    assert.equal(typeof parsed.round, 'number');

    // Should NOT have broadcast fields
    assert.equal(parsed.broadcast, undefined);
    assert.equal(parsed.messages, undefined);
  });

  it('broadcast messages are all inserted into DB', async () => {
    const result = await send.execute('tc1', {
      to: ['ops', 'creator', 'intel'],
      content: 'db check',
      type: 'task'
    });
    const parsed = JSON.parse(result.content[0].text);

    for (const m of parsed.messages) {
      const dbMsg = db.getMessageStatus(m.msg_id);
      assert.ok(dbMsg);
      assert.equal(dbMsg.to_agent, m.to);
      assert.equal(dbMsg.ref, parsed.ref);
      assert.equal(dbMsg.status, 'queued');
      assert.equal(dbMsg.content, 'db check');
    }
  });

  it('broadcast with custom ref uses that ref for all messages', async () => {
    const result = await send.execute('tc1', {
      to: ['ops', 'creator'],
      content: 'custom ref',
      type: 'notify',
      ref: 'my-custom-ref'
    });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.ref, 'my-custom-ref');
    for (const m of parsed.messages) {
      const dbMsg = db.getMessageStatus(m.msg_id);
      assert.equal(dbMsg.ref, 'my-custom-ref');
    }
  });
});
