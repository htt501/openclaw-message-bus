#!/bin/bash
# setup-agent-rules.sh — Install message bus rules into all OpenClaw agent workspaces
# 安装消息总线规则到所有 OpenClaw agent workspace
#
# Usage:
#   bash scripts/setup-agent-rules.sh
#   bash scripts/setup-agent-rules.sh /path/to/.openclaw
#
# This script appends message bus communication rules to each agent's
# BOOTSTRAP.md and SOUL.md. Safe to run multiple times (checks for duplicates).

set -e

OPENCLAW_DIR="${1:-$HOME/.openclaw}"

if [ ! -d "$OPENCLAW_DIR" ]; then
  echo "❌ OpenClaw directory not found: $OPENCLAW_DIR"
  echo "Usage: bash scripts/setup-agent-rules.sh [/path/to/.openclaw]"
  exit 1
fi

# Detect agent workspaces
WORKSPACES=()
if [ -d "$OPENCLAW_DIR/workspace" ]; then
  WORKSPACES+=("$OPENCLAW_DIR/workspace")
fi
for dir in "$OPENCLAW_DIR"/workspace-*/; do
  [ -d "$dir" ] && WORKSPACES+=("${dir%/}")
done

if [ ${#WORKSPACES[@]} -eq 0 ]; then
  echo "❌ No agent workspaces found in $OPENCLAW_DIR"
  exit 1
fi

echo "Found ${#WORKSPACES[@]} agent workspace(s)"
echo ""

# --- Rule content ---

BOOTSTRAP_RULE='
---

## 📌 谁发现谁负责 / Whoever Discovers It Owns It (Bus Message Rule)

**No matter which session you are in (main, group chat, cron, isolated), when bus_read returns an actionable message (task/request/discuss/escalation), you MUST:**

### Immediately (in current session):
1. `bus_ack({ msg_id, status: "processing" })` — mark as processing
2. `bus_send({ to: sender, content: "收到，已记录待办 / Received, added to backlog", type: "response", reply_to: msg_id })` — reply to sender

### Then (current or subsequent session):
3. Execute the task (do it now if possible, otherwise record to memory backlog)
4. `bus_ack({ msg_id, status: "completed", result: "summary" })` — mark completed
5. `bus_send({ to: sender, content: "detailed result", type: "response", reply_to: msg_id })` — reply with result

### If current session cannot complete (e.g. cron/heartbeat session):
- Steps 1-2 are mandatory immediately (reply "received")
- Write task to `memory/YYYY-MM-DD.md` backlog section
- Next main session activation: read memory backlog and continue

### Forbidden:
- ❌ Reading a message without replying (even just "received")
- ❌ Acking without bus_send reply to sender
- ❌ Treating message as "handled" without actually doing anything

---

## 📢 广播必须唤醒 / Broadcast Must Wake All Targets

**bus_send 广播（to 为数组）后，无论什么 type，必须对每个目标调 sessions_send 唤醒。**
广播 = 群发，所有人必须立即知道。

```
bus_send({ to: ["ops", "creator", "intel"], content: "xxx", type: "notify" })
// 必须逐个唤醒：
sessions_send({ sessionKey: "agent:ops:feishu:group:oc_xxx", message: "📬 你有新 bus 广播消息，请 bus_read() 处理", timeoutSeconds: 15 })
sessions_send({ sessionKey: "agent:creator:feishu:group:oc_xxx", message: "📬 你有新 bus 广播消息，请 bus_read() 处理", timeoutSeconds: 15 })
sessions_send({ sessionKey: "agent:intel:feishu:group:oc_xxx", message: "📬 你有新 bus 广播消息，请 bus_read() 处理", timeoutSeconds: 15 })
```

---

## 🚫 禁止预测 Bus 通信结果 / No Predictions on Bus Results

- **Only report facts**: bus communication results must be based on actual bus_read data
- After bus_send, must bus_read to confirm — never assume "they won'\''t reply"
- bus_read returns 0 → "暂未收到回复 / No reply yet" (NOT "没有回复 / No reply")

---

## 📢 群聊 @所有人 规则 / @all Rule

**@所有人 / @_all = 直接 @ 我 / equals direct mention**
- Must reply when @_all is used in group chat (short confirmation is fine)
'

SOUL_RULE='

## 通信纪律 / Communication Discipline
- **只报事实，不报预测 / Facts only, no predictions**: bus results must be based on actual bus_read data
- **谁发现谁负责 / Whoever discovers it owns it**: any session that reads a bus message must handle it
- **收到必回复 / Always reply when received**: even just "收到" counts
'

# --- Apply rules ---

UPDATED=0
SKIPPED=0

for workspace in "${WORKSPACES[@]}"; do
  name=$(basename "$workspace" | sed 's/workspace-//')

  # BOOTSTRAP.md
  if [ -f "$workspace/BOOTSTRAP.md" ]; then
    if grep -q "谁发现谁负责" "$workspace/BOOTSTRAP.md" 2>/dev/null; then
      echo "⏭️  $name/BOOTSTRAP.md — already has rules, skipping"
      SKIPPED=$((SKIPPED + 1))
    else
      echo "$BOOTSTRAP_RULE" >> "$workspace/BOOTSTRAP.md"
      echo "✅ $name/BOOTSTRAP.md — rules added"
      UPDATED=$((UPDATED + 1))
    fi
  else
    echo "⚠️  $name/BOOTSTRAP.md — file not found, skipping"
  fi

  # SOUL.md
  if [ -f "$workspace/SOUL.md" ]; then
    if grep -q "谁发现谁负责" "$workspace/SOUL.md" 2>/dev/null; then
      echo "⏭️  $name/SOUL.md — already has rules, skipping"
    else
      echo "$SOUL_RULE" >> "$workspace/SOUL.md"
      echo "✅ $name/SOUL.md — rules added"
    fi
  else
    echo "⚠️  $name/SOUL.md — file not found, skipping"
  fi
done

echo ""
echo "Done! Updated: $UPDATED, Skipped: $SKIPPED"
echo ""
echo "Restart gateway to apply:"
echo "  launchctl stop ai.openclaw.gateway && sleep 2 && launchctl start ai.openclaw.gateway"
