# A2A 消息总线使用规则（v3）

> 本文件从 AGENTS.md 分离（2026-03-21），v3 更新（2026-03-28）
> v3 核心变化：bus_send 后用 sessions_send 唤醒目标 Agent（不再 spawn 孤立 session）

## 什么是消息总线？

消息总线是 Agent 间的**异步消息队列**，消息持久化在 SQLite 中，支持优先级、确认机制、广播。

**与 sessions_send 的区别**：
| | 消息总线（bus_send） | sessions_send |
|---|---|---|
| **场景** | Agent 间任务协作、异步通知 | 唤醒目标 Agent + 与用户对话 |
| **持久化** | ✅ SQLite 存储，不丢失 | ❌ 依赖飞书 session |
| **优先级** | ✅ P0/P1/P2/P3 | ❌ 无 |
| **确认机制** | ✅ bus_ack 确认已处理 | ❌ 无 |
| **广播** | ✅ to=["ops","creator","intel"] | ❌ 无 |

**原则：Agent 间协作通信用消息总线 + sessions_send 唤醒**

---

## 4 个工具

### bus_send — 发消息
```
bus_send({
  to: "strategist",        // 目标 agent id（或数组：["ops","creator"]）
  content: "需要评审方案",   // 消息内容
  type: "request",         // task | request | discuss | notify | response | escalation
  priority: "P1",          // P0(紧急) | P1(高) | P2(普通) | P3(低)
  ref: "task-123",         // 可选，关联标识
  reply_to: "msg_xxx"      // 可选，回复某条消息
})
```

### bus_read — 读消息
```
bus_read({ limit: 10 })
// 自动读取发给自己的未读消息，按优先级排序
```

### bus_ack — 确认消息
```
bus_ack({ msg_id: "msg_main_xxx", status: "completed", result: "done" })
// status: processing | completed | failed
```

### bus_status — 查询状态
```
bus_status({ msg_id: "msg_main_xxx" })
```

---

## ⚡ v3 核心规则：bus_send + sessions_send 唤醒

### 通信流程

```
1. bus_send(to: "ops", content: "做X", type: "task")  → 消息写入 SQLite
2. sessions_send 唤醒目标 Agent                        → 目标在飞书群被唤醒
3. 目标 Agent BOOTSTRAP → bus_read() → 处理消息        → 读取并处理
4. 目标 bus_send 回复 + sessions_send 唤醒发送方        → 回复到达
```

### sessions_send 唤醒规则

**必须唤醒**（type = task / request / discuss / escalation）：
```
bus_send({ to: "ops", content: "做X", type: "task" })
sessions_send({
  sessionKey: "agent:ops:feishu:group:oc_7b975ce73644030ddb8a284335af7002",
  message: "📬 你有新 bus 消息，请 bus_read() 处理",
  timeoutSeconds: 15
})
```

**不唤醒**（type = response / notify，单播场景）：
```
bus_send({ to: "main", content: "做完了", type: "response", reply_to: "msg_xxx" })
// 不调 sessions_send，对方下次激活时 bus_read 获取
// 防止乒乓风暴
```

**⚠️ 广播例外：广播消息无论什么 type 都必须唤醒所有目标**
```
// 广播 = 群发，所有人都需要立即知道
bus_send({ to: ["ops", "creator", "intel"], content: "xxx", type: "notify" })
// 即使是 notify/response，广播场景也必须逐个 sessions_send 唤醒：
sessions_send({ sessionKey: "agent:ops:feishu:group:oc_7b975ce73644030ddb8a284335af7002", message: "📬 你有新 bus 广播消息，请 bus_read() 处理", timeoutSeconds: 15 })
sessions_send({ sessionKey: "agent:creator:feishu:group:oc_7b975ce73644030ddb8a284335af7002", message: "📬 你有新 bus 广播消息，请 bus_read() 处理", timeoutSeconds: 15 })
sessions_send({ sessionKey: "agent:intel:feishu:group:oc_7b975ce73644030ddb8a284335af7002", message: "📬 你有新 bus 广播消息，请 bus_read() 处理", timeoutSeconds: 15 })
```

### sessionKey 映射表

| Agent | sessionKey |
|-------|-----------|
| main（小吉） | `agent:main:feishu:group:oc_7b975ce73644030ddb8a284335af7002` |
| ops（贝吉塔） | `agent:ops:feishu:group:oc_7b975ce73644030ddb8a284335af7002` |
| creator（布尔玛） | `agent:creator:feishu:group:oc_7b975ce73644030ddb8a284335af7002` |
| intel（维斯） | `agent:intel:feishu:group:oc_7b975ce73644030ddb8a284335af7002` |
| strategist（界王神） | `agent:strategist:feishu:group:oc_7b975ce73644030ddb8a284335af7002` |

---

## v3 新功能

### 广播（一对多）
```
bus_send({
  to: ["ops", "creator", "intel"],
  content: "明天10点开会",
  type: "notify"
})
// 返回：{ messages: [...], ref, broadcast: true }
// 每个目标独立消息，共享 ref
```

广播后**必须**对每个目标调 sessions_send 唤醒（无论什么 type）。

### 智能线程计数
- 只有 task/request/discuss/escalation 计入轮次（MAX_THREAD_ROUNDS=4）
- response/notify 不消耗轮次预算
- 确认循环（"收到"/"好的"）不再阻塞线程

---

## Agent ID 映射

| 名字 | agent id | 用于 bus_send 的 to 字段 |
|------|----------|------------------------|
| 小吉/卡卡罗特 | main | `to: "main"` |
| 贝吉塔 | ops | `to: "ops"` |
| 布尔玛 | creator | `to: "creator"` |
| 维斯 | intel | `to: "intel"` |
| 界王神 | strategist | `to: "strategist"` |
| 琪琪 | chichi | `to: "chichi"` |
| 小Q | secretary | `to: "secretary"` |

---

## 强制规则

1. **每次激活先 bus_read** — 检查是否有待处理消息
2. **bus_send(task/request/discuss) 后必须 sessions_send 唤醒目标** — 这是 v3 的核心规则
3. **单播 bus_send(response/notify) 后不唤醒** — 防止乒乓风暴
4. **⚠️ 广播消息无论什么 type 都必须 sessions_send 唤醒所有目标** — 广播 = 群发，所有人必须立即知道
4. **处理完 task 消息后 bus_ack(completed)** — 确认已处理
5. **紧急事项用 P0/P1** — 普通通知用 P2
6. **回复消息用 reply_to** — 自动继承话题 ref 并计算轮次
7. **话题链轮次限制（4 轮）** — 超过后 bus_send 返回 ROUND_LIMIT，escalate 给界王神
8. **收到 response 后必须回复用户** — 不能 NO_REPLY
9. **广播用数组 to** — 不要循环调 bus_send
