/**
 * 测试辅助工具：内存数据库工厂
 * 使用 :memory: 避免文件系统依赖
 * 接口与 src/db.js 保持一致
 */

import Database from 'better-sqlite3';

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

export function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(CREATE_TABLE_SQL);
  db.exec(CREATE_INDEXES_SQL);

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

  const stmtGetMessage = db.prepare(`SELECT * FROM messages WHERE msg_id = ?`);

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
    DELETE FROM messages WHERE status = 'delivered' AND delivered_at < ?
  `);

  const stmtExpireQueued = db.prepare(`
    UPDATE messages SET status = 'expired', expired_at = ?
    WHERE status = 'queued' AND created_at < ?
  `);

  const stmtExpireDeadLetter = db.prepare(`
    UPDATE messages SET status = 'expired', expired_at = ?
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

  return {
    insertMessage(data) {
      stmtInsert.run(
        data.msg_id, data.from_agent, data.to_agent,
        data.type, data.priority, data.content,
        data.ref ?? null, data.reply_to ?? null, data.created_at
      );
    },

    readMessages(toAgent, from, type, limit) {
      const now = new Date().toISOString();
      const rows = stmtRead.all(now, now, toAgent,
        from ?? null, from ?? null,
        type ?? null, type ?? null, limit
      );
      const pMap = { P0: 0, P1: 1, P2: 2 };
      rows.sort((a, b) => (pMap[a.priority] ?? 2) - (pMap[b.priority] ?? 2) || a.created_at.localeCompare(b.created_at));
      return rows;
    },

    ackMessage(msgId) {
      const now = new Date().toISOString();
      const result = stmtAck.run(now, msgId);
      if (result.changes > 0) {
        return { msg_id: msgId, status: 'delivered' };
      }
      const msg = stmtGetMessage.get(msgId);
      if (msg && msg.status === 'delivered') {
        return { msg_id: msgId, status: 'ALREADY_ACKED' };
      }
      return null;
    },

    getMessageStatus(msgId) {
      return stmtGetMessage.get(msgId);
    },

    countThreadMessages(threadRef) {
      const row = stmtCountThread.get(threadRef);
      return row?.count ?? 0;
    },

    revertTimedOut(timeoutMinutes) {
      const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
      const revertResult = stmtRevertTimedOut.run(cutoff);
      const deadResult = stmtMarkDeadLetter.run(cutoff);
      return { reverted: revertResult.changes, deadLettered: deadResult.changes };
    },

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

    getMetrics() { return stmtMetrics.get(); },
    getDbPath() { return ':memory:'; },
    getDb() { return db; }
  };
}
