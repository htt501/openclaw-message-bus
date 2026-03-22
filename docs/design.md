# 技术设计文档：A2A Message Bus（基于实际实现 v1.0）

## 概述

openclaw-message-bus 是一个 OpenClaw 插件，为多 Agent 系统提供基于 SQLite 的异步消息总线。

核心设计目标：
- **异步非阻塞**：bus_send 写入 SQLite 后立即返回，CLI 推送异步执行
- **并发安全**：UPDATE...RETURNING 原子操作保证消息不重复投递
- **高可用**：SQLite 不可用时降级到文件系统，cron 自动回补
- **防循环**：话题链追踪 + 10 轮上限，防止 Agent 间无限对话
- **可配置**：Agent 列表、通知行为均通过 config 驱动

技术栈：JavaScript (ESM) + better-sqlite3 + @sinclair/typebox

### 与初始设计的关键技术变更

1. **推送机制**：从 `runtime.subagent.run` 改为 `child_process.exec` 调用 `openclaw agent` CLI。原因：subagent.run 需要 sessionKey 路由到飞书群上下文，但 `--session-key` 不是有效的 CLI 选项，且内置 feishu channel 缺少 appId/appSecret 配置（用户使用 openclaw-lark 插件）。CLI 方式虽然不能直接带飞书上下文，但 Agent 可以通过 message tool（openclaw-lark 提供）主动发送到飞书群。
2. **bus_read 直接标记 delivered**：初始设计是 queued → processing → delivered（需要 bus_ack），实际简化为 queued → delivered（bus_read 直接标记）。bus_ack 保留为幂等兼容接口。
3. **话题链追踪**：新增 ref 字段自动串联机制和 MAX_THREAD_ROUNDS 限制，这是初始设计中没有的。
4. **配置化**：Agent 列表和通知参数从硬编码改为 config 驱动，支持不同部署环境。

## 架构

### 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                      │
│                                                         │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ...     │
│  │ main │ │ ops  │ │creator│ │intel │ │strat │          │
│  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘          │
│     │        │        │        │        │               │
│     ▼        ▼        ▼        ▼        ▼               │
│  ┌──────────────────────────────────────────────┐       │
│  │         openclaw-message-bus plugin            │       │
│  │                                                │       │
│  │  bus_send  bus_read  bus_ack  bus_status       │       │
│  │      │        │        │        │              │       │
│  │      ▼        ▼        ▼        ▼              │       │
│  │  ┌─────────────────────────────────────┐      │       │
│  │  │     SQLite (WAL) message-bus.sqlite  │      │       │
│  │  └─────────────────────────────────────┘      │       │
│  │      │                                         │       │
│  │      ├─→ CLI Notify (fire & forget)            │       │
│  │      │   openclaw agent --agent <to> --message │       │
│  │      │                                         │       │
│  │      └─→ Cron Jobs (setInterval)               │       │
│  │          ├ 5min: revert timeout + recover fb   │       │
│  │          └ 1hr:  clean expired + log metrics   │       │
│  └────────────────────────────────────────────────┘       │
│                                                         │
│  /tmp/bus-fallback/  ← SQLite 写入失败时的降级存储       │
└─────────────────────────────────────────────────────────┘
```

### 消息生命周期

```
                    ┌─────────┐
                    │ queued  │ ← bus_send 写入
                    └────┬────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              ▼          │          ▼
        ┌──────────┐     │    ┌──────────┐
        │delivered │     │    │ expired  │ ← 24h 未读
        └──────────┘     │    └──────────┘
         (bus_read       │
          直接标记)       │
              │          │
              ▼          ▼
        ┌──────────┐  ┌───────────┐
        │ deleted  │  │dead_letter│ ← 重试 3 次仍失败
        └──────────┘  └─────┬─────┘
         (7天后清理)          │
                             ▼
                       ┌──────────┐
                       │ expired  │ ← 24h 后过期
                       └──────────┘
