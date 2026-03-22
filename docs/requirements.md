# 需求文档（基于实际实现 v1.0）

## 简介

OpenClaw 是一个多 Agent 协作系统，7 个 AI Agent（main、ops、creator、intel、strategist、chichi、secretary）通过飞书群聊协作。当前 Agent 间通信使用同步阻塞的 `sessions_send`，存在死锁、消息丢失、无审计记录等问题。

本插件（openclaw-message-bus）以 OpenClaw Plugin 形式提供一个基于 SQLite 的异步消息总线，实现 Agent 间可靠、非阻塞、可追溯的消息通信。

### 与初始设计的主要变更

| 变更项 | 初始设计 | 实际实现 | 原因 |
|--------|----------|----------|------|
| Agent 数量 | 5 个（main/ops/creator/intel/strategist） | 7 个（+chichi/secretary），且支持配置化 | 业务扩展，新增琪琪和小Q两个 Agent |
| 消息类型 | 3 种（task/discuss/notify） | 6 种（+request/response/escalation） | 需要更精细的消息语义区分 |
| 优先级 | 3 级（P0/P1/P2） | 4 级（+P3） | 需要低优先级标记 |
| 推送机制 | runtime.subagent.run | CLI exec `openclaw agent --agent` | subagent.run 的 sessionKey 无法正确路由到飞书群上下文 |
| bus_read 状态 | queued → processing | queued → delivered（直接标记） | 简化流程，减少一次 ack 调用 |
| 话题链追踪 | 无 | ref 字段自动串联 + 10 轮限制 | 防止 Agent 间无限循环对话 |
| Agent 列表 | 硬编码 | 支持通过 config.agents 动态配置 | GitHub 发布需要，不同用户有不同 Agent |
| 通知配置 | 硬编码飞书群 ID | 支持 config.notify 配置 | 同上 |

## 术语表

- **Message_Bus**：本插件提供的异步消息总线系统
- **Agent**：OpenClaw 系统中的 AI Agent 实例
- **Message**：Agent 间通信的基本单元
- **msg_id**：消息唯一标识符，格式 `msg_{from_agent}_{timestamp_ms}_{hex4}`
- **ToolFactory**：OpenClaw 插件 SDK 的工具注册模式，通过闭包捕获 ctx 获取 agentId
- **ctx.agentId**：ToolFactory 上下文中的当前调用者 Agent ID
- **Thread / 话题链**：通过 ref 字段串联的一组相关消息，用于追踪多轮对话
- **Dead_Letter**：超过最大重试次数仍未成功投递的消息状态
- **Fallback_Store**：SQLite 不可用时的降级存储，位于 `/tmp/bus-fallback/`

## 需求

### 需求 1：插件注册与初始化

**用户故事：** 作为 OpenClaw 系统管理员，我希望消息总线以标准插件形式加载，支持通过配置文件自定义 Agent 列表和通知行为。

#### 验收标准

1. WHEN OpenClaw Gateway 启动, THE Message_Bus SHALL 通过 openclaw.plugin.json 声明插件元数据并通过 index.js 导出 plugin 对象完成注册
2. WHEN register(api) 被调用, THE Message_Bus SHALL 使用 ToolFactory 模式注册 bus_send、bus_read、bus_ack、bus_status 四个 Agent Tool
3. WHEN register(api) 被调用, THE Message_Bus SHALL 通过 runtime.state.resolveStateDir() 获取状态目录并创建 message-bus.sqlite 数据库文件
4. WHEN 数据库初始化完成, THE Message_Bus SHALL 设置 PRAGMA journal_mode=WAL 和 PRAGMA busy_timeout=5000
5. WHEN 数据库初始化完成, THE Message_Bus SHALL 创建 messages 表及 idx_to_status、idx_type、idx_created 三个索引
6. WHEN register(api) 被调用, THE Message_Bus SHALL 启动所有内部定时任务
7. WHEN api.config.agents 提供了非空数组, THE Message_Bus SHALL 使用该数组作为合法 Agent 列表；否则不校验目标 Agent（开放模式）
8. WHEN api.config.notify 提供了配置, THE Message_Bus SHALL 使用该配置控制 CLI 推送行为（enabled、timeoutSeconds、replyChannel、replyTo）

### 需求 2：发送消息（bus_send）

**用户故事：** 作为一个 Agent，我希望能异步发送消息给其他 Agent，支持多种消息类型和优先级，以便实现灵活的任务协作。

#### 验收标准

