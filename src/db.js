/**
 * SQLite 操作层
 * 封装所有数据库读写操作，使用 better-sqlite3 同步 API
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT DEFAULT 'notify',
  priority TEXT DEFAULT 'P2',
  content TEXT NOT NULL,
  ref TEXT,
  reply_to TEXT,
  status TEXT DEFAULT 'queued',
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  last_error TEXT,
  created_at TEXT NOT NULL,
  processing_at TEXT,
  delivered_at TEXT,
  expired_at TEXT
);`;

const CREATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_to_status ON messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_created ON messages(created_at);`;

/**
 * 初始化数据库并返回操作方法对象
 * @param {string} stateDir - 状态目录路径
 * @param {object} logger - 日志对象
 * @returns {object} 包含所有数据库操作方法的对象
 */
export function initDb(stateDir, logger) {
  const dbPath = join(stateDir, 'message-bus.sqlite');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(CREATE_TABLE_SQL);
  db.exec(CREATE_INDEXES_SQL);

  logger.info(`SQLite initialized at ${dbPath}`);

  // --- Prepared statements ---

  const stmtInsert = db.prepare(`
    INSERT INTO messages (msg_id, from_agent, to_agent, type, priority, content, ref, reply_to, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
  `);

  const stmtRead = db.prepare(`
    UPDATE messages
    SET status = 'delivered', delivered_at = ?, processing_at = ?
    WHERE msg_id IN (
      SELECT msg_id FROM messages
      WHERE to_agent = ? AND status = 'queued'
        AND (? IS NULL OR from_agent = ?)
        AND (? IS NULL OR type = ?)
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 END,
        created_at ASC
      LIMIT ?
    )
    RETURNING msg_id, from_agent, type, priority, content, ref, created_at
  `);

  const stmtAck = db.prepare(`
    UPDATE messages
    SET status = 'delivered', delivered_at = ?
    WHERE msg_id = ? AND status = 'processing'
  `);

  const stmtGetMessage = db.prepare(`
    SELECT * FROM messages WHERE msg_id = ?
  `);

  const stmtRevertTimedOut = db.prepare(`
    UPDATE messages
    SET status = 'queued', retry_count = retry_count + 1, processing_at = NULL
    WHERE status = 'processing' AND processing_at < ? AND retry_count < max_retries
  `);

  const stmtMarkDeadLetter = db.prepare(`
    UPDATE messages
    SET status = 'dead_letter'
    WHERE status = 'processing' AND processing_at < ? AND retry_count >= max_retries
  `);

  const stmtDeleteDelivered = db.prepare(`
    DELETE FROM messages
    WHERE status = 'delivered' AND delivered_at < ?
  `);

  const stmtExpireQueued = db.prepare(`
    UPDATE messages
    SET status = 'expired', expired_at = ?
    WHERE status = 'queued' AND created_at < ?
  `);

  const stmtExpireDeadLetter = db.prepare(`
    UPDATE messages
    SET status = 'expired', expired_at = ?
    WHERE status = 'dead_letter' AND created_at < ?
  `);

  const stmtMetrics = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) as queued,
      COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) as processing,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) as delivered,
      COALESCE(SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END), 0) as dead_letter,
      COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) as expired,
      AVG(CASE WHEN delivered_at IS NOT NULL
        THEN (julianday(delivered_at) - julianday(created_at)) * 86400000
        ELSE NULL END) as avg_delivery_ms
    FROM messages
  `);

  const stmtCountThread = db.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE ref = ?
  `);

  // --- Operation methods ---

  return {
    /**
     * 插入消息
     * @param {object} data - 消息数据
     */
    insertMessage(data) {
      stmtInsert.run(
        data.msg_id,
        data.from_agent,
        data.to_agent,
        data.type,
        data.priority,
        data.content,
        data.ref ?? null,
        data.reply_to ?? null,
        data.created_at
      );
    },

    /**
     * 原子读取消息：选取 queued 消息并标记为 processing
     * @param {string} toAgent - 接收者 Agent ID
     * @param {string|null} from - 筛选发送者
     * @param {string|null} type - 筛选消息类型
     * @param {number} limit - 最大返回条数
     * @returns {Array} 消息数组
     */
    readMessages(toAgent, from, type, limit) {
      const now = new Date().toISOString();
      const rows = stmtRead.all(
        now,
        now,
        toAgent,
        from ?? null, from ?? null,
        type ?? null, type ?? null,
        limit
      );
      // RETURNING 不保证顺序，按 priority + created_at 排序
      const pMap = { P0: 0, P1: 1, P2: 2 };
      rows.sort((a, b) => (pMap[a.priority] ?? 2) - (pMap[b.priority] ?? 2) || a.created_at.localeCompare(b.created_at));
      return rows;
    },

    /**
     * 确认消息：processing → delivered
     * @param {string} msgId - 消息 ID
     * @returns {{ msg_id: string, status: string }}
     */
    ackMessage(msgId) {
      const now = new Date().toISOString();
      const result = stmtAck.run(now, msgId);

      if (result.changes > 0) {
        return { msg_id: msgId, status: 'delivered' };
      }

      // 区分 ALREADY_ACKED 和 MSG_NOT_FOUND
      const msg = stmtGetMessage.get(msgId);
      if (msg && msg.status === 'delivered') {
        return { msg_id: msgId, status: 'ALREADY_ACKED' };
      }
      return null; // MSG_NOT_FOUND
    },

    /**
     * 查询消息完整记录
     * @param {string} msgId - 消息 ID
     * @returns {object|undefined} 消息记录
     */
    getMessageStatus(msgId) {
      return stmtGetMessage.get(msgId);
    },

    /**
     * processing 超时回退 + 死信标记
     * @param {number} timeoutMinutes - 超时分钟数
     * @returns {{ reverted: number, deadLettered: number }}
     */
    revertTimedOut(timeoutMinutes) {
      const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
      const revertResult = stmtRevertTimedOut.run(cutoff);
      const deadResult = stmtMarkDeadLetter.run(cutoff);
      return {
        reverted: revertResult.changes,
        deadLettered: deadResult.changes
      };
    },

    /**
     * 过期清理
     * @returns {{ deletedDelivered: number, expiredQueued: number, expiredDeadLetter: number }}
     */
    cleanExpired() {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const nowIso = now.toISOString();

      const delResult = stmtDeleteDelivered.run(sevenDaysAgo);
      const expQueuedResult = stmtExpireQueued.run(nowIso, twentyFourHoursAgo);
      const expDeadResult = stmtExpireDeadLetter.run(nowIso, twentyFourHoursAgo);

      return {
        deletedDelivered: delResult.changes,
        expiredQueued: expQueuedResult.changes,
        expiredDeadLetter: expDeadResult.changes
      };
    },

    /**
     * 指标查询
     * @returns {object} 指标数据
     */
    getMetrics() {
      return stmtMetrics.get();
    },

    /**
     * 统计话题链中的消息数量
     * @param {string} threadRef - 话题 ref 标识
     * @returns {number} 消息数量
     */
    countThreadMessages(threadRef) {
      const row = stmtCountThread.get(threadRef);
      return row?.count ?? 0;
    },

    /**
     * 返回数据库文件路径
     * @returns {string}
     */
    getDbPath() {
      return dbPath;
    },

    /**
     * 获取底层数据库实例（仅用于测试）
     * @returns {Database}
     */
    getDb() {
      return db;
    }
  };
}
