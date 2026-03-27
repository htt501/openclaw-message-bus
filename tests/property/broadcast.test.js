/**
 * Property-based tests for broadcast support (v3)
 * Properties 3, 5, 9 from design document
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createTestDb } from '../helpers/db.js';
import { createBusSend } from '../../src/tools/bus_send.js';
import { setAgents } from '../../src/schema.js';

const AGENT_POOL = ['main', 'ops', 'creator', 'intel', 'strategist', 'chichi', 'secretary'];
const VALID_TYPES = ['task', 'discuss', 'notify', 'request', 'response', 'escalation'];
const VALID_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };

/**
 * Property 3: Broadcast produces correct message set
 * **Validates: Requirements 3.1, 3.2, 3.7**
 *
 * For any broadcast to N unique target agents, exactly N messages are inserted
 * into the database, each with a unique msg_id, all sharing the same ref value,
 * and the result contains a messages array of length N with per-target status,
 * the shared ref, and broadcast set to true.
 */
describe('Property 3: Broadcast produces correct message set', () => {
  it('broadcast to N unique targets produces N messages with shared ref', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // Pick 1-6 unique targets from the pool (excluding sender 'main')
          targets: fc.uniqueArray(
            fc.constantFrom('ops', 'creator', 'intel', 'strategist', 'chichi', 'secretary'),
            { minLength: 1, maxLength: 6 }
          ),
          content: fc.string({ minLength: 1, maxLength: 100 }),
          type: fc.constantFrom(...VALID_TYPES),
          priority: fc.constantFrom(...VALID_PRIORITIES),
        }),
        async ({ targets, content, type, priority }) => {
          const db = createTestDb();
          setAgents(AGENT_POOL);
          const send = createBusSend(db, {}, logger, { enabled: false })({ agentId: 'main' });

          const result = await send.execute('tc1', {
            to: targets,
            content,
            type,
            priority
          });
          const parsed = JSON.parse(result.content[0].text);

          // Property: broadcast flag is true
          assert.equal(parsed.broadcast, true);

          // Property: messages array length equals number of unique targets
          assert.equal(parsed.messages.length, targets.length);

          // Property: shared ref exists
          assert.ok(parsed.ref);

          // Property: each message has unique msg_id
          const msgIds = parsed.messages.map(m => m.msg_id);
          assert.equal(new Set(msgIds).size, targets.length);

          // Property: each target appears exactly once
          const resultTargets = parsed.messages.map(m => m.to).sort();
          assert.deepEqual(resultTargets, [...targets].sort());

          // Property: each message has status 'queued'
          for (const m of parsed.messages) {
            assert.equal(m.status, 'queued');
          }

          // Property: all DB messages share the same ref
          for (const m of parsed.messages) {
            const dbMsg = db.getMessageStatus(m.msg_id);
            assert.ok(dbMsg);
            assert.equal(dbMsg.ref, parsed.ref);
            assert.equal(dbMsg.to_agent, m.to);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

/**
 * Property 5: Backward compatibility for single-target sends
 * **Validates: Requirements 6.1, 6.2, 6.3**
 *
 * For any bus_send call where the `to` parameter is a single string,
 * the response contains the fields msg_id, status, ref, and round —
 * identical to the v1.x response format — and exactly one message
 * is inserted into the database.
 */
describe('Property 5: Backward compatibility for single-target sends', () => {
  it('single string to returns v1.x format with exactly one DB message', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          target: fc.constantFrom('ops', 'creator', 'intel', 'strategist', 'chichi', 'secretary'),
          content: fc.string({ minLength: 1, maxLength: 100 }),
          type: fc.constantFrom(...VALID_TYPES),
          priority: fc.constantFrom(...VALID_PRIORITIES),
        }),
        async ({ target, content, type, priority }) => {
          const db = createTestDb();
          setAgents(AGENT_POOL);
          const send = createBusSend(db, {}, logger, { enabled: false })({ agentId: 'main' });

          const result = await send.execute('tc1', {
            to: target,
            content,
            type,
            priority
          });
          const parsed = JSON.parse(result.content[0].text);

          // Property: v1.x response format fields present
          assert.ok(parsed.msg_id, 'msg_id must be present');
          assert.equal(parsed.status, 'queued', 'status must be queued');
          assert.ok(parsed.ref, 'ref must be present');
          assert.equal(typeof parsed.round, 'number', 'round must be a number');

          // Property: broadcast fields must NOT be present
          assert.equal(parsed.broadcast, undefined, 'broadcast must not be present');
          assert.equal(parsed.messages, undefined, 'messages must not be present');

          // Property: exactly one message in DB
          const dbMsg = db.getMessageStatus(parsed.msg_id);
          assert.ok(dbMsg, 'message must exist in DB');
          assert.equal(dbMsg.to_agent, target);
          assert.equal(dbMsg.status, 'queued');
        }
      ),
      { numRuns: 50 }
    );
  });
});

/**
 * Property 9: Broadcast deduplication
 * **Validates: Requirement 10.3**
 *
 * For any broadcast where the `to` array contains duplicate agent IDs,
 * the Message_Bus deduplicates targets before processing, resulting in
 * one message per unique agent ID.
 */
describe('Property 9: Broadcast deduplication', () => {
  it('duplicate targets are deduplicated to one message per unique agent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // Generate an array with guaranteed duplicates
          baseTargets: fc.uniqueArray(
            fc.constantFrom('ops', 'creator', 'intel', 'strategist', 'chichi', 'secretary'),
            { minLength: 1, maxLength: 4 }
          ),
          // How many times to repeat each target (1-3 extra copies)
          repeatCount: fc.integer({ min: 1, max: 3 }),
          content: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        async ({ baseTargets, repeatCount, content }) => {
          const db = createTestDb();
          setAgents(AGENT_POOL);
          const send = createBusSend(db, {}, logger, { enabled: false })({ agentId: 'main' });

          // Create array with duplicates
          const targetsWithDups = [];
          for (const t of baseTargets) {
            for (let i = 0; i <= repeatCount; i++) {
              targetsWithDups.push(t);
            }
          }

          const result = await send.execute('tc1', {
            to: targetsWithDups,
            content,
            type: 'notify'
          });
          const parsed = JSON.parse(result.content[0].text);

          const uniqueTargets = [...new Set(targetsWithDups)];

          // Property: message count equals unique target count (not total with dups)
          assert.equal(parsed.messages.length, uniqueTargets.length,
            `Expected ${uniqueTargets.length} messages for ${uniqueTargets.length} unique targets, got ${parsed.messages.length}`);

          // Property: each unique target appears exactly once
          const resultTargets = parsed.messages.map(m => m.to).sort();
          assert.deepEqual(resultTargets, uniqueTargets.sort());

          // Property: broadcast flag is true
          assert.equal(parsed.broadcast, true);
        }
      ),
      { numRuns: 50 }
    );
  });
});