1. WHEN Agent 调用 bus_send 并提供合法的 to 和 content 参数, THE Message_Bus SHALL 生成 msg_id 并将消息写入 SQLite，返回 `{ msg_id, status: "queued", ref, round }`
2. THE Message_Bus SHALL 从 ToolFactory 的 ctx.agentId 自动获取 from_agent 值
3. WHEN config.agents 非空且 to 参数值不在配置列表中, THE Message_Bus SHALL 返回 INVALID_PARAM 错误；config.agents 为空时不校验
4. WHEN content 参数超过 10KB（10240 字节）, THE Message_Bus SHALL 返回 INVALID_PARAM 错误
5. WHEN 未提供 type 参数, THE Message_Bus SHALL 使用默认值 notify
6. WHEN 未提供 priority 参数, THE Message_Bus SHALL 使用默认值 P2
7. WHEN type 参数值不在 task/discuss/notify/request/response/escalation 范围内, THE Message_Bus SHALL 返回 INVALID_PARAM 错误
8. WHEN priority 参数值不在 P0/P1/P2/P3 范围内, THE Message_Bus SHALL 返回 INVALID_PARAM 错误

### 需求 3：话题链追踪与轮次限制

**用户故事：** 作为系统管理员，我希望 Agent 间的多轮对话能自动串联追踪，并在超过一定轮次后强制终止，以防止 Agent 间无限循环。

#### 验收标准

1. WHEN bus_send 未提供 ref 且未提供 reply_to, THE Message_Bus SHALL 将 ref 设为当前消息的 msg_id（作为话题起点）
2. WHEN bus_send 提供了 reply_to, THE Message_Bus SHALL 查找原消息的 ref 并继承作为当前消息的 ref（话题链串联）
3. WHEN 原消息没有 ref, THE Message_Bus SHALL 使用原消息的 msg_id 作为话题 ref
4. WHEN 同一话题链（相同 ref）的消息数量达到 MAX_THREAD_ROUNDS（默认 10）, THE Message_Bus SHALL 返回 ROUND_LIMIT 错误，要求 escalate
5. THE Message_Bus SHALL 在 bus_send 返回值中包含 ref（话题标识）和 round（当前轮次）

### 需求 4：CLI 推送通知

**用户故事：** 作为一个 Agent，我希望发送消息后目标 Agent 能尽快收到通知，以便实现近实时的 Agent 间协作。

#### 验收标准

1. WHEN 消息成功写入 SQLite 且 notify.enabled 为 true, THE Message_Bus SHALL 通过 `openclaw agent --agent <to> --message "..." --timeout <timeoutSeconds>` CLI 命令异步通知目标 Agent
2. WHEN notify.replyChannel 和 notify.replyTo 均已配置, THE Message_Bus SHALL 在通知消息中包含回复渠道提示
3. WHEN CLI 推送失败, THE Message_Bus SHALL 记录警告日志但不影响 bus_send 的返回结果
4. WHEN notify.enabled 为 false, THE Message_Bus SHALL 跳过 CLI 推送

### 需求 5：SQLite 降级写入

**用户故事：** 作为系统管理员，我希望 SQLite 不可用时消息不丢失。

#### 验收标准

1. WHEN bus_send 写入 SQLite 失败, THE Message_Bus SHALL 将消息以 JSON 文件写入 `/tmp/bus-fallback/{timestamp}_{msg_id}.json` 并返回 `{ msg_id, status: "queued_fallback" }`
2. WHEN SQLite 和降级文件写入均失败, THE Message_Bus SHALL 返回 FALLBACK_FAILED 错误

### 需求 6：读取消息（bus_read）

**用户故事：** 作为一个 Agent，我希望能拉取发给自己的未处理消息，按优先级排序。

#### 验收标准

1. WHEN Agent 调用 bus_read, THE Message_Bus SHALL 返回 to_agent 等于调用者 agentId 且 status 为 queued 的消息数组
2. THE Message_Bus SHALL 使用 UPDATE...RETURNING 在一条 SQL 中完成消息选取并直接标记为 delivered（原子操作）
3. WHEN 提供 from 参数, THE Message_Bus SHALL 仅返回 from_agent 匹配的消息
4. WHEN 提供 type 参数, THE Message_Bus SHALL 仅返回 type 匹配的消息
5. WHEN 未提供 limit, THE Message_Bus SHALL 默认最多返回 10 条
6. THE Message_Bus SHALL 按优先级（P0 > P1 > P2 > P3）再按 created_at 升序排序返回
7. THE Message_Bus SHALL 在返回的每条消息中包含 msg_id、from_agent、type、priority、content、ref、created_at 字段

### 需求 7：确认消息（bus_ack）