```

### 分层架构

```
index.js              → 插件入口，register(api) 读取 config，注册工具和 cron
src/schema.js         → TypeBox Schema + 动态 Agent 列表（setAgents/getAgents）
src/db.js             → SQLite 操作层（prepared statements，所有读写封装）
src/tools/bus_send.js → 发送消息 + 话题链追踪 + CLI 推送
src/tools/bus_read.js → 原子读取（UPDATE...RETURNING 直接标记 delivered）
src/tools/bus_ack.js  → 确认消息（幂等，兼容接口）
src/tools/bus_status.js → 查询消息状态（只读）
src/cron.js           → 4 个定时任务
src/fallback.js       → 降级文件读写
src/id.js             → msg_id 生成（递增计数器 + 随机起点）
src/format.js         → 统一返回值格式化
```

## 组件详细设计

### 1. 插件入口 (index.js)

```javascript
import { initDb } from './src/db.js';
import { setAgents } from './src/schema.js';
// ... 其他 import

const plugin = {
  register(api) {
    const runtime = api.runtime;
    const logger = runtime.logging.getChildLogger('message-bus');
    const stateDir = runtime.state.resolveStateDir();
    const db = initDb(stateDir, logger);
    const config = api.config ?? {};

    // 动态 Agent 列表
    if (Array.isArray(config.agents) && config.agents.length > 0) {
      setAgents(config.agents);
    }

    // 通知配置
    const notifyOpts = {
      enabled: config.notify?.enabled !== false,
      timeoutSeconds: config.notify?.timeoutSeconds ?? 120,
      replyChannel: config.notify?.replyChannel ?? '',
      replyTo: config.notify?.replyTo ?? ''
    };

    api.registerTool(createBusSend(db, runtime, logger, notifyOpts), { name: 'bus_send' });
    api.registerTool(createBusRead(db, logger), { name: 'bus_read' });
    api.registerTool(createBusAck(db, logger), { name: 'bus_ack' });
    api.registerTool(createBusStatus(db, logger), { name: 'bus_status' });

    startCronJobs(db, runtime, logger);
  }
};
```

设计决策：
- runtime 在 register 阶段捕获并通过闭包传递
- config 通过 api.config 获取，支持 openclaw.json 中的 plugins.entries 配置
- notifyOpts 作为参数传入 bus_send，而非全局变量

### 2. 动态 Agent 列表 (src/schema.js)

```javascript
let validAgents = [];

export function setAgents(agents) { validAgents = [...agents]; }
export function getAgents() { return validAgents; }
```

设计决策：
- 默认空数组 = 开放模式（不校验 to 参数）
- 由 index.js 在 register 阶段调用 setAgents 设置
- bus_send 通过 getAgents() 获取当前列表

### 3. bus_send 核心逻辑

```
bus_send(params) {
  1. 参数校验（to、type、priority、content 大小）
  2. 生成 msg_id
  3. 话题链处理：
     - 有 reply_to → 查原消息 ref → 继承
     - 无 reply_to 且无 ref → ref = msg_id（话题起点）
  4. 轮次检查：countThreadMessages(ref) >= 10 → ROUND_LIMIT
  5. SQLite 写入（失败 → 降级文件）
  6. CLI 推送（fire-and-forget，失败仅 warn）
  7. 返回 { msg_id, status, ref, round }
}
```

### 4. bus_read 原子读取

关键 SQL — 一条语句完成选取 + 标记 delivered：

```sql
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
```

设计决策：
- 直接标记 delivered 而非 processing，简化 Agent 使用流程（不需要手动 bus_ack）
- RETURNING 不保证顺序，代码层面按 priority + created_at 重新排序
- SQLite 单写锁保证原子性

### 5. CLI 推送通知

```javascript
const notifyMsg = `[message-bus] New message ${msgId} from ${from}. ...`;
exec(
  `openclaw agent --agent ${params.to} --message "${notifyMsg}" --timeout ${timeout}`,
  { timeout: (timeout + 10) * 1000 },
  (err) => { if (err) logger.warn(...); }
);
```

设计决策：
- 使用 child_process.exec 而非 runtime.subagent.run
- 原因：subagent.run 需要 sessionKey 路由到飞书群，但 `--session-key` 不是有效 CLI 选项，且内置 feishu channel 缺少 appId/appSecret
- fire-and-forget：不 await，不影响 bus_send 返回
- 通知消息中包含 replyChannel/replyTo 提示，告诉目标 Agent 回复到哪个渠道

### 6. 话题链追踪

```
消息 A (ref=A)  →  消息 B (reply_to=A, ref=A)  →  消息 C (reply_to=B, ref=A)
                                                    ↑ 同一话题链，ref 都是 A
```

- 第一条消息：ref = 自身 msg_id
- 回复消息：自动继承原消息的 ref
- 轮次计算：`SELECT COUNT(*) FROM messages WHERE ref = ?`
- 超过 10 轮：返回 ROUND_LIMIT，要求 escalate

### 7. msg_id 生成

```javascript
let lastTs = 0;
let seq = 0;

