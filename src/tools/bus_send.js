/**
 * bus_send 工具 — 发送 Agent 间消息
 * ToolFactory 模式，通过闭包捕获 db, runtime, logger, notifyOpts
 */

import { BusSendSchema, getAgents, VALID_TYPES, VALID_PRIORITIES, MAX_CONTENT_BYTES, MAX_THREAD_ROUNDS } from '../schema.js';
import { generateMsgId } from '../id.js';
import { formatResult, formatError } from '../format.js';
import { writeFallback } from '../fallback.js';
import { pushNotify, broadcastNotify } from '../notify.js';

const ACTIONABLE_TYPES = ['task', 'request', 'discuss', 'escalation'];

/**
 * 创建 bus_send ToolFactory
 * @param {object} db - 数据库操作对象
 * @param {object} _runtime - OpenClaw runtime（保留签名兼容）
 * @param {object} logger - 日志对象
 * @param {object} notifyOpts - 通知配置 { enabled, timeoutSeconds, preferredSessionKey, ... }
 * @returns {Function} ToolFactory: (ctx) => AnyAgentTool
 */
export function createBusSend(db, _runtime, logger, notifyOpts = {}) {
  return (ctx) => ({
    name: 'bus_send',
    label: 'Bus: Send Message',
    parameters: BusSendSchema,
    async execute(toolCallId, params) {
      const from = ctx.agentId;
      const agents = getAgents();
      const isBroadcast = Array.isArray(params.to);

      // --- v3: Broadcast — empty array rejection ---
      if (isBroadcast && params.to.length === 0) {
        return formatError('INVALID_PARAM', 'Broadcast target array must not be empty');
      }

      // --- Common param validation (type, priority, content) ---
      const type = params.type ?? 'notify';
      if (!VALID_TYPES.includes(type)) {
        return formatError('INVALID_PARAM', `Invalid type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`);
      }
      const priority = params.priority ?? 'P2';
      if (!VALID_PRIORITIES.includes(priority)) {
        return formatError('INVALID_PARAM', `Invalid priority: ${priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
      }
      if (Buffer.byteLength(params.content, 'utf-8') > MAX_CONTENT_BYTES) {
        return formatError('INVALID_PARAM', `Content exceeds ${MAX_CONTENT_BYTES} bytes`);
      }

      // --- v3: Broadcast path ---
      if (isBroadcast) {
        // Deduplicate targets
        const targets = [...new Set(params.to)];

        // Per-target validation against configured agents list
        if (agents.length > 0) {
          for (const target of targets) {
            if (!agents.includes(target)) {
              return formatError('INVALID_PARAM', `Invalid to: ${target}. Must be one of: ${agents.join(', ')}`);
            }
          }
        }

        // Shared ref for all broadcast messages
        const sharedRef = params.ref ?? generateMsgId(from);
        const now = new Date().toISOString();
        const results = [];

        for (const target of targets) {
          const msgId = generateMsgId(from);
          const msgData = {
            msg_id: msgId,
            from_agent: from,
            to_agent: target,
            type,
            priority,
            content: params.content,
            ref: sharedRef,
            reply_to: params.reply_to ?? null,
            created_at: now
          };

          try {
            db.insertMessage(msgData);
            results.push({ msg_id: msgId, to: target, status: 'queued' });
          } catch (err) {
            logger.warn(`SQLite write failed for ${msgId} (broadcast to ${target}): ${err.message}`);
            try {
              writeFallback(msgId, msgData);
              results.push({ msg_id: msgId, to: target, status: 'queued_fallback' });
            } catch (fbErr) {
              logger.error(`Fallback write also failed for ${msgId}: ${fbErr.message}`);
              results.push({ msg_id: msgId, to: target, status: 'failed' });
            }
          }

          // Fire-and-forget notify per target — broadcast always wakes (v3.0.2)
          broadcastNotify({ targetAgent: target, msgId, fromAgent: from, notifyConfig: notifyOpts, logger });
        }

        return formatResult({ messages: results, ref: sharedRef, broadcast: true });
      }

      // --- Single-target path (v1.x backward compatible) ---
      if (agents.length > 0 && !agents.includes(params.to)) {
        return formatError('INVALID_PARAM', `Invalid to: ${params.to}. Must be one of: ${agents.join(', ')}`);
      }

      const msgId = generateMsgId(from);
      const now = new Date().toISOString();

      // --- Thread tracking & round limit ---
      let threadRef = params.ref ?? null;

      if (params.reply_to) {
        const origMsg = db.getMessageStatus(params.reply_to);
        if (origMsg?.ref) {
          threadRef = origMsg.ref;
        } else if (origMsg) {
          threadRef = params.reply_to;
        }

        // v3: Only check round limit for actionable types; skip for response/notify
        if (threadRef && ACTIONABLE_TYPES.includes(type)) {
          const rounds = db.countThreadRounds(threadRef);
          if (rounds >= MAX_THREAD_ROUNDS) {
            logger.warn(`thread ${threadRef} reached ${rounds} rounds, blocking`);
            return formatError('ROUND_LIMIT',
              `Thread reached ${MAX_THREAD_ROUNDS} round limit. Escalate to a supervisor for decision. ref: ${threadRef}`);
          }
        }
      }

      if (!threadRef) {
        threadRef = msgId;
      }

      const msgData = {
        msg_id: msgId,
        from_agent: from,
        to_agent: params.to,
        type,
        priority,
        content: params.content,
        ref: threadRef,
        reply_to: params.reply_to ?? null,
        created_at: now
      };

      // --- SQLite write with fallback ---
      try {
        db.insertMessage(msgData);
      } catch (err) {
        logger.warn(`SQLite write failed for ${msgId}: ${err.message}`);
        try {
          writeFallback(msgId, msgData);
          return formatResult({ msg_id: msgId, status: 'queued_fallback' });
        } catch (fbErr) {
          logger.error(`Fallback write also failed for ${msgId}: ${fbErr.message}`);
          return formatError('FALLBACK_FAILED', 'Both SQLite and fallback write failed');
        }
      }

      // --- Notify target agent (v3.0.3: always deliver to wake target) ---
      broadcastNotify({ targetAgent: params.to, msgId, fromAgent: from, notifyConfig: notifyOpts, logger });

      return formatResult({ msg_id: msgId, status: 'queued', ref: threadRef, round: db.countThreadRounds(threadRef) });
    }
  });
}
