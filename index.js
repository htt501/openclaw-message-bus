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
    // api.config may be the full openclaw.json or just the plugin's config section
    // Detect and extract the plugin-specific config if needed
    const pluginConfig = config.plugins?.entries?.['openclaw-message-bus']?.config ?? config;

    // Merge configured agents into VALID_AGENTS
    if (Array.isArray(pluginConfig.agents) && pluginConfig.agents.length > 0) {
      setAgents(pluginConfig.agents);
      logger.info(`agents configured: ${pluginConfig.agents.join(', ')}`);
    }

    const notifyOpts = {
      enabled: pluginConfig.notify?.enabled === true,
      sessionAware: pluginConfig.notify?.sessionAware !== false,
      timeoutSeconds: pluginConfig.notify?.timeoutSeconds ?? 120,
      replyChannel: pluginConfig.notify?.replyChannel ?? '',
      replyTo: pluginConfig.notify?.replyTo ?? '',
      preferredSessionKey: pluginConfig.notify?.preferredSessionKey ?? ''
    };

    logger.info(`notify config: enabled=${notifyOpts.enabled}, replyTo=${notifyOpts.replyTo}, replyChannel=${notifyOpts.replyChannel}`);

    api.registerTool(createBusSend(db, runtime, logger, notifyOpts), { name: 'bus_send' });
    api.registerTool(createBusRead(db, logger), { name: 'bus_read' });
    api.registerTool(createBusAck(db, logger), { name: 'bus_ack' });
    api.registerTool(createBusStatus(db, logger), { name: 'bus_status' });

    // Cron runs in-process via setInterval — no child processes, no extra memory
    startCronJobs(db, runtime, logger, notifyOpts);
    logger.info('message-bus v3.0.0 initialized');
  }
};

export default plugin;
