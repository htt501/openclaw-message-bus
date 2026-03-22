/**
 * 工具返回值格式化
 * 统一所有工具的返回值结构
 */

/**
 * 格式化正常返回值
 * @param {object} result - 工具执行结果
 * @returns {{ content: Array<{type: string, text: string}>, details: object }}
 */
export function formatResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    details: result
  };
}

/**
 * 格式化错误返回值
 * @param {string} code - 错误码
 * @param {string} message - 错误描述
 * @returns {{ content: Array<{type: string, text: string}>, details: object }}
 */
export function formatError(code, message) {
  const result = { error: code, message };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    details: result
  };
}
