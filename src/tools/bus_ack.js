/**
 * bus_ack 工具 v1.1 — 确认消息状态转换
 * 支持 processing/completed/failed 三种目标状态
 * 向后兼容：不传 status 默认 completed
 */

import { BusAckSchema } from '../schema.js';
import { formatResult, formatError } from '../format.js';

export function createBusAck(db, logger) {
  return (ctx) => ({
    name: 'bus_ack',
    label: 'Bus: Acknowledge Message',
    parameters: BusAckSchema,
    async execute(toolCallId, params) {
      const { msg_id, status, result: ackResult, reason } = params;

      const dbResult = db.ackMessage(msg_id, { status, result: ackResult, reason });

      if (dbResult === null) {
        return formatError('MSG_NOT_FOUND', `Message ${msg_id} not found`);
      }

      const s = dbResult.status;
      if (s === 'ALREADY_COMPLETED') return formatError('ALREADY_COMPLETED', `Message ${msg_id} already completed`);
      if (s === 'ALREADY_FAILED') return formatError('ALREADY_FAILED', `Message ${msg_id} already failed`);
      if (s === 'MSG_EXPIRED') return formatError('MSG_EXPIRED', `Message ${msg_id} has expired`);
      if (s === 'MSG_DEAD_LETTER') return formatError('MSG_DEAD_LETTER', `Message ${msg_id} is in dead letter`);
      if (s === 'INVALID_STATUS') return formatError('INVALID_STATUS', dbResult.error);
      if (s === 'INVALID_TRANSITION') return formatError('INVALID_TRANSITION', dbResult.error);

      logger.info(`bus_ack: ${msg_id} → ${dbResult.status} (from ${dbResult.prev_status})`);
      return formatResult(dbResult);
    }
  });
}
