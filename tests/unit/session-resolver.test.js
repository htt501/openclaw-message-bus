/**
 * Unit tests for session resolver (v3)
 * Covers: happy path, preferred key match, fallback to most recent,
 *         missing file, corrupted JSON, path traversal, empty store
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAgentSession, getSessionStorePath } from '../../src/session-resolver.js';

// We test resolveAgentSession by creating real temp session store files.
// For path construction we verify getSessionStorePath separately.

describe('getSessionStorePath', () => {
  it('returns path under ~/.openclaw/agents/{agentId}/sessions/sessions.json', () => {
    const p = getSessionStorePath('ops');
    assert.ok(p.includes('agents'));
    assert.ok(p.includes('ops'));
    assert.ok(p.endsWith('sessions.json'));
  });
});

describe('resolveAgentSession', () => {
  // We can't easily mock readFileSync in ESM, so we test the real function
  // against the actual filesystem. For "missing file" and "corrupted JSON"
  // we rely on the fact that random agentIds won't have session stores.

  describe('path traversal validation', () => {
    it('rejects agentId containing ".."', () => {
      assert.equal(resolveAgentSession('../etc', null), null);
    });

    it('rejects agentId containing "/"', () => {
      assert.equal(resolveAgentSession('foo/bar', null), null);
    });

    it('rejects agentId containing "\\"', () => {
      assert.equal(resolveAgentSession('foo\\bar', null), null);
    });

    it('rejects empty string agentId', () => {
      assert.equal(resolveAgentSession('', null), null);
    });

    it('rejects null agentId', () => {
      assert.equal(resolveAgentSession(null, null), null);
    });

    it('rejects undefined agentId', () => {
      assert.equal(resolveAgentSession(undefined, null), null);
    });

    it('rejects non-string agentId', () => {
      assert.equal(resolveAgentSession(123, null), null);
    });
  });

  describe('missing file', () => {
    it('returns null when session store does not exist', () => {
      // Use a random agent name that won't have a real session store
      const result = resolveAgentSession('nonexistent-agent-xyz-999', null);
      assert.equal(result, null);
    });
  });

  // For tests that need real files, use a temp directory approach
  // by creating a wrapper that reads from a known path.
  // Since resolveAgentSession uses homedir(), we test the core logic
  // by creating files at the expected location in a temp dir.

  describe('with temp session store files', () => {
    const testAgentId = `test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let sessionDir;

    beforeEach(() => {
      // Create the session store at the path resolveAgentSession will look for
      const storePath = getSessionStorePath(testAgentId);
      sessionDir = join(storePath, '..');
      mkdirSync(sessionDir, { recursive: true });
    });

    afterEach(() => {
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    });

    it('happy path: resolves feishu group session', () => {
      const sessions = {
        'agent:ops:feishu:group:oc_7b975ce73644030ddb8a284335af7002': {
          sessionId: '56b55765-edcd-4a3b-9718-c1f367dcec61',
          updatedAt: 1774520596014
        }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = resolveAgentSession(testAgentId);
      assert.ok(result);
      assert.equal(result.sessionId, '56b55765-edcd-4a3b-9718-c1f367dcec61');
      assert.equal(result.sessionKey, 'agent:ops:feishu:group:oc_7b975ce73644030ddb8a284335af7002');
    });

    it('preferred key exact match', () => {
      const sessions = {
        'agent:ops:feishu:group:oc_aaa': { sessionId: 'sess-aaa', updatedAt: 100 },
        'agent:ops:feishu:group:oc_bbb': { sessionId: 'sess-bbb', updatedAt: 200 }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = resolveAgentSession(testAgentId, 'agent:ops:feishu:group:oc_aaa');
      assert.ok(result);
      assert.equal(result.sessionId, 'sess-aaa');
      assert.equal(result.sessionKey, 'agent:ops:feishu:group:oc_aaa');
    });

    it('preferred key partial match (includes)', () => {
      const sessions = {
        'agent:ops:feishu:group:oc_7b975ce73644030ddb8a284335af7002': {
          sessionId: 'sess-feishu',
          updatedAt: 100
        }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = resolveAgentSession(testAgentId, 'feishu:group');
      assert.ok(result);
      assert.equal(result.sessionId, 'sess-feishu');
    });

    it('preferred key no match → fallback to most recent', () => {
      const sessions = {
        'session-old': { sessionId: 'old-id', updatedAt: 100 },
        'session-new': { sessionId: 'new-id', updatedAt: 999 }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = resolveAgentSession(testAgentId, 'nonexistent-key');
      assert.ok(result);
      assert.equal(result.sessionId, 'new-id');
      assert.equal(result.sessionKey, 'session-new');
    });

    it('fallback to most recently active session (no preferred key)', () => {
      const sessions = {
        'session-a': { sessionId: 'id-a', updatedAt: 500 },
        'session-b': { sessionId: 'id-b', updatedAt: 900 },
        'session-c': { sessionId: 'id-c', updatedAt: 200 }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = resolveAgentSession(testAgentId);
      assert.ok(result);
      assert.equal(result.sessionId, 'id-b');
      assert.equal(result.sessionKey, 'session-b');
    });

    it('uses lastActiveAt when updatedAt is missing', () => {
      const sessions = {
        'session-a': { sessionId: 'id-a', lastActiveAt: 100 },
        'session-b': { sessionId: 'id-b', lastActiveAt: 300 }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = resolveAgentSession(testAgentId);
      assert.ok(result);
      assert.equal(result.sessionId, 'id-b');
    });

    it('uses createdAt as last resort timestamp', () => {
      const sessions = {
        'session-a': { sessionId: 'id-a', createdAt: 50 },
        'session-b': { sessionId: 'id-b', createdAt: 150 }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = resolveAgentSession(testAgentId);
      assert.ok(result);
      assert.equal(result.sessionId, 'id-b');
    });

    it('supports session.id field (alternative to sessionId)', () => {
      const sessions = {
        'session-x': { id: 'alt-id-format', updatedAt: 100 }
      };
      writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(sessions));

      const result = resolveAgentSession(testAgentId);
      assert.ok(result);
      assert.equal(result.sessionId, 'alt-id-format');
    });

    it('corrupted JSON → returns null', () => {
      writeFileSync(join(sessionDir, 'sessions.json'), '{not valid json!!!');

      const result = resolveAgentSession(testAgentId);
      assert.equal(result, null);
    });

    it('empty store (empty object) → returns null', () => {
      writeFileSync(join(sessionDir, 'sessions.json'), '{}');

      const result = resolveAgentSession(testAgentId);
      assert.equal(result, null);
    });

    it('array JSON → returns null', () => {
      writeFileSync(join(sessionDir, 'sessions.json'), '[]');

      const result = resolveAgentSession(testAgentId);
      assert.equal(result, null);
    });

    it('null JSON → returns null', () => {
      writeFileSync(join(sessionDir, 'sessions.json'), 'null');

      const result = resolveAgentSession(testAgentId);
      assert.equal(result, null);
    });
  });
});
