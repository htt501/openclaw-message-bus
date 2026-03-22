/**
 * bus_send 工具 — 发送 Agent 间消息
 * ToolFactory 模式，通过闭包捕获 db, runtime, logger, notifyOpts
 */

import { exec } from 'node:child_process';
import { BusSendSchema, getAgents, VALID_TYPES, VALID_PRIORITIES, MAX_CONTENT_BYTES, MAX_THREAD_ROUNDS } from '../schema.js';
import { generateMsgId } from '../id.js';
import { formatResult, formatError } from '../format.js';
import { writeFallback } from '../fallback.js';

/**
 * 创建 bus_send ToolFactory
 * @param {object} db - 数据库操作对象
 * @param {object} _runtime - OpenClaw runtime（保留签名兼容）
 * @param {object} logger - 日志对象
 * @param {object} notifyOpts - 通知配置 { enabled, timeoutSeconds, replyChannel, replyTo }
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

      // --- 参数验证 ---
      if (agents.length > 0 && !agents.includes(params.to)) {
        return formatError('INVALID_PARAM', `Invalid to: ${params.to}. Must be one of: ${agents.join(', ')}`);
      }
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

      const msgId = generateMsgId(from);
      const now = new Date().toISOString();

      // --- 话题链追踪 & 轮次限制 ---
      let threadRef = params.ref ?? null;

      if (params.reply_to) {
        const origMsg = db.getMessageStatus(params.reply_to);
        if (origMsg?.ref) {
          threadRef = origMsg.ref;
        } else if (origMsg) {
          threadRef = params.reply_to;
        }

        if (threadRef) {
          const rounds = db.countThreadMessages(threadRef);
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

      // --- SQLite 写入，失败降级 ---
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

      // --- 异步通知目标 agent（fire-and-forget via CLI）---
      if (notifyOpts.enabled !== false) {
        try {
          const replyHint = notifyOpts.replyChannel && notifyOpts.replyTo
            ? ` If you need to reply to the user, use the message tool to send to ${notifyOpts.replyChannel} ${notifyOpts.replyTo}`
            : '';
          const notifyMsg = `[message-bus] New message ${msgId} from ${from}. Please: 1) call bus_read to read it 2) process it.${replyHint}`;
          const timeout = (notifyOpts.timeoutSeconds ?? 120);
          exec(
            `openclaw agent --agent ${params.to} --message "${notifyMsg.replace(/"/g, '\\"')}" --timeout ${timeout}`,
            { timeout: (timeout + 10) * 1000 },
            (err) => {
              if (err) logger.warn(`push notify ${params.to} failed: ${err.message}`);
            }
          );
        } catch (notifyErr) {
          logger.warn(`push notify skipped for ${msgId}: ${notifyErr.message}`);
        }
      }

      return formatResult({ msg_id: msgId, status: 'queued', ref: threadRef, round: db.countThreadMessages(threadRef) });
    }
  });
}