**用户故事：** 作为一个 Agent，我希望能手动确认消息（兼容旧流程），即使 bus_read 已自动标记 delivered。

#### 验收标准

1. WHEN Agent 对 processing 状态的消息调用 bus_ack, THE Message_Bus SHALL 将状态更新为 delivered 并记录 delivered_at
2. WHEN Agent 对已 delivered 的消息调用 bus_ack, THE Message_Bus SHALL 返回 ALREADY_ACKED（幂等）
3. WHEN msg_id 不存在, THE Message_Bus SHALL 返回 MSG_NOT_FOUND 错误

### 需求 8：查询消息状态（bus_status）

**用户故事：** 作为一个 Agent，我希望能查询任意消息的当前状态。

#### 验收标准

1. WHEN Agent 调用 bus_status 并提供有效 msg_id, THE Message_Bus SHALL 返回该消息的完整记录（全部 16 个字段）
2. WHEN msg_id 不存在, THE Message_Bus SHALL 返回 MSG_NOT_FOUND 错误

### 需求 9：消息超时回退与死信处理

**用户故事：** 作为系统管理员，我希望长时间未确认的消息能自动重试，超过上限进入死信队列。

#### 验收标准

1. THE Message_Bus SHALL 每 5 分钟执行一次 processing 回退任务
2. WHEN 消息处于 processing 且 processing_at 超过 10 分钟, THE Message_Bus SHALL 回退为 queued 并 retry_count + 1
3. WHEN retry_count >= max_retries（默认 3）, THE Message_Bus SHALL 标记为 dead_letter

### 需求 10：降级文件回补

**用户故事：** 作为系统管理员，我希望降级写入的消息能自动回补到 SQLite。

#### 验收标准

1. THE Message_Bus SHALL 每 5 分钟扫描 `/tmp/bus-fallback/` 目录
2. WHEN 存在 JSON 文件, THE Message_Bus SHALL 读取并插入 SQLite，成功后删除文件
3. WHEN 回补失败, THE Message_Bus SHALL 保留文件等待下次重试

### 需求 11：过期清理

**用户故事：** 作为系统管理员，我希望过期消息自动清理以控制数据库体积。

#### 验收标准

1. THE Message_Bus SHALL 每小时执行一次过期清理
2. delivered 超过 7 天 → 删除
3. queued 超过 24 小时 → 标记 expired
4. dead_letter 超过 24 小时 → 标记 expired

### 需求 12：指标日志

**用户故事：** 作为系统管理员，我希望定期输出运行指标以监控系统健康。

#### 验收标准

1. THE Message_Bus SHALL 每小时输出指标日志：消息总量、各状态数量、平均投递时延、积压数量、过期率
2. WHEN 数据库文件超过 50MB, THE Message_Bus SHALL 输出存储告警

### 需求 13：工具返回值格式

**用户故事：** 作为 OpenClaw 平台，我希望所有工具返回值遵循统一格式。

#### 验收标准

1. 正常返回：`{ content: [{ type: 'text', text: JSON.stringify(result) }], details: result }`
2. 错误返回：details 中包含 error 字段和错误码（INVALID_PARAM / FALLBACK_FAILED / MSG_NOT_FOUND / ALREADY_ACKED / ROUND_LIMIT）

### 需求 14：msg_id 生成规则

#### 验收标准

1. 格式：`msg_{from_agent}_{timestamp_ms}_{hex4}`
2. 同毫秒内通过递增计数器保证唯一性，跨毫秒随机起点

### 需求 15：数据模型

#### 验收标准

1. messages 表包含 16 个字段：msg_id(PK)、from_agent、to_agent、type、priority、content、ref、reply_to、status、retry_count、max_retries、last_error、created_at、processing_at、delivered_at、expired_at
2. 三个索引：idx_to_status(to_agent, status)、idx_type(type)、idx_created(created_at)

### 需求 16：并发安全

#### 验收标准

1. 多个 Agent 同时调用 bus_read 时，每条消息仅被一个 Agent 读取到
2. 通过 SQLite UPDATE...RETURNING 原子操作实现

### 需求 17：Agent 使用规则

**用户故事：** 作为 Agent，我需要明确的消息总线使用规范。

#### 验收标准

1. 每次激活先调用 bus_read 检查待处理消息
2. Agent 间协作通信优先使用 bus_send，不直接 sessions_send
3. 回复消息时必须填 reply_to 字段以维护话题链
4. 收到 response 类型消息后必须在飞书群回复用户，不能 NO_REPLY
5. 遇到 ROUND_LIMIT 错误时必须 escalate 给 strategist 或人类决策
