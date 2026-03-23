/**
 * 定时任务 v1.1
 * 4 个 cron job：processing 回退、降级回补、过期清理、指标日志
 * v1.1: 新增 delivered task 超时过期、completed/failed 清理
 */

import { readFallbackFiles, removeFallbackFile } from './fallback.js';
import { statSync } from 'node:fs';

const TIMEOUT_MINUTES = 10;

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
  }, 5 * 60 * 1000);

  setInterval(() => {
    cleanExpiredMessages(db, logger);
    logMetrics(db, runtime, logger);
  }, 60 * 60 * 1000);

  logger.info('cron jobs started');
}
