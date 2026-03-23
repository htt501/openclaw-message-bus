/**
 * 工具参数 Schema 定义 v1.1
 * 使用 @sinclair/typebox 定义 4 个工具的参数 Schema
 */

import { Type } from '@sinclair/typebox';

let validAgents = [];

export function setAgents(agents) {
  validAgents = [...agents];
}

export function getAgents() {
  return validAgents;
}

export const VALID_TYPES = ['task', 'discuss', 'notify', 'request', 'response', 'escalation'];
export const VALID_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const MAX_CONTENT_BYTES = 10240;
export const MAX_THREAD_ROUNDS = 10;

export const BusSendSchema = Type.Object({
  to: Type.String({ description: '目标 Agent ID' }),
  content: Type.String({ description: '消息内容，最大 10KB' }),
  type: Type.Optional(Type.String({ description: '消息类型: task/discuss/notify，默认 notify' })),
  priority: Type.Optional(Type.String({ description: '优先级: P0/P1/P2，默认 P2' })),
  ref: Type.Optional(Type.String({ description: '关联引用' })),
  reply_to: Type.Optional(Type.String({ description: '回复的 msg_id' }))
});

export const BusReadSchema = Type.Object({
  from: Type.Optional(Type.String({ description: '筛选发送者 Agent ID' })),
  type: Type.Optional(Type.String({ description: '筛选消息类型' })),
  limit: Type.Optional(Type.Number({ description: '最大返回条数，默认 10' }))
});

// v1.1: 扩展 bus_ack 支持 status/result/reason
export const BusAckSchema = Type.Object({
  msg_id: Type.String({ description: '要确认的消息 ID' }),
  status: Type.Optional(Type.String({ description: '目标状态: processing/completed/failed，默认 completed' })),
  result: Type.Optional(Type.String({ description: '完成时的结果摘要（≤2KB）' })),
  reason: Type.Optional(Type.String({ description: '失败时的原因（≤2KB）' }))
});

export const BusStatusSchema = Type.Object({
  msg_id: Type.String({ description: '要查询的消息 ID' })
});
