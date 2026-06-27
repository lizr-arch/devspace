# Contract Review

**审查范围**: `src/mcp/schemas.ts`, `src/mcp/handlers.ts`, `src/mcp/tools.ts`
**关联对照**: `src/delegate/orchestrator.ts`, `src/delegate/handoff.ts`, `src/delegate/schemas.ts`, `src/delegate/permissions.ts`, `src/mcp/server.ts`, `src/mcp/audit.ts`

---

## Tool Schema

### inputSchema 与 handler 参数对照

| Tool | Schema 参数 | Handler 参数 | 一致性 |
|------|-----------|-------------|--------|
| `get_delegate_status` | `{}` | 无参数 | ✅ |
| `read_delegate_timeline` | `{ limit?: number }` | `{ limit?: number }` | ✅ |
| `read_current_task` | `{}` | 无参数 | ✅ |
| `read_handoff_summary` | `{}` | 无参数 | ✅ |
| `read_run_artifacts` | `{ run_id: string }` required | `{ run_id: string }` | ✅ |
| `validate_handoff` | `{}` | 无参数 | ✅ |
| `list_runs` | `{}` | 无参数 | ✅ |
| `preview_delegate_run` | `{ provider?, max_rounds?, timeout?, mode? }` | 同上 | ✅ |
| `start_delegate_run` | `{ provider?, max_rounds?, timeout?, mode?, allow_free_mode?, allow_real_provider? }` | 同上 | ✅ |
| `pause_delegate_run` | `{}` | 无参数 | ✅ |
| `resume_delegate_run` | `{}` | 无参数 | ✅ |
| `stop_delegate_run` | `{}` | 无参数 | ✅ |
| `answer_need_user` | `{ answer: string, decision: string }` required | 同上 | ✅ |

### Schema 问题

1. **description 覆盖不一致**: `start_delegate_run` 的每个 property 都有 `description`，但 `preview_delegate_run` 的 property 全部缺少 `description`。两者参数相同，风格应统一。

2. **缺少 enum 约束**: 以下参数有隐含的枚举值但 schema 未声明 `enum`：
   - `provider`: 应为 `enum: ["mock", "ollama", "openai"]`
   - `mode`: 应为 `enum: ["delegate", "free"]`
   - `decision`: 应为 `enum: ["continue", "skip", "abort"]`

3. **`preview_delegate_run` 的 `mode` 缺少 description**: 与 `start_delegate_run` 中 `mode` 有详细描述形成对比。

---

## Input/Output Structure

### 成功返回格式

| Tool | 返回结构 |
|------|---------|
| `get_delegate_status` | `GlobalState` 对象（直接透传 `state.json` 或兜底对象） |
| `read_delegate_timeline` | `{ entries: unknown[], total: number }` |
| `read_current_task` | `{ source: string, content: string }` |
| `read_handoff_summary` | `{ files: Record<string, string \| null> }` |
| `read_run_artifacts` | `{ run_id: string, artifacts: Record<string, string \| null> }` |
| `validate_handoff` | `{ valid: boolean, errors: string[], warnings: string[] }` |
| `list_runs` | `{ runs: Array<{ run_id, state }> }` |
| `preview_delegate_run` | `{ would_run, provider, max_rounds, timeout, mode, checks }` |
| `start_delegate_run` | `{ status: "STARTED", run_id, provider, max_rounds, timeout, mode }` |
| `pause_delegate_run` | `{ status: "PAUSED", previous_status }` |
| `resume_delegate_run` | `{ status: "RESUMED" }` |
| `stop_delegate_run` | `{ status: "STOPPED", previous_status }` |
| `answer_need_user` | `{ status: "ANSWERED", file }` |

### 不一致问题

1. **无统一信封 (envelope)**: 成功返回没有统一的 `{ ok: true, data: ... }` 结构。每个 tool 返回完全不同的 shape，调用方需要逐个适配。

