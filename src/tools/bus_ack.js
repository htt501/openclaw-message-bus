/**
 * bus_ack 工具 — 确认消息已处理
 * 幂等设计：已确认的消息返回 ALREADY_ACKED
 */

import { BusAckSchema } from '../schema.js';
import { formatResult, formatError } from '../format.js';

/**
 * 创建 bus_ack ToolFactory
 * @param {object} db - 数据库操作对象
 * @param {object} logger - 日志对象
 * @returns {Function} ToolFactory: (ctx) => AnyAgentTool
 */
export function createBusAck(db, logger) {
  return (ctx) => ({
    name: 'bus_ack',
    label: 'Bus: Acknowledge Message',
    parameters: BusAckSchema,
    async execute(toolCallId, params) {
      const result = db.ackMessage(params.msg_id);

      if (result === null) {
        return formatError('MSG_NOT_FOUND', `Message ${params.msg_id} not found`);
      }

      if (result.status === 'ALREADY_ACKED') {
        return formatError('ALREADY_ACKED', `Message ${params.msg_id} already acknowledged`);
      }

      logger.info(`bus_ack: ${params.msg_id} → delivered`);
      return formatResult(result);
    }
  });
}
