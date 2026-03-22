/**
 * 定时任务
 * 4 个 cron job：processing 回退、降级回补、过期清理、指标日志
 */

import { readFallbackFiles, removeFallbackFile } from './fallback.js';
import { statSync } from 'node:fs';

const TIMEOUT_MINUTES = 10;

/**
 * processing 超时回退 + 死信标记
 * - processing_at 超过 10 分钟且 retry_count < max_retries → 回退为 queued
 * - retry_count >= max_retries → 标记为 dead_letter
 */
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

/**
 * 降级回补：读取 /tmp/bus-fallback/ 下的 JSON 文件，插入 SQLite
 * 成功后删除文件，失败保留并记录日志
 */
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
 * 过期清理
 * - delivered 超过 7 天 → 删除
 * - queued/dead_letter 超过 24h → 标记 expired
 */
export function cleanExpiredMessages(db, logger) {
  try {
    const result = db.cleanExpired();
    if (result.deletedDelivered > 0 || result.expiredQueued > 0 || result.expiredDeadLetter > 0) {
      logger.info(`cron/clean: deleted=${result.deletedDelivered}, expiredQueued=${result.expiredQueued}, expiredDeadLetter=${result.expiredDeadLetter}`);
    }
    return result;
  } catch (err) {
    logger.error(`cron/clean failed: ${err.message}`);
    return { deletedDelivered: 0, expiredQueued: 0, expiredDeadLetter: 0 };
  }
}

const STORAGE_WARN_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * 指标日志
 * 输出消息总量、各状态数量、平均投递时延、积压数量、过期率
 * 数据库文件 > 50MB 时输出存储告警
 */
export function logMetrics(db, runtime, logger) {
  try {
    const metrics = db.getMetrics();
    const backlog = metrics.queued + metrics.processing;
    const expiredRate = metrics.total > 0
      ? ((metrics.expired / metrics.total) * 100).toFixed(1)
      : '0.0';

    logger.info(`cron/metrics: total=${metrics.total} queued=${metrics.queued} processing=${metrics.processing} delivered=${metrics.delivered} dead_letter=${metrics.dead_letter} expired=${metrics.expired} avg_delivery_ms=${metrics.avg_delivery_ms?.toFixed(0) ?? 'N/A'} backlog=${backlog} expired_rate=${expiredRate}%`);

    // 存储告警
    try {
      const dbPath = db.getDbPath();
      const stat = statSync(dbPath);
      if (stat.size > STORAGE_WARN_BYTES) {
        logger.warn(`cron/metrics: database size ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB threshold`);
      }
    } catch {
      // 忽略 stat 错误（如内存数据库）
    }

    return metrics;
  } catch (err) {
    logger.error(`cron/metrics failed: ${err.message}`);
    return null;
  }
}

/**
 * 启动所有定时任务
 * - 每 5 分钟：processing 回退 + 降级回补
 * - 每小时：过期清理 + 指标日志
 */
export function startCronJobs(db, runtime, logger) {
  // 每 5 分钟
  setInterval(() => {
    revertTimedOutMessages(db, logger);
    recoverFallbackMessages(db, logger);
  }, 5 * 60 * 1000);

  // 每小时
  setInterval(() => {
    cleanExpiredMessages(db, logger);
    logMetrics(db, runtime, logger);
  }, 60 * 60 * 1000);

  logger.info('cron jobs started');
}
