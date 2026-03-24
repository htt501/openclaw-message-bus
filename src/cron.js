/**
 * 定时任务 v1.1
 * 4 个 cron job：processing 回退、降级回补、过期清理、指标日志
 * v1.1: 新增 delivered task 超时过期、completed/failed 清理
 */

import { readFallbackFiles, removeFallbackFile } from './fallback.js';
import { statSync } from 'node:fs';
import { generateMsgId } from './id.js';

const TIMEOUT_MINUTES = 10;
// v1.1.2: 按优先级分级超时阈值（分钟）
const STALE_THRESHOLDS = {
  P0: 10,   // 紧急任务 10 分钟
  P1: 15,   // 高优先级 15 分钟
  P2: 30,   // 普通任务 30 分钟
  P3: 60    // 低优先级 1 小时
};

export function revertTimedOutMessages(db, logger) {
  try {
    const result = db.revertTimedOut(TIMEOUT_MINUTES);
    if (result.reverted > 0 || result.deadLettered > 0) {
      logger.info(`cron/revert: reverted=${result.reverted}, deadLettered=${result.deadLettered}`);
    }
    return result;
  } catch (err) {
    logger.error(`cron/revert failed: ${err.message}`);
    return { reverted: 0, deadLettered: 0 };
  }
}

export function recoverFallbackMessages(db, logger) {
  let recovered = 0;
  let failed = 0;
  try {
    const files = readFallbackFiles();
    for (const { filename, data } of files) {
      try {
        db.insertMessage(data);
        removeFallbackFile(filename);
        recovered++;
      } catch (err) {
        logger.warn(`cron/recover: failed to recover ${filename}: ${err.message}`);
        failed++;
      }
    }
    if (recovered > 0 || failed > 0) {
      logger.info(`cron/recover: recovered=${recovered}, failed=${failed}`);
    }
  } catch (err) {
    logger.error(`cron/recover failed: ${err.message}`);
  }
  return { recovered, failed };
}

/**
 * 过期清理 v1.1
 * - delivered 超过 7 天 → 删除
 * - completed 超过 7 天 → 删除
 * - failed 超过 7 天 → 删除
 * - queued/dead_letter 超过 24h → 标记 expired
 * - delivered task 超过 2h → 标记 expired
 */
export function cleanExpiredMessages(db, logger) {
  try {
    const result = db.cleanExpired();
    const any = Object.values(result).some(v => v > 0);
    if (any) {
      logger.info(`cron/clean: ${JSON.stringify(result)}`);
    }
    return result;
  } catch (err) {
    logger.error(`cron/clean failed: ${err.message}`);
    return {};
  }
}

const STORAGE_WARN_BYTES = 50 * 1024 * 1024;

/**
 * v1.1.2: 检测超时未完成的 task，按优先级阈值自动通知发送者
 * P0=10min, P1=15min, P2=30min, P3=60min
 * agent 可通过 bus_ack(processing) heartbeat 刷新 processing_at 来延长超时
 */
const _notifiedStale = new Set(); // 防止重复通知

export function notifyStaleTasks(db, logger) {
  try {
    const allTasks = db.findStaleMessages();
    let notified = 0;
    const now = Date.now();

    for (const msg of allTasks) {
      if (_notifiedStale.has(msg.msg_id)) continue;

      // 按优先级取阈值，默认 30 分钟
      const thresholdMin = STALE_THRESHOLDS[msg.priority] ?? 30;
      const refTime = msg.processing_at || msg.delivered_at;
      if (!refTime) continue;

      const ageMin = (now - new Date(refTime).getTime()) / 60000;
      if (ageMin < thresholdMin) continue;

      try {
        const msgId = generateMsgId('system');
        const nowIso = new Date().toISOString();
        const minutesStale = Math.round(ageMin);

        db.insertMessage({
          msg_id: msgId,
          from_agent: 'system',
          to_agent: msg.from_agent,
          type: 'notify',
          priority: 'P1',
          content: `⚠️ 任务超时通知：你发给 ${msg.to_agent} 的消息 ${msg.msg_id} 已 ${minutesStale} 分钟未完成（当前状态: ${msg.status}，优先级: ${msg.priority}，阈值: ${thresholdMin}min）。${msg.to_agent} 可能卡住或遇到错误。建议：1) bus_status 查询最新状态 2) 考虑重新发送或群聊 @ 对方`,
          ref: msg.msg_id,
          reply_to: null,
          created_at: nowIso
        });

        _notifiedStale.add(msg.msg_id);
        notified++;
      } catch (err) {
        logger.warn(`cron/stale-notify: failed for ${msg.msg_id}: ${err.message}`);
      }
    }

    if (notified > 0) {
      logger.info(`cron/stale-notify: notified ${notified} senders about stale tasks`);
    }

    // 清理已完成的消息 ID（防止 Set 无限增长）
    if (_notifiedStale.size > 1000) {
      _notifiedStale.clear();
    }

    return { notified, total: allTasks.length };
  } catch (err) {
    logger.error(`cron/stale-notify failed: ${err.message}`);
    return { notified: 0, total: 0 };
  }
}

export function logMetrics(db, runtime, logger) {
  try {
    const metrics = db.getMetrics();
    const backlog = metrics.queued + metrics.processing;
    const expiredRate = metrics.total > 0
      ? ((metrics.expired / metrics.total) * 100).toFixed(1)
      : '0.0';

    logger.info(`cron/metrics: total=${metrics.total} queued=${metrics.queued} processing=${metrics.processing} delivered=${metrics.delivered} completed=${metrics.completed} failed=${metrics.failed} dead_letter=${metrics.dead_letter} expired=${metrics.expired} avg_delivery_ms=${metrics.avg_delivery_ms?.toFixed(0) ?? 'N/A'} backlog=${backlog} expired_rate=${expiredRate}%`);

    try {
      const dbPath = db.getDbPath();
      const stat = statSync(dbPath);
      if (stat.size > STORAGE_WARN_BYTES) {
        logger.warn(`cron/metrics: database size ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB threshold`);
      }
    } catch { /* ignore stat errors */ }

    return metrics;
  } catch (err) {
    logger.error(`cron/metrics failed: ${err.message}`);
    return null;
  }
}

export function startCronJobs(db, runtime, logger) {
  setInterval(() => {
    revertTimedOutMessages(db, logger);
    recoverFallbackMessages(db, logger);
    notifyStaleTasks(db, logger);
  }, 5 * 60 * 1000);

  setInterval(() => {
    cleanExpiredMessages(db, logger);
    logMetrics(db, runtime, logger);
  }, 60 * 60 * 1000);

  logger.info('cron jobs started');
}
