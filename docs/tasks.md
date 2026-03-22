# 实现计划：A2A Message Bus

## 概述

基于 SQLite 的 Agent 间异步消息总线插件实现。按照分层架构，从基础设施（数据库、Schema）到工具实现，再到定时任务，最后集成测试的顺序推进。所有代码使用 JavaScript (ESM)，依赖 better-sqlite3 和 @sinclair/typebox。

## 任务

- [x] 1. 项目初始化与基础设施
  - [x] 1.1 创建项目结构和配置文件
    - 创建 `openclaw.plugin.json`（含 configSchema）、`package.json`（声明依赖和测试脚本）
    - 创建目录结构：`src/`、`src/tools/`、`tests/`、`tests/unit/`、`tests/property/`、`tests/helpers/`
    - _需求: 1.1_

  - [x] 1.2 实现 msg_id 生成器 (`src/id.js`)
    - 实现 `generateMsgId(agentId)` 函数，格式 `msg_{agentId}_{timestamp_ms}_{hex4}`
    - 同毫秒递增计数器 + 跨毫秒随机起点保证唯一性
    - _需求: 14.1, 14.2_

  - [ ]* 1.3 编写 msg_id 属性测试
    - **Property 5: msg_id 格式正确**
    - **Property 6: msg_id 唯一性**
    - **验证: 需求 14.1, 14.2**

  - [x] 1.4 实现返回值格式化 (`src/format.js`)
    - 实现 `formatResult(result)` 和 `formatError(code, message)` 函数
    - _需求: 13.1, 13.2_

  - [ ]* 1.5 编写返回值格式属性测试
    - **Property 21: 工具返回值格式一致性**
    - **验证: 需求 13.1, 13.2**

  - [x] 1.6 实现 Schema 定义 (`src/schema.js`)
    - TypeBox Schema + 动态 Agent 列表（setAgents/getAgents）
    - _需求: 2.1, 6.1, 7.1, 8.1_

- [x] 2. 数据库层实现
  - [x] 2.1 实现数据库初始化 (`src/db.js`)
    - WAL 模式 + busy_timeout=5000
    - messages 表（16 字段）+ 3 索引
    - _需求: 1.3, 1.4, 1.5, 15.1, 15.2_

  - [x] 2.2 实现数据库操作方法
    - insertMessage、readMessages（UPDATE...RETURNING 直接标记 delivered）、ackMessage、getMessageStatus
    - revertTimedOut、cleanExpired、getMetrics、countThreadMessages
    - _需求: 2.1, 6.1, 6.2, 7.1, 8.1, 9.1, 9.2, 9.3, 11.1, 11.2, 16.1, 16.2_

  - [x] 2.3 实现测试辅助工具 (`tests/helpers/db.js`)
    - 内存数据库工厂，接口与 src/db.js 一致（含 countThreadMessages）
    - _需求: 15.1, 15.2_

  - [ ]* 2.4 编写数据库 Schema 单元测试
    - 验证 16 字段、默认值、3 索引
    - _需求: 15.1, 15.2_

- [x] 3. 检查点 — 基础设施层测试通过

- [x] 4. 降级存储实现
  - [x] 4.1 实现降级文件读写 (`src/fallback.js`)
    - writeFallback、readFallbackFiles、removeFallbackFile
    - _需求: 5.1, 5.2, 10.1, 10.2, 10.3_

  - [ ]* 4.2 编写降级存储单元测试

- [x] 5. 工具实现 — bus_send
  - [x] 5.1 实现 bus_send 工具 (`src/tools/bus_send.js`)
    - ToolFactory 模式，参数验证、话题链追踪、轮次限制
    - CLI 推送通知（fire-and-forget via child_process.exec）
    - SQLite 失败降级到 fallback 文件
    - 支持 notifyOpts 配置（enabled、timeoutSeconds、replyChannel、replyTo）
    - _需求: 2.1-2.8, 3.1-3.5, 4.1-4.4, 5.1, 5.2_

  - [ ]* 5.2 编写 bus_send 属性测试

- [x] 6. 工具实现 — bus_read
  - [x] 6.1 实现 bus_read 工具 (`src/tools/bus_read.js`)
    - UPDATE...RETURNING 原子读取，直接标记 delivered
    - 支持 from、type 筛选和 limit
    - _需求: 6.1-6.7_

  - [ ]* 6.2 编写 bus_read 属性测试

- [x] 7. 工具实现 — bus_ack
  - [x] 7.1 实现 bus_ack 工具 (`src/tools/bus_ack.js`)
    - 幂等兼容接口（bus_read 已直接标记 delivered）
    - _需求: 7.1-7.3_

  - [ ]* 7.2 编写 bus_ack 属性测试

- [x] 8. 工具实现 — bus_status
  - [x] 8.1 实现 bus_status 工具 (`src/tools/bus_status.js`)
    - 返回完整消息记录
    - _需求: 8.1, 8.2_

  - [ ]* 8.2 编写 bus_status 属性测试

- [x] 9. 检查点 — 所有工具实现和测试通过

- [x] 10. 定时任务实现
  - [x] 10.1 实现 processing 回退和死信处理
  - [ ]* 10.2 编写 processing 回退属性测试
  - [x] 10.3 实现降级回补任务
  - [ ]* 10.4 编写降级回补属性测试
  - [x] 10.5 实现过期清理任务
  - [ ]* 10.6 编写过期清理属性测试
  - [x] 10.7 实现指标日志任务
  - [ ]* 10.8 编写指标统计属性测试
  - [x] 10.9 实现 startCronJobs 入口函数

- [x] 11. 检查点 — 定时任务测试通过

- [x] 12. 插件入口集成
  - [x] 12.1 实现插件入口 (`index.js`)
    - 读取 config.agents 和 config.notify
    - 注册 4 个工具 + 启动 cron
    - _需求: 1.1-1.8_

  - [ ]* 12.2 编写插件初始化单元测试

- [x] 13. 最终检查点 — 47/47 测试通过（26 单元 + 21 集成）

- [x] 14. GitHub 发布准备
  - [x] 14.1 代码清理（移除 debug console.error、配置化 Agent 列表和通知）
  - [x] 14.2 创建 README.md（快速部署指南、配置说明、工具用法、Agent 规则模板）
  - [x] 14.3 创建 ARCHITECTURE.md（技术架构文档、设计决策、需求变更记录）
  - [x] 14.4 更新 openclaw.plugin.json（添加 configSchema）
  - [x] 14.5 更新 package.json（测试脚本、license）
  - [x] 14.6 同步测试代码（适配 delivered-on-read、notifyOpts、setAgents）
  - [x] 14.7 Git 初始化并提交 v1.0.0

## 说明

- 标记 `*` 的子任务为可选属性测试任务
- 每个任务引用了具体的需求编号，确保需求可追溯
- 所有测试使用内存 SQLite (`:memory:`) 和 mock logger/runtime
