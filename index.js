/**
 * openclaw-message-bus 插件入口
 * Agent-to-Agent 异步消息总线
 */

import { initDb } from './src/db.js';
import { setAgents } from './src/schema.js';
import { createBusSend } from './src/tools/bus_send.js';
import { createBusRead } from './src/tools/bus_read.js';
import { createBusAck } from './src/tools/bus_ack.js';
import { createBusStatus } from './src/tools/bus_status.js';
import { startCronJobs } from './src/cron.js';

const plugin = {
  id: 'openclaw-message-bus',
  name: 'A2A Message Bus',
  description: 'Agent-to-Agent async message bus with SQLite persistence',
  register(api) {
    const runtime = api.runtime;
    const logger = runtime.logging.getChildLogger('message-bus');
    const stateDir = runtime.state.resolveStateDir();
    const db = initDb(stateDir, logger);
    const config = api.config ?? {};

    // Merge configured agents into VALID_AGENTS
    if (Array.isArray(config.agents) && config.agents.length > 0) {
      setAgents(config.agents);
      logger.info(`agents configured: ${config.agents.join(', ')}`);
    }

    const notifyOpts = {
      enabled: config.notify?.enabled !== false,
      sessionAware: config.notify?.sessionAware !== false, // default true — Phase 2 adds session resolver
      timeoutSeconds: config.notify?.timeoutSeconds ?? 120,
      replyChannel: config.notify?.replyChannel ?? '',
      replyTo: config.notify?.replyTo ?? ''
    };

    api.registerTool(createBusSend(db, runtime, logger, notifyOpts), { name: 'bus_send' });
    api.registerTool(createBusRead(db, logger), { name: 'bus_read' });
    api.registerTool(createBusAck(db, logger), { name: 'bus_ack' });
    api.registerTool(createBusStatus(db, logger), { name: 'bus_status' });

    startCronJobs(db, runtime, logger);
    logger.info('message-bus initialized');
  }
};

export default plugin;
