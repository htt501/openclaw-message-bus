/**
 * bus_status 工具 — 查询消息状态
 * 只读操作，返回消息完整记录
 */

import { BusStatusSchema } from '../schema.js';
import { formatResult, formatError } from '../format.js';

/**
 * 创建 bus_status ToolFactory
 * @param {object} db - 数据库操作对象
 * @param {object} logger - 日志对象
 * @returns {Function} ToolFactory: (ctx) => AnyAgentTool
 */
export function createBusStatus(db, logger) {
  return (ctx) => ({
    name: 'bus_status',
    label: 'Bus: Message Status',
    parameters: BusStatusSchema,
    async execute(toolCallId, params) {
      const msg = db.getMessageStatus(params.msg_id);

      if (!msg) {
        return formatError('MSG_NOT_FOUND', `Message ${params.msg_id} not found`);
      }

      return formatResult(msg);
    }
  });
}
