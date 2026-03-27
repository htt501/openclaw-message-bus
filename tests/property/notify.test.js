/**
 * Property-based tests for push notify module (v3)
 * Properties 4, 6, 8, 10 from design document
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pushNotify, _resetCooldowns, _getCooldowns } from '../../src/notify.js';
import { getSessionStorePath } from '../../src/session-resolver.js';

// Shared logger mock (captures calls but doesn't assert on them)
const logCalls = [];
const logger = {
  info: (...args) => logCalls.push(['info', ...args]),
  warn: (...args) => logCalls.push(['warn', ...args]),
  error: (...args) => logCalls.push(['error', ...args]),
};

/**
 * Property 4: No garbage sessions
 * **Validates: Requirements 1.2, 1.4, 5.1, 5.2**
 *
 * For any push notify call when sessionAware is true, the spawned CLI command
 * uses `--session-id <id>` and never contains the `--agent` flag.
 * If no session is found, no CLI process is spawned at all.
 *
 * We verify this by checking the return contract: when notified=true,
 * method is 'session-aware' (meaning --session-id was used).
 * When notified=false, no process was spawned.
 * The pushNotify function never uses --agent flag by design.
 */
describe('Property 4: No garbage sessions', () => {
  const testAgentId = `pbt4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let sessionDir;

  beforeEach(() => {
    _resetCooldowns();
    logCalls.length = 0;
    const storePath = getSessionStorePath(testAgentId);
    sessionDir = join(storePath, '..');
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  });

  it('when session exists, method is always session-aware (never --agent)', () => {
    fc.assert(
      fc.property(
        fc.record({
          sessionId: fc.uuid(),
          msgId: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          fromAgent: fc.constantFrom('main', 'ops', 'creator'),
          timeout: fc.integer({ min: 10, max: 300 }),
        }),
        ({ sessionId, msgId, fromAgent, timeout }) => {
          _resetCooldowns();

          const sessions = {
            'agent:test:feishu:group:oc_abc': {
              sessionId,
              updatedAt: Date.now()
            }
          };
          writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

          const result = pushNotify({
            targetAgent: testAgentId,
            msgId,
            fromAgent,
            notifyConfig: { enabled: true, timeoutSeconds: timeout },
            logger
          });

          // Property: if notified, method must be 'session-aware' (uses --session-id)
          if (result.notified) {
            assert.equal(result.method, 'session-aware',
              'Notified calls must use session-aware method (--session-id), never --agent');
            assert.equal(result.sessionId, sessionId);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('when no session exists, no process is spawned (notified=false)', () => {
    fc.assert(
      fc.property(
        fc.record({
          agentSuffix: fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-z0-9]+$/.test(s)),
          msgId: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        }),
        ({ agentSuffix, msgId }) => {
          _resetCooldowns();

          // Use a nonexistent agent (no session store file)
          const noSessionAgent = `nosess-${agentSuffix}-${Date.now()}`;
          const result = pushNotify({
            targetAgent: noSessionAgent,
            msgId,
            fromAgent: 'main',
            notifyConfig: { enabled: true },
            logger
          });

          // Property: no session → not notified, no process spawned
          assert.equal(result.notified, false);
          assert.equal(result.reason, 'no_session');
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Property 6: Cooldown consistency
 * **Validates: Requirements 7.2, 7.3, 7.4**
 *
 * For any agent, if two push notifications are requested within 30 seconds,
 * only the first notification is sent and the second is skipped.
 * During broadcast, each target agent's cooldown is evaluated independently.
 */
describe('Property 6: Cooldown consistency', () => {
  const baseAgentId = `pbt6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let sessionDir;

  beforeEach(() => {
    _resetCooldowns();
    logCalls.length = 0;
    const storePath = getSessionStorePath(baseAgentId);
    sessionDir = join(storePath, '..');
    mkdirSync(sessionDir, { recursive: true });

    const sessions = {
      'session-a': { sessionId: 'sess-cooldown', updatedAt: Date.now() }
    };
    writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));
  });

  afterEach(() => {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  });

  it('second call within cooldown is always skipped', () => {
    fc.assert(
      fc.property(
        fc.record({
          msgId1: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
          msgId2: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
          fromAgent: fc.constantFrom('main', 'ops', 'creator'),
        }),
        ({ msgId1, msgId2, fromAgent }) => {
          _resetCooldowns();

          const opts = {
            targetAgent: baseAgentId,
            fromAgent,
            notifyConfig: { enabled: true },
            logger
          };

          // First call
          const first = pushNotify({ ...opts, msgId: msgId1 });
          assert.equal(first.notified, true, 'First call should succeed');

          // Second call immediately after — must be cooldown-skipped
          const second = pushNotify({ ...opts, msgId: msgId2 });
          assert.equal(second.notified, false, 'Second call should be skipped');
          assert.equal(second.reason, 'cooldown');
        }
      ),
      { numRuns: 50 }
    );
  });

  it('different agents have independent cooldowns', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.constantFrom('agent-a', 'agent-b', 'agent-c', 'agent-d'),
          { minLength: 2, maxLength: 4 }
        ),
        (agents) => {
          _resetCooldowns();

          // Create session stores for all agents
          for (const agentId of agents) {
            const dir = join(getSessionStorePath(agentId), '..');
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              join(dir, 'sessions.json'),
              JSON.stringify({ 'sess-key': { sessionId: `sess-${agentId}`, updatedAt: Date.now() } })
            );
          }

          try {
            // Notify each agent — all should succeed (independent cooldowns)
            for (const agentId of agents) {
              const result = pushNotify({
                targetAgent: agentId,
                msgId: `msg-${agentId}`,
                fromAgent: 'main',
                notifyConfig: { enabled: true },
                logger
              });
              assert.equal(result.notified, true,
                `First notify to ${agentId} should succeed`);
            }

            // Notify each agent again — all should be cooldown-skipped
            for (const agentId of agents) {
              const result = pushNotify({
                targetAgent: agentId,
                msgId: `msg-${agentId}-2`,
                fromAgent: 'main',
                notifyConfig: { enabled: true },
                logger
              });
              assert.equal(result.notified, false,
                `Second notify to ${agentId} should be cooldown-skipped`);
              assert.equal(result.reason, 'cooldown');
            }
          } finally {
            for (const agentId of agents) {
              try { rmSync(join(getSessionStorePath(agentId), '..'), { recursive: true, force: true }); } catch {}
            }
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});


