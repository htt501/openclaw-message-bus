/**
 * Unit tests for pushNotify module (v3)
 * Sub-task 5.8: session found, no session, cooldown, error handling,
 *               {agentId} template replacement
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pushNotify, _resetCooldowns, _getCooldowns, COOLDOWN_MS_EXPORT } from '../../src/notify.js';
import { getSessionStorePath } from '../../src/session-resolver.js';

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };

describe('pushNotify', () => {
  const testAgentId = `notify-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let sessionDir;

  beforeEach(() => {
    _resetCooldowns();
    logger.info.mock.resetCalls();
    logger.warn.mock.resetCalls();

    const storePath = getSessionStorePath(testAgentId);
    sessionDir = join(storePath, '..');
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  });

  describe('disabled notify', () => {
    it('returns disabled when enabled is false', () => {
      const result = pushNotify({
        targetAgent: testAgentId,
        msgId: 'msg_test_001',
        fromAgent: 'main',
        notifyConfig: { enabled: false },
        logger
      });
      assert.equal(result.notified, false);
      assert.equal(result.method, 'disabled');
      assert.ok(result.reason);
    });
  });

  describe('session found', () => {
    it('returns notified=true with session-aware method when session exists', () => {
      const sessions = {
        'agent:ops:feishu:group:oc_abc': {
          sessionId: 'sess-abc-123',
          updatedAt: Date.now()
        }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = pushNotify({
        targetAgent: testAgentId,
        msgId: 'msg_test_002',
        fromAgent: 'main',
        notifyConfig: { enabled: true, timeoutSeconds: 60 },
        logger
      });

      assert.equal(result.notified, true);
      assert.equal(result.method, 'session-aware');
      assert.equal(result.sessionId, 'sess-abc-123');
    });
  });

  describe('no session', () => {
    it('returns notified=false with no_session reason when no session store', () => {
      // Remove the session dir so no file exists
      rmSync(sessionDir, { recursive: true, force: true });

      const result = pushNotify({
        targetAgent: `nonexistent-agent-${Date.now()}`,
        msgId: 'msg_test_003',
        fromAgent: 'main',
        notifyConfig: { enabled: true },
        logger
      });

      assert.equal(result.notified, false);
      assert.equal(result.method, 'skipped');
      assert.equal(result.reason, 'no_session');
    });

    it('returns no_session when session store is empty', () => {
      writeFileSync(join(sessionDir, 'sessions.json'), '{}');

      const result = pushNotify({
        targetAgent: testAgentId,
        msgId: 'msg_test_004',
        fromAgent: 'main',
        notifyConfig: { enabled: true },
        logger
      });

      assert.equal(result.notified, false);
      assert.equal(result.reason, 'no_session');
    });
  });

  describe('cooldown', () => {
    it('skips second notification within 30s cooldown', () => {
      const sessions = {
        'session-a': { sessionId: 'sess-a', updatedAt: Date.now() }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const opts = {
        targetAgent: testAgentId,
        msgId: 'msg_test_005',
        fromAgent: 'main',
        notifyConfig: { enabled: true },
        logger
      };

      // First call should succeed
      const first = pushNotify(opts);
      assert.equal(first.notified, true);

      // Second call within cooldown should be skipped
      const second = pushNotify({ ...opts, msgId: 'msg_test_006' });
      assert.equal(second.notified, false);
      assert.equal(second.method, 'skipped');
      assert.equal(second.reason, 'cooldown');
    });

    it('independent cooldown per agent', () => {
      const agentId2 = `notify-test2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionDir2 = join(getSessionStorePath(agentId2), '..');
      mkdirSync(sessionDir2, { recursive: true });

      const sessions = { 'session-a': { sessionId: 'sess-a', updatedAt: Date.now() } };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));
      writeFileSync(join(sessionDir2, 'sessions.json'), JSON.stringify(sessions));

      const baseOpts = {
        msgId: 'msg_test_007',
        fromAgent: 'main',
        notifyConfig: { enabled: true },
        logger
      };

      // Notify agent 1
      const r1 = pushNotify({ ...baseOpts, targetAgent: testAgentId });
      assert.equal(r1.notified, true);

      // Notify agent 2 — should succeed (independent cooldown)
      const r2 = pushNotify({ ...baseOpts, targetAgent: agentId2 });
      assert.equal(r2.notified, true);

      // Notify agent 1 again — should be cooldown
      const r3 = pushNotify({ ...baseOpts, targetAgent: testAgentId });
      assert.equal(r3.notified, false);
      assert.equal(r3.reason, 'cooldown');

      try { rmSync(sessionDir2, { recursive: true, force: true }); } catch {}
    });
  });

  describe('{agentId} template replacement', () => {
    it('replaces {agentId} in preferredSessionKey with target agent', () => {
      // Create session store with a key that matches the resolved template
      const sessions = {
        [`agent:${testAgentId}:feishu:group:oc_xxx`]: {
          sessionId: 'sess-template-match',
          updatedAt: Date.now()
        },
        'other-session': {
          sessionId: 'sess-other',
          updatedAt: Date.now() - 10000
        }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = pushNotify({
        targetAgent: testAgentId,
        msgId: 'msg_test_008',
        fromAgent: 'main',
        notifyConfig: {
          enabled: true,
          preferredSessionKey: 'agent:{agentId}:feishu:group:oc_xxx'
        },
        logger
      });

      assert.equal(result.notified, true);
      assert.equal(result.sessionId, 'sess-template-match');
    });
  });

  describe('never throws', () => {
    it('catches errors and returns error result', () => {
      // Pass an invalid agentId that would cause path traversal rejection
      // but the function should still not throw
      const result = pushNotify({
        targetAgent: '../evil',
        msgId: 'msg_test_009',
        fromAgent: 'main',
        notifyConfig: { enabled: true },
        logger
      });

      assert.equal(result.notified, false);
      // Should be no_session since path traversal agentId returns null from resolver
      assert.ok(result.reason);
    });

    it('returns result object even with null notifyConfig fields', () => {
      const result = pushNotify({
        targetAgent: testAgentId,
        msgId: 'msg_test_010',
        fromAgent: 'main',
        notifyConfig: { enabled: true, preferredSessionKey: null },
        logger
      });

      // Should not throw, just return a result
      assert.equal(typeof result.notified, 'boolean');
      assert.equal(typeof result.method, 'string');
    });
  });
});
