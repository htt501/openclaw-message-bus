/**
 * Push Notify Module — session-aware push notifications
 * Extracted from bus_send.js for independent testability.
 * v3.0.2: broadcastNotify — broadcast always wakes targets via --deliver to feishu
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

/**
 * v3.0.2: Broadcast notify — always wake target agent via CLI --deliver to feishu.
 * Bypasses the enabled/disabled flag — broadcast = must wake.
 * Uses --agent + --deliver + --reply-channel feishu + --reply-to to deliver to group chat.
 * v3.0.4: Includes original message content so agent can act immediately.
 * Never throws.
 *
 * @param {object} opts
 * @param {string} opts.targetAgent - Agent to notify
 * @param {string} opts.msgId - Message ID triggering notification
 * @param {string} opts.fromAgent - Sender agent ID
 * @param {string} [opts.content] - Original message content
 * @param {string} [opts.type] - Message type (task/request/notify/etc)
 * @param {object} opts.notifyConfig - { replyTo, replyChannel, timeoutSeconds, ... }
 * @param {object} opts.logger - Logger instance
 * @returns {{ notified: boolean, method: string, reason?: string }}
 */
export function broadcastNotify({ targetAgent, msgId, fromAgent, content, type, notifyConfig, logger }) {
  try {
    // Cooldown check (separate namespace: broadcast:<agent>)
    const cooldownKey = `broadcast:${targetAgent}`;
    const now = Date.now();
    const last = _cooldowns.get(cooldownKey) ?? 0;
    if (now - last < COOLDOWN_MS) {
      return { notified: false, method: 'skipped', reason: 'cooldown' };
    }
    _cooldowns.set(cooldownKey, now);

    const replyTo = notifyConfig.replyTo ?? '';
    const replyChannel = notifyConfig.replyChannel ?? 'feishu';
    const timeout = notifyConfig.timeoutSeconds ?? 120;

    if (!replyTo) {
      logger.warn(`broadcast notify ${targetAgent}: no replyTo configured, skipping`);
      return { notified: false, method: 'skipped', reason: 'no_replyTo' };
    }

    // Build message with original content so agent can act immediately
    const truncContent = content && content.length > 500 ? content.slice(0, 500) + '...' : (content ?? '');
    const notifyMsg = [
      `📬 Bus 消息 [${msgId}] 来自 ${fromAgent} (type: ${type ?? 'unknown'})`,
      '',
      truncContent,
      '',
      '⚡ 请立即执行：',
      '1. bus_read() 读取完整消息',
      '2. 按消息内容执行',
      '3. bus_ack({ msg_id: "' + msgId + '", status: "completed" })',
      '4. 在群里回复执行结果'
    ].join('\n');

    const args = [
      'agent',
      '--agent', targetAgent,
      '--message', notifyMsg,
      '--deliver',
      '--reply-channel', replyChannel,
      '--reply-to', replyTo,
      '--timeout', String(timeout)
    ];

    const child = spawn('openclaw', args, { detached: true, stdio: 'ignore' });
    child.unref();

    logger.info(`broadcast notify ${targetAgent} via --deliver ${replyChannel}:${replyTo} (pid=${child.pid})`);
    return { notified: true, method: 'broadcast-deliver' };
  } catch (err) {
    logger.warn(`broadcast notify error for ${targetAgent}: ${err.message}`);
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