/**
 * Property 8: Preferred session key template replacement
 * **Validates: Requirement 8.3**
 *
 * For any agentId and preferredSessionKey template containing `{agentId}`,
 * the Push_Notify replaces the template variable with the actual target
 * agent ID before passing it to the Session_Resolver.
 */
describe('Property 8: Preferred session key template replacement', () => {
  it('{agentId} in preferredSessionKey is replaced with actual target agent', () => {
    fc.assert(
      fc.property(
        // Generate safe agent IDs (no path traversal chars)
        fc.string({ minLength: 1, maxLength: 20 })
          .filter(s => /^[a-z][a-z0-9-]*$/.test(s)),
        fc.string({ minLength: 1, maxLength: 30 })
          .filter(s => s.trim().length > 0 && !s.includes('{') && !s.includes('}')),
        (agentId, suffix) => {
          _resetCooldowns();

          // Create session store with a key that matches the resolved template
          const resolvedKey = `agent:${agentId}:${suffix}`;
          const dir = join(getSessionStorePath(agentId), '..');
          mkdirSync(dir, { recursive: true });

          const sessions = {
            [resolvedKey]: {
              sessionId: `sess-${agentId}`,
              updatedAt: Date.now()
            },
            'other-session': {
              sessionId: 'sess-other',
              updatedAt: 1 // very old
            }
          };
          writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessions));

          try {
            // Use template with {agentId}
            const result = pushNotify({
              targetAgent: agentId,
              msgId: 'msg-template-test',
              fromAgent: 'main',
              notifyConfig: {
                enabled: true,
                preferredSessionKey: `agent:{agentId}:${suffix}`
              },
              logger
            });

            // Property: the template was resolved and the preferred session was found
            if (result.notified) {
              assert.equal(result.sessionId, `sess-${agentId}`,
                `Template should resolve to agent:${agentId}:${suffix} and match the session`);
            }
          } finally {
            try { rmSync(dir, { recursive: true, force: true }); } catch {}
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  it('literal {agentId} is never passed unreplaced to session resolver', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 })
          .filter(s => /^[a-z][a-z0-9-]*$/.test(s)),
        (agentId) => {
          _resetCooldowns();

          const dir = join(getSessionStorePath(agentId), '..');
          mkdirSync(dir, { recursive: true });

          // Session store has a key with literal {agentId} — should NOT match
          // and a key with the resolved agentId — should match
          const sessions = {
            'agent:{agentId}:feishu:group': {
              sessionId: 'sess-literal-bad',
              updatedAt: Date.now() + 1000 // newest, would win fallback
            },
            [`agent:${agentId}:feishu:group`]: {
              sessionId: `sess-resolved-${agentId}`,
              updatedAt: Date.now()
            }
          };
          writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessions));

          try {
            const result = pushNotify({
              targetAgent: agentId,
              msgId: 'msg-literal-test',
              fromAgent: 'main',
              notifyConfig: {
                enabled: true,
                preferredSessionKey: 'agent:{agentId}:feishu:group'
              },
              logger
            });

            // Property: the resolved key is matched, not the literal {agentId} key
            if (result.notified) {
              assert.equal(result.sessionId, `sess-resolved-${agentId}`,
                'Must match the resolved key (with actual agentId), not the literal {agentId} key');
            }
          } finally {
            try { rmSync(dir, { recursive: true, force: true }); } catch {}
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Property 10: pushNotify return contract
 * **Validates: Requirement 9.4**
 *
 * For any call to pushNotify, the returned object contains `notified` (boolean)
 * and `method` (string). When notified is true, `sessionId` is present.
 * When notified is false, `reason` is present.
 */
describe('Property 10: pushNotify return contract', () => {
  it('return object always has notified (boolean) and method (string)', () => {
    fc.assert(
      fc.property(
        fc.record({
          targetAgent: fc.oneof(
            fc.constantFrom('main', 'ops', 'creator', 'intel'),
            fc.string({ minLength: 0, maxLength: 20 }),
            fc.constant('../evil'),
            fc.constant(''),
          ),
          msgId: fc.string({ minLength: 0, maxLength: 50 }),
          fromAgent: fc.string({ minLength: 0, maxLength: 20 }),
          enabled: fc.boolean(),
          preferredSessionKey: fc.oneof(
            fc.constant(null),
            fc.constant(undefined),
            fc.string({ minLength: 0, maxLength: 50 }),
            fc.constant('agent:{agentId}:feishu'),
          ),
          timeoutSeconds: fc.oneof(fc.integer({ min: 1, max: 300 }), fc.constant(undefined)),
        }),
        ({ targetAgent, msgId, fromAgent, enabled, preferredSessionKey, timeoutSeconds }) => {
          _resetCooldowns();

          const result = pushNotify({
            targetAgent,
            msgId,
            fromAgent,
            notifyConfig: { enabled, preferredSessionKey, timeoutSeconds },
            logger
          });

          // Property: result is always an object
          assert.equal(typeof result, 'object');
          assert.notEqual(result, null);

          // Property: notified is always boolean
          assert.equal(typeof result.notified, 'boolean');

          // Property: method is always string
          assert.equal(typeof result.method, 'string');

          // Property: when notified=true, sessionId is present
          if (result.notified === true) {
            assert.ok(result.sessionId !== undefined && result.sessionId !== null,
              'sessionId must be present when notified=true');
          }

          // Property: when notified=false, reason is present
          if (result.notified === false) {
            assert.ok(result.reason !== undefined && result.reason !== null,
              `reason must be present when notified=false, got method=${result.method}`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
