# Security Review

**审查范围**: `src/mcp/handlers.ts`, `src/mcp/audit.ts`, `src/mcp/tools.ts`, `src/mcp/schemas.ts`, `src/mcp/server.ts`
**审查日期**: 2026-06-24

---

## Path Traversal

### 机制

`safePath()` ([handlers.ts:L10-16](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L10-L16)) 通过三层防护防止路径穿越：

1. `resolve(DELEGATE_DIR, requestedPath)` 将相对路径解析为绝对路径
2. `full.startsWith(base)` 确保结果路径在 `.devspace/` 目录下
3. `full.includes("..")` 作为额外防御层（在 resolve 之后已冗余，但有益于纵深防御）

### 分析

**绝对路径注入**: 如果传入 `/etc/passwd`，`resolve(".devspace", "/etc/passwd")` 会返回 `/etc/passwd`（Node.js resolve 的特性：遇到绝对路径会忽略前面的参数）。`startsWith` 检查会捕获这种情况。**安全**。

**路径遍历序列**: 如果传入 `../../etc/passwd`，`resolve` 会将其解析为 `.devspace` 上两级的路径，`startsWith` 检查会拒绝。smoke test 中也覆盖了此场景（[server.ts:L167](file:///d:/Code/git/devspace/src/mcp/server.ts#L167)）。**安全**。

**前缀碰撞**: 如果 `.devspace` 的绝对路径是 `/foo/.devspace`，是否存在 `/foo/.devspace_evil` 绕过的可能？`resolve(DELEGATE_DIR)` 返回的是精确路径（如 `/foo/.devspace`），加上路径分隔符 `/` 会被 resolve 自动处理。**安全**。

**符号链接**: `resolve()` **不** 解析符号链接（`realpath()` 才会）。如果 `.devspace/` 内部存在指向外部目录的符号链接，`resolve` 后的路径仍然以 `.devspace/` 开头，`startsWith` 检查会通过。然而，利用此漏洞需要预先对 `.devspace/` 目录具有写入权限（创建符号链接），而 MCP 工具本身不提供创建符号链接的能力。**风险低，需要预置条件**。

### 结论

`safePath()` 在当前威胁模型下是有效的。唯一的理论风险是符号链接，但需要外部写入权限作为前提条件。

---

## API Key / Env Leaks

### 分析

**MCP handler 层**: `src/mcp/` 目录下的所有文件中**没有** `process.env` 的使用。MCP 工具不直接读取或暴露环境变量。

**主服务层**: API key 仅在 [cli.ts:L920-936](file:///d:/Code/git/devspace/src/cli.ts#L920-L936) 的 provider 初始化中使用，通过 `process.env.OPENAI_API_KEY` 等读取，这些值不会通过 MCP 工具返回给客户端。

**审计日志泄露**: `createAuditEntry` ([audit.ts:L26-41](file:///d:/Code/git/devspace/src/mcp/audit.ts#L26-L41)) 将 `args_summary` 截断到 200 字符并写入 `.devspace/mcp_audit.jsonl`。当前所有工具的参数模式中不包含 API key 字段，但 `args_summary` 会记录完整参数（截断后）。如果未来添加接受敏感参数的工具，审计日志可能成为泄露点。

**错误消息**: 错误响应中包含内部路径信息（如 `File not found: ${filePath}`），暴露了目录结构，但不包含敏感凭证。

### 结论

当前无 API key / 环境变量泄露。审计日志的 `args_summary` 字段在未来扩展时需注意。

---

## Provider Gate

### 机制

[start_delegate_run handler](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L254-L258) 中：

```typescript
const isReal = provider === "ollama" || provider === "openai";
if (isReal && !args.allow_real_provider) {
    return { error: ..., status: "REJECTED" };
}
```

### 分析

**大小写绕过**: 检查使用 `===` 严格相等，传入 `"OpenAI"`、`"OPENAI"`、`"ollama "` 等变体会绕过检查。但这些变体在 cli.ts 的 provider 工厂函数中会被 `default` 分支拒绝（`throw new Error("Unknown executor provider")`），因此即使绕过 MCP 层的检查，实际执行也会失败。**风险低**。

**布尔参数伪造**: `allow_real_provider` 是一个简单的布尔参数，任何 MCP 客户端都可以设置为 `true`。这是**设计如此**——它是一个安全门控（safety gate），不是访问控制（access control）。其目的是防止意外使用真实 provider，而非强制授权。真正的认证在 HTTP MCP 服务器的 OAuth 层（[server.ts:L1279-1282](file:///d:/Code/git/devspace/src/server.ts#L1279-L1282)）。

**preview_delegate_run 不执行门控**: `handlePreviewDelegateRun` ([handlers.ts:L184-188](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L184-L188)) 中 `checks.provider.ok` 始终为 `true`，即使未设置 `allow_real_provider`。这意味着 preview 会报告 `would_run: true`，但实际 `start_delegate_run` 会拒绝。这是**误导性行为**，但不构成安全漏洞（preview 不执行任何操作）。

### 结论

Provider gate 作为安全门控正常工作。布尔参数可被客户端设置为 true 是设计意图。preview 与 start 的行为不一致是一个 UX 缺陷。

---

## Free Mode Gate

### 机制

[start_delegate_run handler](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L248-L251) 中：

```typescript
if (mode === "free" && !args.allow_free_mode) {
    return { error: ..., status: "REJECTED" };
}
```

### 分析

**绕过方式**: 与 provider gate 相同——大小写变体（`"FREE"`、`"Free"`）可以通过字符串检查。但 delegate 系统只会识别精确的 `"free"` 模式，变体不会被解释为 free mode。

**布尔参数伪造**: 同 provider gate，`allow_free_mode` 可被客户端设置为 `true`。这是安全门控，不是访问控制。

**preview 一致性**: preview_delegate_run 中 `checks.mode.ok` 也始终为 `true`，与实际门控行为不一致。

### 结论

Free mode gate 作为安全门控正常工作。与 provider gate 存在相同的 UX 一致性问题。

---

## Audit Log

### 机制

审计系统（[audit.ts](file:///d:/Code/git/devspace/src/mcp/audit.ts)）将 JSONL 条目追加到 `.devspace/mcp_audit.jsonl`。

### 分析

**已覆盖的操作**:
| 操作 | 审计状态 |
|------|----------|
| start_delegate_run | ✅ 所有路径（REJECTED / STARTED） |
| pause_delegate_run | ✅ 所有路径（NO_STATE / INVALID_STATE / PAUSED） |
| resume_delegate_run | ✅ 所有路径（NO_STATE / INVALID_STATE / RESUMED） |
| stop_delegate_run | ✅ 所有路径（NO_STATE / STOPPED） |
| answer_need_user | ✅ 所有路径（INVALID_INPUT / INVALID_DECISION / ANSWERED） |

**未覆盖的操作**:
| 操作 | 审计状态 | 风险 |
|------|----------|------|
| get_delegate_status | ❌ 未审计 | 低（无参数，只读） |
| read_delegate_timeline | ❌ 未审计 | 低（只读） |
| read_current_task | ❌ 未审计 | 低（只读） |
| read_handoff_summary | ❌ 未审计 | 低（只读） |
| read_run_artifacts | ❌ 未审计 | **中**（接受用户输入 `run_id`，路径遍历尝试不可追踪） |
| validate_handoff | ❌ 未审计 | 低（只读） |
| list_runs | ❌ 未审计 | 低（只读） |
| preview_delegate_run | ❌ 未审计 | 低（只读，不执行） |

**顶层审计缺失**: `callTool` ([tools.ts:L19-31](file:///d:/Code/git/devspace/src/mcp/tools.ts#L19-L31)) 仅在 `TOOL_SCHEMAS[name]` 未找到（UNKNOWN_TOOL）或 handler 抛出异常（ERROR）时审计。**成功的工具调用不会在 callTool 层被审计**。审计完全依赖各 handler 内部的显式调用。

**路径遍历尝试不可追踪**: 由于 `read_run_artifacts` 不审计其调用，恶意路径遍历尝试（如 `run_id: "../../package.json"`）虽然会被 `safePath` 拒绝，但不会留下任何审计记录。

### 结论

审计日志不完整。所有写操作已覆盖，但读操作（特别是接受用户输入的 `read_run_artifacts`）未被审计。建议在 `callTool` 顶层添加统一审计。

---

## Source Code Protection

### 分析

**写操作目标**: MCP 工具的所有写入操作都限制在 `.devspace/` 目录内：
- `handleStartDelegateRun`: 写入 `.devspace/state.json` 和 `.devspace/runs/<runId>/run_state.json`
- `handlePauseDelegateRun` / `handleResumeDelegateRun` / `handleStopDelegateRun`: 仅修改 `.devspace/state.json`
- `handleAnswerNeedUser`: 写入 `.devspace/user_answers/answer-<timestamp>.json`
- `acquireRunLock`: 写入 `.devspace/run.lock`

**读操作范围**: 所有读操作通过 `safePath()` 限制在 `.devspace/` 内。没有任何工具提供对项目源码的读取能力。

**动态 require**: `handleValidateHandoff` ([handlers.ts:L113](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L113)) 使用 `require("../delegate/handoff.js")` 加载模块。路径是硬编码的，不是用户输入。**安全**。

**delegate 系统的越权风险**: MCP 的 `start_delegate_run` 工具启动 delegate 运行后，delegate 系统本身（`LocalOrchestratorV2`）可能具有文件操作能力。MCP 层无法控制 delegate 运行期间的行为。但 delegate 的文件操作能力由 `cli.ts` 中的 provider 配置决定，不在 MCP 的直接控制范围内。

### 结论

MCP 工具本身**不能**修改项目源码。所有操作被沙箱化在 `.devspace/` 目录内。delegate 运行期间的行为超出 MCP 层的控制范围。

---

## Issues Found

### P1 - 审计日志不完整（中风险）

**位置**: [tools.ts:L19-31](file:///d:/Code/git/devspace/src/mcp/tools.ts#L19-L31)
**描述**: `callTool` 不审计成功的工具调用。读操作（特别是 `read_run_artifacts`）不记录审计日志，导致路径遍历尝试无法追踪。
**建议**: 在 `callTool` 中对所有工具调用添加统一审计，或至少对接受用户输入的读操作添加审计。

### P2 - preview_delegate_run 门控行为误导（低风险）

**位置**: [handlers.ts:L184-188](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L184-L188)
**描述**: `preview_delegate_run` 中 `checks.provider.ok` 和 `checks.mode.ok` 始终返回 `true`，即使未设置 `allow_real_provider` / `allow_free_mode`。这导致 `would_run: true` 与实际 `start_delegate_run` 的拒绝行为不一致。
**建议**: preview 中应检查对应的 `allow_*` 参数，或在返回结果中明确标注需要额外授权。

### P3 - 符号链接穿越（低风险）

**位置**: [handlers.ts:L10-16](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L10-L16)
**描述**: `safePath()` 使用 `resolve()` 而非 `realpath()`，不解析符号链接。理论上，如果攻击者能在 `.devspace/` 内创建符号链接，可读取外部文件。
**缓解因素**: MCP 工具不提供创建符号链接的能力，需要外部写入权限。
**建议**: 如需加固，可在 `safePath` 中增加 `realpath()` 校验（需处理文件不存在的情况）。

### P4 - Provider/Free Mode Gate 为软门控（信息性）

**位置**: [handlers.ts:L248-L258](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L248-L258)
**描述**: `allow_real_provider` 和 `allow_free_mode` 是客户端布尔参数，可被任意 MCP 客户端设置为 `true`。这是设计意图（安全门控而非访问控制），但应明确文档化。真正的访问控制在 HTTP MCP 服务器的 OAuth 层。
**建议**: 在 schema description 中明确说明这些是"客户端确认"而非"服务端授权"。

### P5 - run.lock 存在 TOCTOU 竞态（低风险）

**位置**: [handlers.ts:L215-221](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L215-L221)
**描述**: `acquireRunLock` 先检查文件是否存在，再写入文件，存在 TOCTOU（Time-of-Check-Time-of-Use）竞态条件。并发请求可能同时通过检查并创建锁。
**缓解因素**: MCP stdin 模型通常是串行处理的。
**建议**: 使用 `writeFileSync` 的 `wx`（exclusive）标志，或使用 `mkdirSync`（原子操作）替代文件锁。

### P6 - 错误消息泄露内部路径（信息性）

**位置**: [handlers.ts:L21](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L21) 等
**描述**: 错误消息包含内部文件路径（如 `File not found: current_task.md`），暴露目录结构。
**风险**: 极低，路径仅在 `.devspace/` 内部。

---

## Verdict

**PASS**（附带改进建议）

MCP 实现的整体安全性可接受。核心安全机制（路径沙箱、写操作隔离）工作正常。主要改进点是审计日志的完整性（P1），建议优先修复。其余问题为低风险或设计层面的信息性提示。
