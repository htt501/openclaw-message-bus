/**
 * msg_id 生成器
 * 格式: msg_{agentId}_{timestamp_ms}_{random4}
 * 使用递增计数器混入随机数，避免同毫秒碰撞
 */

let lastTs = 0;
let seq = 0;

/**
 * 生成唯一的消息 ID
 * @param {string} agentId - 发送者 Agent ID
 * @returns {string} 格式为 msg_{agentId}_{timestamp_ms}_{hex4} 的消息 ID
 */
export function generateMsgId(agentId) {
  const ts = Date.now();
  if (ts === lastTs) {
    seq++;
  } else {
    lastTs = ts;
    seq = Math.floor(Math.random() * 0x100); // random start per ms
  }
  const hex = (seq & 0xFFFF).toString(16).padStart(4, '0');
  return `msg_${agentId}_${ts}_${hex}`;
}
