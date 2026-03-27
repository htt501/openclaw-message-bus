/**
 * Property-based tests for smart thread round counting (v3)
 * Properties 1 & 2 from design document
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createTestDb } from '../helpers/db.js';
import { createBusSend } from '../../src/tools/bus_send.js';
import { setAgents, MAX_THREAD_ROUNDS } from '../../src/schema.js';

const ACTIONABLE_TYPES = ['task', 'request', 'discuss', 'escalation'];
const NON_ACTIONABLE_TYPES = ['response', 'notify'];
const ALL_TYPES = [...ACTIONABLE_TYPES, ...NON_ACTIONABLE_TYPES];

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };

/**
 * Property 1: Smart thread round counting
 * **Validates: Requirements 2.1, 2.2, 2.5**
 *
 * For any mix of message types in a thread, countThreadRounds(ref) equals
 * the count of messages where type IN actionable types. Messages with
 * type IN (response, notify) are never included, and the result is always >= 0.
 */
describe('Property 1: Smart thread round counting', () => {
  it('countThreadRounds equals count of actionable-type messages for any mix', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom(...ALL_TYPES),
            from: fc.constantFrom('main', 'ops'),
            to: fc.constantFrom('main', 'ops'),
          }),
          { minLength: 0, maxLength: 20 }
        ),
        (messages) => {
          const db = createTestDb();
          const threadRef = 'prop-test-ref';
          const now = new Date().toISOString();

          for (let i = 0; i < messages.length; i++) {
            db.insertMessage({
              msg_id: `msg_prop_${i}`,
              from_agent: messages[i].from,
              to_agent: messages[i].to,
              type: messages[i].type,
              priority: 'P2',
              content: `content ${i}`,
              ref: threadRef,
              created_at: now,
            });
          }

          const expectedActionable = messages.filter(m =>
            ACTIONABLE_TYPES.includes(m.type)
          ).length;

          const actualRounds = db.countThreadRounds(threadRef);

          // Property: countThreadRounds equals count of actionable types
          assert.equal(actualRounds, expectedActionable);
          // Property: result is always non-negative
          assert.ok(actualRounds >= 0);
          // Property: countThreadRounds <= countThreadMessages
          assert.ok(actualRounds <= db.countThreadMessages(threadRef));
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 2: Round limit enforcement on actionable types only
 * **Validates: Requirements 2.3, 2.4**
 *
 * For any thread that has reached MAX_THREAD_ROUNDS actionable messages,
 * sending an additional Actionable_Type returns ROUND_LIMIT error,
 * while sending a Non_Actionable_Type (response, notify) succeeds
 * regardless of the thread round count.
 */
describe('Property 2: Round limit enforcement on actionable types only', () => {
  it('actionable types are blocked at MAX_THREAD_ROUNDS; non-actionable types always pass', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // Number of actionable messages already in thread (at or above limit)
          existingActionable: fc.integer({ min: MAX_THREAD_ROUNDS, max: MAX_THREAD_ROUNDS + 5 }),
          // Number of non-actionable messages already in thread (noise)
          existingNonActionable: fc.integer({ min: 0, max: 10 }),
          // The type of the new message being sent
          newType: fc.constantFrom(...ALL_TYPES),
        }),
        async ({ existingActionable, existingNonActionable, newType }) => {
          const db = createTestDb();
          setAgents(['main', 'ops']);

          const send = createBusSend(db, {}, logger, { enabled: false })({ agentId: 'main' });

          // Seed the thread with the first actionable message (this creates the thread ref)
          const firstResult = await send.execute('tc0', {
            to: 'ops', content: 'start', type: 'task', priority: 'P2'
          });
          const firstParsed = JSON.parse(firstResult.content[0].text);
          const threadRef = firstParsed.ref;
          const firstMsgId = firstParsed.msg_id;

          // Insert remaining actionable messages directly into DB
          const now = new Date().toISOString();
          for (let i = 1; i < existingActionable; i++) {
            const aType = ACTIONABLE_TYPES[i % ACTIONABLE_TYPES.length];
            db.insertMessage({
              msg_id: `msg_act_${i}`,
              from_agent: i % 2 === 0 ? 'main' : 'ops',
              to_agent: i % 2 === 0 ? 'ops' : 'main',
              type: aType,
              priority: 'P2',
              content: `actionable ${i}`,
              ref: threadRef,
              reply_to: firstMsgId,
              created_at: now,
            });
          }

          // Insert non-actionable messages (should not affect round count)
          for (let i = 0; i < existingNonActionable; i++) {
            const naType = NON_ACTIONABLE_TYPES[i % NON_ACTIONABLE_TYPES.length];
            db.insertMessage({
              msg_id: `msg_na_${i}`,
              from_agent: i % 2 === 0 ? 'ops' : 'main',
              to_agent: i % 2 === 0 ? 'main' : 'ops',
              type: naType,
              priority: 'P2',
              content: `non-actionable ${i}`,
              ref: threadRef,
              reply_to: firstMsgId,
              created_at: now,
            });
          }

          // Verify the thread has the expected actionable count
          assert.equal(db.countThreadRounds(threadRef), existingActionable);

          // Now send a new message in this thread
          const opsSend = createBusSend(db, {}, logger, { enabled: false })({ agentId: 'ops' });
          const result = await opsSend.execute('tc_new', {
            to: 'main',
            content: 'new message',
            type: newType,
            reply_to: firstMsgId,
          });
          const parsed = JSON.parse(result.content[0].text);

          if (ACTIONABLE_TYPES.includes(newType)) {
            // Property: actionable types MUST be blocked when at/above limit
            assert.equal(parsed.error, 'ROUND_LIMIT',
              `Expected ROUND_LIMIT for actionable type '${newType}' with ${existingActionable} rounds`);
          } else {
            // Property: non-actionable types MUST succeed regardless of round count
            assert.ok(parsed.msg_id,
              `Expected success for non-actionable type '${newType}' with ${existingActionable} rounds`);
            assert.equal(parsed.status, 'queued');
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
