/**
 * 测试辅助工具：内存数据库工厂 v1.1
 * 使用 :memory: 避免文件系统依赖
 * 接口与 src/db.js v1.1 保持一致
 */

import Database from 'better-sqlite3';

const MAX_RESULT_BYTES = 2048;

function truncate(str, max) {
  if (!str) return str;
  if (Buffer.byteLength(str, 'utf8') <= max) return str;
  let s = str;
  while (Buffer.byteLength(s, 'utf8') > max - 3) {
    s = s.slice(0, s.length - 1);
  }
  return s + '...';
}

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
  expired_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  result TEXT,
  fail_reason TEXT
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
    SET status = 'delivered', delivered_at = ?
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

  // v1.1.2: 支持 heartbeat — delivered→processing 或 processing→processing(刷新 processing_at)
  const stmtAckProcessing = db.prepare(`
    UPDATE messages SET status = 'processing', processing_at = ?
    WHERE msg_id = ? AND status IN ('delivered', 'processing')
  `);

  const stmtAckCompleted = db.prepare(`
    UPDATE messages SET status = 'completed', completed_at = ?, result = ?
    WHERE msg_id = ? AND status IN ('delivered', 'processing')
  `);

  const stmtAckFailed = db.prepare(`
    UPDATE messages SET status = 'failed', failed_at = ?, fail_reason = ?
    WHERE msg_id = ? AND status IN ('delivered', 'processing')
  `);

  const stmtGetMessage = db.prepare(`SELECT * FROM messages WHERE msg_id = ?`);

  const stmtRevertTimedOut = db.prepare(`
    UPDATE messages
    SET status = 'queued', retry_count = retry_count + 1, processing_at = NULL
    WHERE status = 'processing' AND processing_at < ? AND retry_count < max_retries
  `);

  const stmtMarkDeadLetter = db.prepare(`
    UPDATE messages SET status = 'dead_letter'
    WHERE status = 'processing' AND processing_at < ? AND retry_count >= max_retries
  `);

  const stmtDeleteDelivered = db.prepare(`
    DELETE FROM messages WHERE status = 'delivered' AND delivered_at < ?
  `);

  const stmtDeleteCompleted = db.prepare(`
    DELETE FROM messages WHERE status = 'completed' AND completed_at < ?
  `);

  const stmtDeleteFailed = db.prepare(`
    DELETE FROM messages WHERE status = 'failed' AND failed_at < ?
  `);

  const stmtExpireQueued = db.prepare(`
    UPDATE messages SET status = 'expired', expired_at = ?
    WHERE status = 'queued' AND created_at < ?
  `);

  const stmtExpireDeliveredTasks = db.prepare(`
    UPDATE messages SET status = 'expired', expired_at = ?
    WHERE status = 'delivered' AND type = 'task' AND delivered_at < ?
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
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
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
      const rows = stmtRead.all(now, toAgent,
        from ?? null, from ?? null,
        type ?? null, type ?? null, limit
      );
      const pMap = { P0: 0, P1: 1, P2: 2 };
      rows.sort((a, b) => (pMap[a.priority] ?? 2) - (pMap[b.priority] ?? 2) || a.created_at.localeCompare(b.created_at));
      return rows;
    },

    ackMessage(msgId, opts = {}) {
      const targetStatus = opts.status || 'completed';
      const now = new Date().toISOString();

      const msg = stmtGetMessage.get(msgId);
      if (!msg) return null;

      if (msg.status === 'completed') return { msg_id: msgId, status: 'ALREADY_COMPLETED' };
      if (msg.status === 'failed') return { msg_id: msgId, status: 'ALREADY_FAILED' };
      if (msg.status === 'expired') return { msg_id: msgId, status: 'MSG_EXPIRED' };
      if (msg.status === 'dead_letter') return { msg_id: msgId, status: 'MSG_DEAD_LETTER' };

      let result;
      if (targetStatus === 'processing') {
        result = stmtAckProcessing.run(now, msgId);
        if (result.changes > 0) return { msg_id: msgId, status: 'processing', prev_status: msg.status };
      } else if (targetStatus === 'completed') {
        const truncResult = truncate(opts.result ?? null, MAX_RESULT_BYTES);
        result = stmtAckCompleted.run(now, truncResult, msgId);
        if (result.changes > 0) return { msg_id: msgId, status: 'completed', prev_status: msg.status, result: truncResult };
      } else if (targetStatus === 'failed') {
        const truncReason = truncate(opts.reason ?? null, MAX_RESULT_BYTES);
        result = stmtAckFailed.run(now, truncReason, msgId);
        if (result.changes > 0) return { msg_id: msgId, status: 'failed', prev_status: msg.status, fail_reason: truncReason };
      } else {
        return { msg_id: msgId, status: 'INVALID_STATUS', error: `Unknown status: ${targetStatus}` };
      }

      return { msg_id: msgId, status: 'INVALID_TRANSITION', error: `Cannot transition from '${msg.status}' to '${targetStatus}'` };
    },

    getMessageStatus(msgId) { return stmtGetMessage.get(msgId); },
    countThreadMessages(threadRef) { const row = stmtCountThread.get(threadRef); return row?.count ?? 0; },

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
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
      const nowIso = now.toISOString();

      const delDelivered = stmtDeleteDelivered.run(sevenDaysAgo);
      const delCompleted = stmtDeleteCompleted.run(sevenDaysAgo);
      const delFailed = stmtDeleteFailed.run(sevenDaysAgo);
      const expQueued = stmtExpireQueued.run(nowIso, twentyFourHoursAgo);
      const expDeliveredTasks = stmtExpireDeliveredTasks.run(nowIso, twoHoursAgo);
      const expDeadLetter = stmtExpireDeadLetter.run(nowIso, twentyFourHoursAgo);

      return {
        deletedDelivered: delDelivered.changes,
        deletedCompleted: delCompleted.changes,
        deletedFailed: delFailed.changes,
        expiredQueued: expQueued.changes,
        expiredDeliveredTasks: expDeliveredTasks.changes,
        expiredDeadLetter: expDeadLetter.changes
      };
    },

    getMetrics() { return stmtMetrics.get(); },
    getDbPath() { return ':memory:'; },

    findStaleMessages() {
      return db.prepare(`
        SELECT msg_id, from_agent, to_agent, type, priority, content, status, delivered_at, processing_at
        FROM messages
        WHERE status IN ('delivered', 'processing')
          AND type = 'task'
      `).all();
    },

    getDb() { return db; }
  };
}
