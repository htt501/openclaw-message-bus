/**
 * Session Resolver — resolves target agent's active feishu session
 * Reads ~/.openclaw/agents/{agentId}/sessions/sessions.json
 * Used by push notify to inject into existing sessions (no garbage sessions)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Build the path to an agent's session store file.
 * @param {string} agentId - Target agent ID
 * @returns {string} Absolute path to sessions.json
 */
export function getSessionStorePath(agentId) {
  return join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
}

/**
 * Resolve the target agent's active session.
 * @param {string} agentId - Target agent ID
 * @param {string} [preferredSessionKey] - Optional session key pattern to match
 * @returns {{ sessionId: string, sessionKey: string } | null}
 */
export function resolveAgentSession(agentId, preferredSessionKey) {
  // Validate agentId — reject path traversal
  if (!agentId || typeof agentId !== 'string' || /[\/\\]|\.\./.test(agentId)) return null;

  const storePath = getSessionStorePath(agentId);
  let sessions;
  try {
    const raw = readFileSync(storePath, 'utf-8');
    sessions = JSON.parse(raw);
  } catch {
    return null; // File not found, permission error, or parse error
  }

  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return null;
  const entries = Object.entries(sessions);
  if (entries.length === 0) return null;

  // Preferred key match
  if (preferredSessionKey) {
    for (const [key, session] of entries) {
      if (key === preferredSessionKey || key.includes(preferredSessionKey)) {
        return { sessionId: session.id ?? session.sessionId, sessionKey: key };
      }
    }
  }

  // Fallback: most recently updated/active session (numeric timestamps)
  entries.sort((a, b) => {
    const tA = a[1].updatedAt ?? a[1].lastActiveAt ?? a[1].createdAt ?? 0;
    const tB = b[1].updatedAt ?? b[1].lastActiveAt ?? b[1].createdAt ?? 0;
    return tB - tA; // descending — most recent first
  });

  const [key, session] = entries[0];
  return { sessionId: session.id ?? session.sessionId, sessionKey: key };
}