export function generateMsgId(agentId) {
  const ts = Date.now();
  if (ts === lastTs) {
    seq++;                                    // 同毫秒递增
  } else {
    lastTs = ts;
    seq = Math.floor(Math.random() * 0x100);  // 跨毫秒随机起点
  }
  const hex = (seq & 0xFFFF).toString(16).padStart(4, '0');
  return `msg_${agentId}_${ts}_${hex}`;
}
```

设计决策：递增计数器 + 随机起点，比纯随机更不容易碰撞。

## 数据模型

### messages 表

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| msg_id | TEXT | PRIMARY KEY | `msg_{agent}_{ts}_{hex4}` |
| from_agent | TEXT | NOT NULL | 发送者 |
| to_agent | TEXT | NOT NULL | 接收者 |
| type | TEXT | DEFAULT 'notify' | task/discuss/notify/request/response/escalation |
| priority | TEXT | DEFAULT 'P2' | P0/P1/P2/P3 |
| content | TEXT | NOT NULL | 消息内容（≤10KB） |
| ref | TEXT | | 话题链标识 |
| reply_to | TEXT | | 回复的 msg_id |
| status | TEXT | DEFAULT 'queued' | queued/processing/delivered/dead_letter/expired |
| retry_count | INTEGER | DEFAULT 0 | 重试次数 |
| max_retries | INTEGER | DEFAULT 3 | 最大重试次数 |
| last_error | TEXT | | 最后错误信息 |
| created_at | TEXT | NOT NULL | ISO 8601 |
| processing_at | TEXT | | 开始处理时间 |
| delivered_at | TEXT | | 投递确认时间 |
| expired_at | TEXT | | 过期时间 |

### 索引

| 索引名 | 字段 | 用途 |
|--------|------|------|
| idx_to_status | (to_agent, status) | bus_read 核心查询 |
| idx_type | (type) | 按类型筛选 |
| idx_created | (created_at) | 过期清理 |

## 定时任务

| 周期 | 任务 | 说明 |
|------|------|------|
| 5 min | revertTimedOut | processing 超时 10min → queued（retry<3）或 dead_letter |
| 5 min | recoverFallback | /tmp/bus-fallback/ → SQLite 回补 |
| 1 hour | cleanExpired | delivered 7天删除；queued/dead_letter 24h → expired |
| 1 hour | logMetrics | 输出统计 + 数据库大小告警（>50MB） |

## 降级策略

```
bus_send
  ├─ SQLite 写入成功 → { status: 'queued' }
  └─ SQLite 写入失败
       ├─ /tmp/bus-fallback/ 写入成功 → { status: 'queued_fallback' }
       │    └─ cron 每 5 分钟回补
       └─ 降级也失败 → FALLBACK_FAILED 错误
```

## 配置 Schema

```json
{
  "agents": ["main", "ops", "creator", "intel", "strategist", "chichi", "secretary"],
  "notify": {
    "enabled": true,
    "timeoutSeconds": 120,
    "replyChannel": "feishu",
    "replyTo": "chat:oc_xxx"
  }
}
```

在 openclaw.json 中配置路径：`plugins.entries.openclaw-message-bus.config`

## 错误码

| 错误码 | 触发条件 |
|--------|----------|
| INVALID_PARAM | to/type/priority 不合法，content 超 10KB |
| FALLBACK_FAILED | SQLite 和文件系统同时失败 |
| MSG_NOT_FOUND | msg_id 不存在 |
| ALREADY_ACKED | 对已 delivered 的消息重复 ack |
| ROUND_LIMIT | 话题链超过 10 轮 |

## 测试覆盖

- 26 个单元测试：db schema、db operations、format、id
- 21 个集成测试：T1-T17 完整生命周期 + 4 个 cron 测试
- 测试使用内存 SQLite (`:memory:`) + mock logger/runtime
- bus_send 测试中 notify.enabled=false 避免真实 CLI 调用

## 依赖

| 包 | 版本 | 用途 |
|----|------|------|
| better-sqlite3 | ^11.0.0 | SQLite 同步驱动（WAL 模式） |
| @sinclair/typebox | ^0.34.0 | JSON Schema 定义 |
| fast-check | ^3.0.0 | Property-based testing (dev) |