2. **`get_delegate_status` 兜底返回与正常返回同构**: 当 `state.json` 不存在时，返回一个带 `status: "NO_STATE"` 的对象，但没有 `error` 字段。调用方无法通过统一的 `error` 字段判断是否出错，只能检查 `status` 值。

3. **`list_runs` 无法区分成功与失败**: 目录不存在时返回 `{ runs: [] }`，正常空结果也是 `{ runs: [] }`。错误被静默吞掉。

4. **`validate_handoff` 使用 `errors` 数组而非 `error` 字符串**: 其他 tool 的错误用 `{ error: string }`，这个用 `{ errors: string[] }`。语义不同但都是"错误"。

---

## Error Shape

### 错误返回格式汇总

| 来源 | 格式 |
|------|------|
| `tools.ts` callTool catch | `{ error: string }` |
| `tools.ts` unknown tool | `{ error: string }` |
| `server.ts` 方法未找到 | JSON-RPC error `{ code: -32601, message }` |
| `server.ts` JSON 解析失败 | JSON-RPC error `{ code: -32700, message }` |
| handlers 写操作拒绝 | `{ error: string, status: "REJECTED" }` |
| handlers 状态无效 | `{ error: string, status: "INVALID_STATE" \| "NO_STATE" \| ... }` |
| handlers 输入无效 | `{ error: string, status: "INVALID_INPUT" \| "INVALID_DECISION" }` |
| `read_delegate_timeline` | `{ error: string, entries: [] }` |
| `read_current_task` | `{ error: string, source: null, content: null }` |
| `read_run_artifacts` | `{ error: string }` |
| `validate_handoff` | `{ valid: false, errors: string[], warnings: [] }` |
| `get_delegate_status` | 无 error 字段，用 `status: "NO_STATE"` 暗示 |
| `list_runs` | 无 error 字段，静默返回 `{ runs: [] }` |

### 问题

1. **错误格式碎片化**: 至少 5 种不同的错误表示方式。调用方需要写大量条件分支来判断是否出错。

