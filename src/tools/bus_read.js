/**
 * bus_read 工具 — 原子读取消息
 * 使用 UPDATE...RETURNING 实现并发安全的消息读取
 */

import { BusReadSchema } from '../schema.js';
import { formatResult } from '../format.js';

/**
 * 创建 bus_read ToolFactory
 * @param {object} db - 数据库操作对象
 * @param {object} logger - 日志对象
 * @returns {Function} ToolFactory: (ctx) => AnyAgentTool
 */
export function createBusRead(db, logger) {
  return (ctx) => ({
    name: 'bus_read',
    label: 'Bus: Read Messages',
    parameters: BusReadSchema,
    async execute(toolCallId, params) {
      const toAgent = ctx.agentId;
      const from = params.from ?? null;
      const type = params.type ?? null;
      const limit = params.limit ?? 10;

      const messages = db.readMessages(toAgent, from, type, limit);
      logger.info(`bus_read: ${messages.length} messages for ${toAgent}`);

      return formatResult({ messages, count: messages.length });
    }
  });
}
