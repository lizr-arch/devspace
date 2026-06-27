# MCP-v2 Contract Review

**审查范围**: `src/mcp/handlers.ts`, `src/mcp/tools.ts`, `src/mcp/audit.ts`, `src/mcp/schemas.ts`
**审查日期**: 2026-06-24
**审查结论**: Schema 与 Handler 之间存在若干不一致，error envelope 格式不统一，CoachReview contract 有边界漏洞。

---

## 1. Tool Schema 完整性

**评级: WARNING — 存在 1 处关键遗漏**

[schemas.ts](file:///d:/Code/git/devspace/src/mcp/schemas.ts) 定义了 19 个 tool schema，[handlers.ts](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L718-L741) 的 `handleToolCall` switch 语句也处理了 19 个 tool。数量一致。✅

但 **schema 字段与 handler 期望存在不一致**：

### C-1a. `start_delegate_run` 缺少 `allow_real_free_mode` 字段

**严重度: 高**

[schemas.ts:51-64](file:///d:/Code/git/devspace/src/mcp/schemas.ts#L51-L64) 定义了 `start_delegate_run` 的 properties：

```typescript
properties: {
  provider: ...,
  max_rounds: ...,
  timeout: ...,
  mode: ...,
  allow_free_mode: ...,
  allow_real_provider: ...,
  // ❌ 缺少 allow_real_free_mode
}
```

但 [handlers.ts:289](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L289) 中 handler 签名声明了 `allow_real_free_mode?: boolean`，且 [L311](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L311) 使用了 `args.allow_real_free_mode` 做第三层门控。

**影响**: MCP 客户端（如 ChatGPT）查看 schema 时不知道此字段存在，导致无法通过 schema 驱动的方式传入 `allow_real_free_mode: true`，从而无法启动 real+free 模式。MCP SDK 通常不强制校验额外字段，所以直接传入仍能工作，但违反了 schema 作为唯一接口文档的设计契约。

**对比**: `start_gated_loop` 的 schema 在 [L149](file:///d:/Code/git/devspace/src/mcp/schemas.ts#L149) **正确包含了** `allow_real_free_mode`。

### C-1b. `start_delegate_run` vs `start_gated_loop` schema 不一致

两个 tool 的 handler 签名完全相同（7 个参数），但 schema 定义不同：

| 字段 | `start_delegate_run` schema | `start_gated_loop` schema |
|------|---------------------------|--------------------------|
| `allow_real_free_mode` | ❌ 缺失 | ✅ 存在 |

这是一个明显的遗漏，应统一。

---

## 2. Input/Output Shape 一致性

**评级: WARNING**

### C-2a. `submit_coach_review` verdict 描述缺少 `PASS_WITH_WARNINGS`

[schemas.ts:107](file:///d:/Code/git/devspace/src/mcp/schemas.ts#L107) schema 描述：

```typescript
description: "Verdict: PASS/DONE/BLOCKED/NEED_USER/NEEDS_FIX/SAFETY_STOP/BUDGET_STOP"
```

但 [handlers.ts:517](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L517) 的 `validVerdicts` 数组包含 **8 个**值：

```typescript
const validVerdicts = ["PASS", "PASS_WITH_WARNINGS", "NEEDS_FIX", "BLOCKED", "DONE", "NEED_USER", "SAFETY_STOP", "BUDGET_STOP"];
```

**差异**: `PASS_WITH_WARNINGS` 存在于 handler 逻辑中但未出现在 schema 描述中。此外 schema 描述的顺序与 handler 数组的顺序也不同。

### C-2b. handler 属性解构与 schema 缺失不匹配

`handleStartDelegateRun` 的 TypeScript 签名：

```typescript
(args: {
  provider?: string;
  max_rounds?: number;
  timeout?: number;
  mode?: string;
  allow_free_mode?: boolean;
  allow_real_provider?: boolean;
  allow_real_free_mode?: boolean;  // schema 中缺失
}): unknown
```

由于 `callTool` 传入的 `args` 是 `Record<string, unknown>` 且未经 schema 校验，额外字段会透传到 handler。这意味着 `allow_real_free_mode` **实际上能工作**，但这依赖于 MCP SDK 不校验额外字段的行为，属于隐式契约。

### C-2c. 输出 shape 无 schema 约束

所有 handler 返回 `unknown` 类型。成功和失败的 shape 不统一：

**成功响应模式**:

| 模式 | 示例 |
|------|------|
| `{ status: "OK", ... }` | `start_delegate_run`, `create_next_task` |
| `{ status: "STARTED", ... }` | `start_delegate_run`, `start_gated_loop` |
| `{ status: "PAUSED" }` | `pause_delegate_run` |
| `{ status: "ANSWERED", file: ... }` | `answer_need_user` |
| `{ mode: ..., status: ..., ... }` | `get_delegate_status`（直接返回 JSON 文件内容） |
| `{ entries: [...], total_estimate: ... }` | `read_delegate_timeline` |
| `{ runs: [...] }` | `list_runs` |
| `{ files: { ... } }` | `read_handoff_summary` |

**错误响应模式**:

| 模式 | 示例 |
|------|------|
| `{ error: string, status: string }` | 大多数 handler |
| `{ error: string }` | `handleToolCall` default case |
| `{ error: string, entries: [] }` | `read_delegate_timeline` |
| `{ mode: null, ..., status: "NO_STATE" }` | `get_delegate_status`（无 `error` 字段） |

---

## 3. Error Envelope 格式

**评级: WARNING — 格式不统一**

### C-3a. 错误响应字段不一致

| Handler | `error` 字段 | `status` 字段 | 其他字段 |
|---------|-------------|--------------|---------|
| `get_delegate_status` (NO_STATE) | ❌ | ✅ `"NO_STATE"` | 返回所有字段为 null |
| `read_delegate_timeline` (No history) | ✅ `"No conversation history"` | ❌ | `entries: []` |
| `read_current_task` (Not found) | ✅ `"No task file found"` | ❌ | `source: null, content: null` |
| `read_run_artifacts` (No run_id) | ✅ `"run_id required"` | ❌ | — |
| `read_run_artifacts` (Traversal) | ✅ `"Invalid run_id (path traversal)"` | ❌ | — |
| `start_delegate_run` (Gate rejected) | ✅ | ✅ `"REJECTED"` | — |
| `start_delegate_run` (Lock) | ✅ | ✅ `"REJECTED"` | — |
| `handleToolCall` (Unknown tool) | ✅ | ❌ | — |

**问题**: MCP 客户端无法用统一的逻辑判断成功/失败。有些错误有 `status` 字段，有些没有；`get_delegate_status` 在无状态时不返回 `error` 字段而是返回带 `status: "NO_STATE"` 的对象。

**建议**: 定义统一的 error envelope：

```typescript
interface ToolError {
  error: string;
  status: string;     // "REJECTED" | "NO_STATE" | "INVALID_STATE" | "NOT_FOUND" | "INVALID_INPUT"
  details?: unknown;  // 可选的附加信息
}
```

### C-3b. `handleToolCall` default case 缺少 `status`

[handlers.ts:739](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L739):

```typescript
default: return { error: `Unknown tool: ${toolName}` };
```

缺少 `status` 字段，与大多数 error 响应不一致。同时 `callTool` 中的未知工具路径在 [tools.ts:21](file:///d:/Code/git/devspace/src/mcp/tools.ts#L21) 也返回相同格式——两处都缺少 `status`。

---

## 4. CoachReview Contract (`submit_coach_review`)

**评级: WARNING — 存在边界漏洞**

### C-4a. PASS verdict 的 next_task_content 强制检查 ✅

[handlers.ts:523-526](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L523-L526):

```typescript
if (args.verdict === "PASS" && !args.next_task_content) {
  return { error: "PASS verdict requires next_task_content", status: "REJECTED" };
}
```

PASS 必须附带 next_task_content，正确。✅

### C-4b. `PASS_WITH_WARNINGS` 不要求 `next_task_content` ⚠️

`PASS_WITH_WARNINGS` 被视为"带警告的通过"，但 handler 不要求 `next_task_content`。这意味着：

- 教练可以说"通过但有警告"而不提供下一个任务
- 下游的 `current_task.md` 不会被更新
- 下一个 run 启动后读取到的可能是过期任务

**风险**: 如果 `PASS_WITH_WARNINGS` 的意图是"继续执行但需注意"，则应要求 `next_task_content`。

### C-4c. 部分 verdict 不写入 run artifact ⚠️

| verdict | 写入 artifact | 说明 |
|---------|--------------|------|
| `DONE` | ✅ `final_report.md` | — |
| `BLOCKED` | ✅ `blocked_report.md` | — |
| `NEED_USER` | ✅ `user_question.md` | — |
| `PASS` | ❌ | next_task_content 写入 `current_task.md` 而非 run 目录 |
| `PASS_WITH_WARNINGS` | ❌ | 不写任何 artifact |
| `NEEDS_FIX` | ❌ | 不写任何 artifact |
| `SAFETY_STOP` | ❌ | 不写任何 artifact |
| `BUDGET_STOP` | ❌ | 不写任何 artifact |

**问题**: `NEEDS_FIX`、`SAFETY_STOP`、`BUDGET_STOP` 是运行终止条件，但不产生 run artifact。后续通过 `read_run_artifacts` 无法回溯这些 verdict 的具体原因。`reasoning_summary` 被忽略。

**建议**: 为 `NEEDS_FIX`、`SAFETY_STOP`、`BUDGET_STOP` 也写入对应的 report 文件（如 `needs_fix_report.md`、`safety_stop_report.md`、`budget_stop_report.md`）。

### C-4d. `next_task_content` 覆盖无保护

[handlers.ts:547-549](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L547-L549):

```typescript
if (args.next_task_content) {
  writeFileSync(join(DELEGATE_DIR, "current_task.md"), args.next_task_content, "utf-8");
}
```

任何包含 `next_task_content` 的 coach review（不论 verdict）都会覆盖 `current_task.md`。例如 `BLOCKED` + `next_task_content` 会静默更新当前任务，这可能不是预期行为。

---

## 5. next_task / No Fabrication

**评级: WARNING — 缺乏来源验证**

### C-5a. `create_next_task` 无来源验证

[handlers.ts:555-565](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L555-L565):

```typescript
export function handleCreateNextTask(args: { task_content: string; source?: string }): unknown {
  if (!args.task_content) { return REJECTED }
  writeFileSync(join(DELEGATE_DIR, "current_task.md"), args.task_content, "utf-8");
  return { status: "OK", file: "current_task.md" };
}
```

- `source` 参数仅用于审计，不验证内容来源。
- 任何 MCP 客户端都可以直接调用 `create_next_task` 替换当前任务内容。
- 无"从 coach_review 生成"的验证链。

### C-5b. `submit_coach_review` 的 PASS 也能更新 next_task

`handleSubmitCoachReview` 在 verdict 为 PASS 时同样写入 `current_task.md`。这提供了两条独立路径来更新下一个任务：

1. `submit_coach_review`（PASS verdict + next_task_content）
2. `create_next_task`（直接写入）

没有机制确保只有一条路径被使用，也没有 mutex 或时间戳验证来防止竞态覆盖。

### C-5c. "No Fabrication" 缺乏实现

系统设计意图是教练审查后才能产生下一个任务（"no fabrication"语义），但实际上：

- `create_next_task` 不检查是否存在对应的 coach review
- `approve_next_run` 不验证 task 内容是否来自合法的 review 流程
- MCP 客户端可以跳过 `submit_coach_review` 直接调用 `create_next_task` + `approve_next_run` + `start_gated_loop`

---

## 6. Approval Gate Semantics (`approve_next_run`)

**评级: PASS (基本正确)，存在若干设计问题**

### C-6a. Task hash 绑定 ✅

[handlers.ts:567-594](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L567-L594):

```typescript
const currentHash = createHash("sha256").update(taskContent).digest("hex").substring(0, 16);

if (args.task_hash && args.task_hash !== currentHash) {
  return { error: "Task has changed since approval. Re-approve.", status: "REJECTED" };
}
```

当提供 `task_hash` 时，与当前 `current_task.md` 的 SHA-256 前 16 位比较，防止审批和执行之间 task 被篡改。✅

### C-6b. `task_hash` 参数是可选的 ⚠️

`approve_next_run` 的 schema 中 `task_hash` 不在 `required` 中。如果客户端不传 `task_hash`：

- 跳过哈希验证
- 审批直接创建
- 但 `start_gated_loop` 中 `consumeApproval` 用当前 task hash 去匹配，所以仍然匹配

这意味着 `approve_next_run` 不传 `task_hash` 是安全的（因为 `consumeApproval` 会验证），但丧失了"在审批时快照 task 内容"的语义。

### C-6c. Approval 一次性消费 ✅

[consumeApproval](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L597-L611):

```typescript
if (data.task_hash === taskHash && !data.used) {
  data.used = true;
  writeFileSync(join(APPROVALS_DIR, file), JSON.stringify(data, null, 2), "utf-8");
  return true;
}
```

匹配后立即将 `used` 标记为 `true` 并写回。一次审批只能启动一次 real provider run。✅

### C-6d. 多 approval 时的文件遍历顺序不确定 ⚠️

`readdirSync` 返回的文件顺序不保证。如果有多个未使用的 approval 匹配同一 task hash，消费哪个取决于文件系统遍历顺序。在实际使用中很少出现（通常一次只有一个 pending approval），但属于隐式行为。

### C-6e. Approval 在 contract 检查之前被消费 (start_gated_loop)

[handlers.ts:643-657](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L643-L657):

```typescript
// L643: 消费 approval
if (isReal) {
  if (!consumeApproval(taskHash)) { return REJECTED }
}

// L654: 检查 contract
if (!existsSync(join(CEO_DIR, "delegate_contract.md"))) {
  return { error: "Missing delegate_contract.md", status: "REJECTED" };
}
```

如果 approval 成功消费但 contract 缺失，run 被拒绝但 approval 已被浪费。用户需要重新审批。

**建议**: 将 contract 检查移到 approval 消费之前。

---

## 7. `start_gated_loop` 默认值

**评级: PASS**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `provider` | `"mock"` | 安全默认——不使用真实 API ✅ |
| `max_rounds` | `1` | 最小循环次数 ✅ |
| `timeout` | `30` 秒 | 合理的超时 ✅ |
| `mode` | `"delegate"` | 标准自治模式（非 free）✅ |

所有默认值都是最保守的选择。MCP 客户端必须显式传参才能解锁更高权限。

**对比**: `start_delegate_run` 的默认值完全一致。✅

**细微差异**: `start_gated_loop` 在 [L654](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L654) 只检查 `delegate_contract.md`，而 `start_delegate_run` 在 [L317-L324](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L317-L324) 同时检查 `delegate_contract.md` 和 `stop_conditions.md`。`start_gated_loop` 缺少 `stop_conditions.md` 检查。⚠️

---

## 额外合约发现

### C-8. `handleValidateHandoff` 动态导入 fallback 不完整

[handlers.ts:143-156](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L143-L156):

```typescript
try {
  const { validateHandoffPackage } = await import("../delegate/handoff.js");
  return validateHandoffPackage();
} catch {
  // fallback: 只检查文件存在性
}
```

如果 `../delegate/handoff.js` 不存在（模块缺失），fallback 只验证两个文件的存在性，不验证内容有效性。这意味着在缺少依赖的环境中，`validate_handoff` 可能返回 `valid: true` 但实际 handoff 内容无效。

### C-9. `handleStopDelegateRun` 不检查前置状态

[handlers.ts:413-430](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L413-L430):

`handleStopDelegateRun` 不检查当前 `state.status` 是否为可停止的状态。即使系统已经处于 `DONE` 状态，仍然可以调用 stop（设置 stop_reason 并释放锁）。

**对比**: `handlePauseDelegateRun` 在 [L380](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L380) 检查 `state.status !== "DELEGATE_RUNNING" && state.status !== "LOCAL_EXECUTING"` 才允许暂停。

### C-10. `handleReadDelegateTimeline` 使用 `require()` 而非 import

[handlers.ts:76](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L76):

```typescript
const { statSync, readSync, openSync, closeSync } = require("node:fs");
```

文件顶部已有 `openSync`、`closeSync` 的 ESM import。此处 `require()` 重复引入且引入了额外的 `statSync`、`readSync`，应统一为顶部 import。

### C-11. Audit args_summary 截断可能导致不可追溯

[audit.ts:37](file:///d:/Code/git/devspace/src/mcp/audit.ts#L37):

```typescript
args_summary: JSON.stringify(args).substring(0, 200)
```

200 字符对于 `submit_coach_review` 的 `next_task_content`（可能很长的 markdown）或 `create_handoff_from_webgpt` 的 `contract_md` 来说远远不够。审计日志中无法追溯实际提交的内容。

**建议**: 记录 content 的哈希值而非截断内容，以便后续完整性验证。

---

## 总结

| 检查项 | 结果 | 严重度 |
|--------|------|--------|
| Schema 字段完整性 | `start_delegate_run` 缺少 `allow_real_free_mode` | **高** |
| Verdict 描述一致性 | schema 描述缺少 `PASS_WITH_WARNINGS` | 中 |
| Error envelope 统一性 | 格式不统一，部分缺少 `status` | 中 |
| CoachReview PASS 要求 | PASS 正确要求 next_task_content ✅ | — |
| CoachReview PASS_WITH_WARNINGS | 不要求 next_task_content | 低 |
| CoachReview verdict artifact | 4 个 verdict 不写 artifact | 中 |
| next_task 来源验证 | 缺乏 "no fabrication" 机制 | 中 |
| Approval gate 基本语义 | 一次性消费、hash 绑定 ✅ | — |
| Approval 顺序问题 | 在 contract 检查前消费 | 低 |
| start_gated_loop 默认值 | 安全默认 ✅ | — |
| start_gated_loop 缺少 stop_conditions 检查 | 与 start_delegate_run 不一致 | 低 |
| 动态导入 fallback | 内容验证被跳过 | 低 |
| stop 不检查前置状态 | 可从任意状态 stop | 低 |
| ESM/CJS 混用 | require() 重复引入 | 低 |

**建议优先处理**:

1. **C-1a** (高): 为 `start_delegate_run` schema 补充 `allow_real_free_mode` 字段
2. **C-2a** (中): 为 `submit_coach_review` schema description 补充 `PASS_WITH_WARNINGS`
3. **C-3a** (中): 统一 error envelope 格式
4. **C-4c** (中): 为终止性 verdict 写入 run artifact
5. **C-6e** (低): 调整 `start_gated_loop` 中 contract 检查的顺序
