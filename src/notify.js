/**
 * Push Notify Module — session-aware push notifications
 * Extracted from bus_send.js for independent testability.
 * Uses session resolver to inject into existing sessions (no garbage sessions).
 */

import { spawn } from 'node:child_process';
import { resolveAgentSession } from './session-resolver.js';

const _cooldowns = new Map();
const COOLDOWN_MS = 30_000;

/**
 * Send a push notification to a target agent via session-aware CLI spawn.
 * Never throws — all errors are caught and returned in the result object.
 *
 * @param {object} opts
 * @param {string} opts.targetAgent - Agent to notify
 * @param {string} opts.msgId - Message ID triggering notification
 * @param {string} opts.fromAgent - Sender agent ID
 * @param {object} opts.notifyConfig - { enabled, timeoutSeconds, preferredSessionKey, ... }
 * @param {object} opts.logger - Logger instance with info/warn methods
 * @returns {{ notified: boolean, method: string, sessionId?: string, reason?: string }}
 */
export function pushNotify({ targetAgent, msgId, fromAgent, notifyConfig, logger }) {
  try {
    if (notifyConfig.enabled === false) {
      return { notified: false, method: 'disabled', reason: 'disabled' };
    }

    // Cooldown check
    const now = Date.now();
    const last = _cooldowns.get(targetAgent) ?? 0;
    if (now - last < COOLDOWN_MS) {
      return { notified: false, method: 'skipped', reason: 'cooldown' };
    }

    // Resolve preferred session key with {agentId} template replacement
    let preferredKey = notifyConfig.preferredSessionKey ?? null;
    if (preferredKey) {
      preferredKey = preferredKey.replace('{agentId}', targetAgent);
    }

    // Session resolve
    const session = resolveAgentSession(targetAgent, preferredKey);
    if (!session) {
      logger.warn(`push notify ${targetAgent}: no session found, skipping`);
      return { notified: false, method: 'skipped', reason: 'no_session' };
    }

    // Update cooldown before spawn
    _cooldowns.set(targetAgent, now);

    // Session-aware spawn
    const notifyMsg = `📬 New bus message ${msgId} from ${fromAgent}. Run bus_read() to process.`;
    const timeout = notifyConfig.timeoutSeconds ?? 120;

    const child = spawn('openclaw', [
      'agent',
      '--session-id', session.sessionId,
      '--message', notifyMsg,
      '--timeout', String(timeout)
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    logger.info(`push notify ${targetAgent} via session ${session.sessionId} (pid=${child.pid})`);
    return { notified: true, method: 'session-aware', sessionId: session.sessionId };
  } catch (err) {
    logger.warn(`push notify error for ${targetAgent}: ${err.message}`);
    return { notified: false, method: 'error', reason: err.message };
  }
}

/** For testing: reset cooldown state */
export function _resetCooldowns() {
  _cooldowns.clear();
}

/** For testing: get the cooldown map (read-only access) */
export function _getCooldowns() {
  return _cooldowns;
}

/** Exported for testing */
export const COOLDOWN_MS_EXPORT = COOLDOWN_MS;