2. **MCP 协议层错误未利用**: [server.ts](file:///d:/Code/git/devspace/src/mcp/server.ts#L37-L49) 中 `tools/call` 把所有 handler 返回（包括错误）都包装为成功的 MCP response。handler 级别的错误永远不会产生 JSON-RPC error。这是有意设计（错误作为 content 返回），但与 `initialize`/`tools/list` 的错误处理方式不一致。

3. **`handleValidateHandoff` 的 try/catch 中使用 `require()`**: [handlers.ts:L113](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L113) 使用 `require("../delegate/handoff.js")` 动态导入。项目使用 ESM（import 用 `.js` 后缀），`require()` 在 ESM 上下文中不可用，运行时会抛错。fallback 分支只检查文件存在性，不调用 `validateHandoffPackage()` 的完整验证逻辑。

4. **`handlePauseDelegateRun` 返回错误的 `previous_status`**: [handlers.ts:L335-L339](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L335-L339) 中，`state.status` 在第 335 行被改为 `"READY_TO_DELEGATE"`，然后第 339 行返回 `previous_status: state.status`，此时已经是新值。**这是一个 bug**，应先保存原值再修改。

---

## CLI / Orchestrator Bypass

### 核心发现：MCP handlers 绕过 `LocalOrchestrator`，直接操作文件系统

| 操作 | Orchestrator 实现 | MCP Handler 实现 | 绕过? |
|------|------------------|-----------------|-------|
| 读取 state | `loadState()` + `validateState()` | 直接 `readFileSync` + `JSON.parse`，无验证 | ⚠️ 绕过验证 |
| 写入 state | `saveState()` + `this.state` 内存模型 | 直接 `writeFileSync` 写 JSON | ⚠️ 绕过内存模型 |
| 写入 run_state | `saveRunState()` + `validateRunState()` | 直接 `writeFileSync`，无验证 | ⚠️ 绕过验证 |
| pause/resume/stop | `orchestrator.pause()` 等 + `logConversation()` | 直接改 state.json + `writeAudit()` | ⚠️ 无 conversation log |
| start run | `executeCurrentTask()` 完整流程 | 只写 state 文件，不执行任何任务 | ⚠️ 空壳 |
| validate handoff | `handoff.validateHandoffPackage()` | 尝试 `require()` + fallback | ⚠️ fallback 降级 |

### 详细分析

1. **状态验证被跳过**: Orchestrator 使用 `validateState()` 和 `validateRunState()` 校验写入的状态对象。MCP handler 直接构造对象写入，没有经过验证。如果 handler 构造了非法状态（如无效的 `status` 值），orchestrator 读取时 `validateState()` 会失败，回退到默认状态。

2. **Conversation Timeline 丢失**: Orchestrator 的 `pause()`、`resume()`、`stop()` 都会调用 `logConversation()` 写入 `conversation.jsonl`。MCP handler 只写 `mcp_audit.jsonl`。这意味着通过 MCP 控制的 run 不会在 conversation timeline 中留下记录，`read_delegate_timeline` 读不到这些操作。

3. **`handleStartDelegateRun` 是空壳**: 它只创建 state 文件和 run 目录，不调用 provider，不执行任务。run_state 中 `next_actor: "local_orchestrator"` 表明期望 orchestrator 接管，但没有触发机制。这本身可能是有意设计（MCP 只做状态管理），但 schema description 说 "Start a delegate run" 具有误导性。

4. **`handleValidateHandoff` 的 `require()` 问题**: [handlers.ts:L113](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L113) 使用 CommonJS `require()` 在 ESM 项目中。如果 `require` 不可用（ESM 环境），会直接跳到 fallback，只做文件存在性检查，跳过 `validateDelegateContract()` 和 `validateStopConditions()` 的格式验证。

5. **Run ID 格式不一致**: MCP handler 生成 `run-mcp-${Date.now()}`，orchestrator 生成 `run-${Date.now()}`。两个来源的 run 在 `list_runs` 中混合显示，但 ID 前缀不同，可能造成混淆。

---

## Semantic Consistency

### Provider 语义

- `start_delegate_run` 接受 `provider` 参数并写入返回值，但**不实际调用任何 provider**。真正的 provider 调用在 orchestrator 的 `callLocalModel()` 中，且只支持 Ollama。
- `preview_delegate_run` 的 provider 检查仅标记 "requires allow_real_provider"，不验证 provider 是否真的可用。
- Schema 描述 `provider: "mock/ollama/openai (default: mock)"` 暗示三者等价，但实际上 mock 是唯一不需要额外配置的。

### Run 语义

- `start_delegate_run` 创建的 run 是"已声明但未执行"的状态。`status: "DELEGATE_RUNNING"` 和 `next_actor: "local_orchestrator"` 表明需要 orchestrator 介入，但 MCP 层没有触发机制。
- `stop_delegate_run` 无条件停止，不检查 run 是否真的在执行中（只检查 state.json 存在且不是 DONE）。
- `pause_delegate_run` 只接受 `DELEGATE_RUNNING` 和 `LOCAL_EXECUTING` 状态，但 `resume_delegate_run` 只接受 `READY_TO_DELEGATE`。这个转换链是正确的，但依赖 handler 内部硬编码的状态值，而非使用 `getNextStatus()` 状态机。

### Mode 语义

- `mode` 参数直接写入 `state.json` 的 `mode` 和 `autonomy_level` 字段。
- **未调用 `canEnterMode()`**: Orchestrator 层有 `canEnterMode()` 函数检查 mode 切换的合法性（如 free mode 需要 medium/high risk tolerance），但 MCP handler 只检查 `allow_free_mode` flag。两套校验逻辑不一致。
- `delegate` mode 和 `free` mode 的区别仅在于 `allow_free_mode` gate，没有与 `delegate_contract.md` 中的 `acceptable_risk_level` 联动。

### 审计 (Audit) 一致性

- 所有写操作都正确调用了 `writeAudit()`，这是好的。
- 但 audit 只写 `mcp_audit.jsonl`，不写 `conversation.jsonl`。两个日志系统的覆盖范围不同。

---

## Issues Found

### Critical

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| C1 | `handlePauseDelegateRun` 返回错误的 `previous_status`（返回修改后的值而非原值） | [handlers.ts:L335-L339](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L335-L339) | 调用方无法得知暂停前的真实状态 |
| C2 | `handleValidateHandoff` 使用 `require()` 在 ESM 项目中，fallback 跳过完整验证 | [handlers.ts:L113](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L113) | 验证结果不可靠 |

### Major

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| M1 | MCP handler 直接写 state.json，绕过 orchestrator 的 `validateState()` | [handlers.ts:L284-L308](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L284-L308) | 可能写入非法状态 |
| M2 | MCP handler 不写 `conversation.jsonl`，orchestrator 的 conversation timeline 不完整 | [handlers.ts](file:///d:/Code/git/devspace/src/mcp/handlers.ts) 全部写操作 | 通过 MCP 控制的操作在 timeline 中不可见 |
| M3 | 状态转换硬编码，未使用 `getNextStatus()` 状态机 | [handlers.ts:L335](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L335), [L355](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L355), [L371](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L371) | 可能跳过合法的状态转换路径 |
| M4 | `start_delegate_run` 未调用 `canEnterMode()` 校验 mode 合法性 | [handlers.ts:L248](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L248) | 与 orchestrator 的 mode 校验逻辑不一致 |
| M5 | Run ID 前缀不一致：`run-mcp-` vs `run-` | [handlers.ts:L281](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L281) vs [orchestrator.ts:L190](file:///d:/Code/git/devspace/src/delegate/orchestrator.ts#L190) | 不同来源的 run 混合显示 |

### Minor

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| m1 | `preview_delegate_run` 的 properties 缺少 `description` | [schemas.ts:L41-L49](file:///d:/Code/git/devspace/src/mcp/schemas.ts#L41-L49) | MCP 客户端展示不友好 |
| m2 | `provider`/`mode`/`decision` 缺少 `enum` 约束 | [schemas.ts](file:///d:/Code/git/devspace/src/mcp/schemas.ts) | 无效值延迟到运行时才发现 |
| m3 | 错误返回格式碎片化（至少 5 种格式） | [handlers.ts](file:///d:/Code/git/devspace/src/mcp/handlers.ts) 全局 | 调用方适配成本高 |
| m4 | `get_delegate_status` 兜底返回无 `error` 字段 | [handlers.ts:L44-L51](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L44-L51) | 无法统一判断是否出错 |
| m5 | `list_runs` 吞掉错误，返回 `{ runs: [] }` | [handlers.ts:L131-L146](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L131-L146) | 无法区分"无 run"和"读取失败" |
| m6 | `handleReadDelegateTimeline` 的 `safeRead` 返回结果未正确使用 `!` 断言 | [handlers.ts:L59](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L59) | `result.content!` 在 `result.ok` 为 true 时安全，但风格不够防御 |

---

## Verdict

**FAIL** — 存在 2 个 Critical 问题和 5 个 Major 问题需要修复。

### 建议优先级

1. **P0 (立即修复)**: C1 `previous_status` bug — 单行修复，影响运行时行为正确性
2. **P0 (立即修复)**: C2 `require()` → 改用 dynamic `import()` 或直接 `import` 顶层引用
3. **P1 (短期)**: M1-M4 — 统一通过 orchestrator 或共享 validator 操作状态，避免两套状态管理逻辑
4. **P2 (中期)**: m1-m6 — 完善 schema 描述、统一错误格式、增加 enum 约束
