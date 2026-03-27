/**
 * Property-based tests for session resolver (v3)
 * Property 7 from design document
 *
 * **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8**
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentSession, getSessionStorePath } from '../../src/session-resolver.js';

/**
 * Property 7: Session resolver safety and resolution order
 * **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8**
 *
 * For any input (including missing files, invalid JSON, empty stores, and
 * path traversal attempts), resolveAgentSession() never throws an exception
 * and returns either a valid { sessionId, sessionKey } or null.
 * When a preferredSessionKey matches, that session is returned;
 * otherwise the most recently active session is returned.
 */
describe('Property 7: Session resolver safety and resolution order', () => {
  // Unique test agent for file-based tests
  const testAgentId = `pbt-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let sessionDir;

  beforeEach(() => {
    const storePath = getSessionStorePath(testAgentId);
    sessionDir = join(storePath, '..');
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  });

  it('never throws for any agentId and preferredSessionKey input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),                    // arbitrary strings
          fc.constant(''),                // empty
          fc.constant(null),              // null
          fc.constant(undefined),         // undefined
          fc.constant(123),              // number
          fc.constant('../etc/passwd'),   // path traversal
          fc.constant('foo/bar'),         // slash
          fc.constant('foo\\bar'),        // backslash
          fc.constant('..'),             // double dot
          fc.constant('valid-agent'),     // normal agent (file won't exist)
        ),
        fc.oneof(
          fc.string(),
          fc.constant(null),
          fc.constant(undefined),
        ),
        (agentId, preferredKey) => {
          // Must never throw
          let result;
          try {
            result = resolveAgentSession(agentId, preferredKey);
          } catch (err) {
            assert.fail(`resolveAgentSession threw: ${err.message}`);
          }

          // Must return null or valid { sessionId, sessionKey }
          if (result !== null) {
            assert.equal(typeof result, 'object');
            assert.ok('sessionId' in result, 'result must have sessionId');
            assert.ok('sessionKey' in result, 'result must have sessionKey');
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('path traversal agentIds always return null', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Generate strings containing path traversal characters
          fc.string().map(s => `..${s}`),
          fc.string().map(s => `${s}..${s}`),
          fc.string().map(s => `${s}/${s}`),
          fc.string().map(s => `${s}\\${s}`),
          fc.constant('../../../etc/passwd'),
          fc.constant('foo/../bar'),
          fc.constant('/absolute/path'),
          fc.constant('back\\slash'),
        ),
        (maliciousId) => {
          const result = resolveAgentSession(maliciousId, null);
          assert.equal(result, null, `Expected null for agentId="${maliciousId}"`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('preferred key match takes priority over most recent session', () => {
    // Generate session stores with multiple sessions and verify preferred key wins
    const sessionKeyArb = fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0);
    const sessionIdArb = fc.uuid();
    const timestampArb = fc.integer({ min: 1, max: 2000000000000 });

    fc.assert(
      fc.property(
        // Generate 2-5 sessions with distinct keys
        fc.array(
          fc.record({
            key: sessionKeyArb,
            sessionId: sessionIdArb,
            updatedAt: timestampArb,
          }),
          { minLength: 2, maxLength: 5 }
        ).filter(arr => {
          // Ensure unique keys
          const keys = arr.map(s => s.key);
          return new Set(keys).size === keys.length;
        }),
        fc.integer({ min: 0 }), // index to pick as preferred
        (sessionsArr, preferredIdx) => {
          // Pick one session as the "preferred" target
          const preferred = sessionsArr[preferredIdx % sessionsArr.length];

          // Build sessions object
          const sessions = {};
          for (const s of sessionsArr) {
            sessions[s.key] = { sessionId: s.sessionId, updatedAt: s.updatedAt };
          }

          writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

          const result = resolveAgentSession(testAgentId, preferred.key);
          assert.ok(result, 'Should find a session');
          assert.equal(result.sessionId, preferred.sessionId,
            'Preferred key match should return the matching session');
          assert.equal(result.sessionKey, preferred.key);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('without preferred key, returns the most recently active session', () => {
    const sessionKeyArb = fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0);
    const sessionIdArb = fc.uuid();

    fc.assert(
      fc.property(
        // Generate 2-5 sessions with distinct keys and distinct timestamps
        fc.array(
          fc.record({
            key: sessionKeyArb,
            sessionId: sessionIdArb,
            updatedAt: fc.integer({ min: 1, max: 2000000000000 }),
          }),
          { minLength: 2, maxLength: 5 }
        ).filter(arr => {
          const keys = arr.map(s => s.key);
          const timestamps = arr.map(s => s.updatedAt);
          return new Set(keys).size === keys.length && new Set(timestamps).size === timestamps.length;
        }),
        (sessionsArr) => {
          // Build sessions object
          const sessions = {};
          for (const s of sessionsArr) {
            sessions[s.key] = { sessionId: s.sessionId, updatedAt: s.updatedAt };
          }

          writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

          // Find the expected most recent
          const mostRecent = sessionsArr.reduce((a, b) => a.updatedAt > b.updatedAt ? a : b);

          const result = resolveAgentSession(testAgentId);
          assert.ok(result, 'Should find a session');
          assert.equal(result.sessionId, mostRecent.sessionId,
            'Should return the most recently active session');
          assert.equal(result.sessionKey, mostRecent.key);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('empty or invalid session stores always return null', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('{}'),           // empty object
          fc.constant('[]'),           // array
          fc.constant('null'),         // null
          fc.constant(''),             // empty string
          fc.constant('"string"'),     // string JSON
          fc.constant('42'),           // number JSON
          fc.constant('{bad json'),    // corrupted
          fc.constant('undefined'),    // not JSON
        ),
        (fileContent) => {
          writeFileSync(join(sessionDir, 'sessions.json'), fileContent);
          const result = resolveAgentSession(testAgentId);
          assert.equal(result, null, `Expected null for file content: ${fileContent}`);
        }
      ),
      { numRuns: 20 }
    );
  });
});
