/**
 * 降级文件读写
 * SQLite 不可用时，消息降级写入 /tmp/bus-fallback/ 目录
 */

import { writeFileSync, readdirSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FALLBACK_DIR = '/tmp/bus-fallback';

/**
 * 写入降级文件
 * @param {string} msgId - 消息 ID
 * @param {object} data - 完整消息数据
 * @returns {string} 文件名
 */
export function writeFallback(msgId, data) {
  mkdirSync(FALLBACK_DIR, { recursive: true });
  const filename = `${Date.now()}_${msgId}.json`;
  writeFileSync(join(FALLBACK_DIR, filename), JSON.stringify(data));
  return filename;
}

/**
 * 读取所有降级文件
 * @returns {Array<{ filename: string, data: object }>}
 */
export function readFallbackFiles() {
  try {
    const files = readdirSync(FALLBACK_DIR).filter(f => f.endsWith('.json'));
    return files.map(filename => {
      const raw = readFileSync(join(FALLBACK_DIR, filename), 'utf-8');
      return { filename, data: JSON.parse(raw) };
    });
  } catch {
    return [];
  }
}

/**
 * 删除已回补的降级文件
 * @param {string} filename - 文件名
 */
export function removeFallbackFile(filename) {
  unlinkSync(join(FALLBACK_DIR, filename));
}
