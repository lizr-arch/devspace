# MCP-v2 Security Review

**审查范围**: `src/mcp/handlers.ts`, `src/mcp/tools.ts`, `src/mcp/audit.ts`, `src/mcp/schemas.ts`
**审查日期**: 2026-06-24
**审查结论**: 整体安全设计合理，存在若干中低风险问题需关注。

---

## 1. API Key / Environment Variable 泄露

**评级: PASS (无风险)**

MCP handler 层不读取任何环境变量，不存储或传递 API key。所有 provider（mock/ollama/openai）仅以字符串标识名传递，实际 API 调用由下游 orchestrator 处理，不在本层发生。

**一处关注点**:

- [handlers.ts:38](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L38) — `createAuditEntry` 将 `args` 序列化为 `args_summary`（截断至 200 字符）。如果 MCP 客户端在未来扩展中向 args 传入敏感数据，会被写入 `mcp_audit.jsonl` 明文。当前无实际泄露，但属于潜在风险面。

---

## 2. Path Traversal — `safePath` 函数

**评级: PASS (有效防护)**

[safePath](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L12-L28) 的防御链:

1. `resolve(DELEGATE_DIR, requestedPath)` — 将相对路径解析为绝对路径并 normalize `..` 段
2. `!full.startsWith(base)` — 确保解析后路径仍在 `.devspace/` 内
3. `full.includes("..")` — 二次确认无 `..` 残留（belt-and-suspenders）

**分析**:

- `resolve()` 会先 normalize 路径，所以 `../../etc/passwd` 会被正确解析为绝对路径，然后被 `startsWith` 拦截。✅
- `includes("..")` 检查会误拦截以 `..` 开头的合法目录名（如 `..hidden`），但这在 `.devspace/` 子目录场景中不是实际问题。✅
- Windows 路径大小写不敏感：`startsWith` 做的是大小写敏感比较。理论上 Windows 上 `.DevSpace/` 和 `.devspace/` 可能指向同一目录。风险极低，因为 `.devspace` 由程序自身创建。⚠️ 低

**测试覆盖**: [server.ts smoke test](file:///d:/Code/git/devspace/src/mcp/server.ts#L168-L169) Test 11 验证了 `../../package.json` 被拒绝。✅

---

## 3. Symlink Traversal — `realpathSync` 检查

**评级: PASS (有效防护，存在 TOCTOU 窗口)**

[safePath L18-24](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L18-L24):

```typescript
if (existsSync(full)) {
  try {
    const real = realpathSync(full);
    if (!real.startsWith(base)) return null;
  } catch {
    return null;
  }
}
```

**分析**:

- 当目标文件已存在时，`realpathSync` 解析符号链接的真实路径并检查是否仍在 `.devspace/` 内。✅
- **TOCTOU 竞态**: `existsSync` 和 `realpathSync` 之间存在时间窗口，攻击者理论上可以在此期间创建符号链接。在实际使用中，MCP 调用来自受信客户端且进程间无共享文件系统，风险极低。⚠️ 理论风险
- **仅限读取**: `safePath` / `safeRead` 仅用于读取操作。写操作（如 `writeFileSync`）使用固定路径，不经过 `safePath`。这意味着如果 `.devspace/state.json` 被替换为符号链接指向外部文件，写操作会跟随符号链接。⚠️ 低风险

---

## 4. Run Lock Atomicity — `openSync("wx")`

**评级: PASS (原子锁创建)，但缺少 stale lock 恢复机制**

[acquireRunLock](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L243-L263):

```typescript
const fd = openSync(lockPath, "wx");
```

**分析**:

- `"wx"` 标志保证了文件创建的原子性——如果文件已存在则抛出 `EEXIST`。✅
- 锁数据包含 `run_id`、`created_at`、`pid`、`mode`、`provider`，写入内容丰富。✅
- `writeFileSync(fd, buf)` 传入文件描述符，确保写入已创建的锁文件。✅

**问题**:

| 编号 | 问题 | 严重度 | 说明 |
|------|------|--------|------|
| S-4a | **无 stale lock 检测** | 中 | 如果进程崩溃（OOM kill、power loss），`run.lock` 永久残留，阻塞所有后续 run。没有 TTL 或 PID 存活检查。`releaseRunLock` 只在正常 `stop_delegate_run` 调用时执行。 |
| S-4b | **PID 未验证** | 低 | 锁数据中记录了 `pid`，但 `getRunLock` 不检查该 PID 是否仍存活。可利用 `/proc/{pid}` 或 Windows `tasklist` 做存活检测。 |

---

## 5. Free Mode / Real Provider Gate

**评级: PASS (正确的三层门控)**

[handleStartDelegateRun](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L297-L313) 实现了三层安全门:

| 层 | 检查 | 条件 |
|----|------|------|
| 1 | Free mode gate | `mode === "free"` 时需要 `allow_free_mode: true` |
| 2 | Real provider gate | `provider === "ollama"/"openai"` 时需要 `allow_real_provider: true` |
| 3 | Real + Free double gate | 同时满足上述两个条件时需要 `allow_real_free_mode: true` |

**分析**:

- 门控顺序正确：先单独检查 free，再单独检查 real，最后检查组合。✅
- 每次拒绝都写入审计日志并附带 safety_flags。✅
- [handleStartGatedLoop](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L627-L641) 复制了相同的三层门控逻辑。✅（但存在代码重复——DRY 违规，不影响安全性）

---

## 6. Real + Free Double Gate

**评级: PASS**

已验证 `start_delegate_run` 和 `start_gated_loop` 都实现了三重门控：

```typescript
if (mode === "free" && isReal && !args.allow_real_free_mode) {
  return { error: "Real provider + free mode requires allow_real_free_mode: true", status: "REJECTED" };
}
```

实际场景中，MCP 客户端必须同时传入三个 `true` 才能以 real+free 模式运行，防止了意外使用收费 API 进行无约束自主循环。

---

## 7. Direct Source Modification Impossible

**评级: PASS**

所有写操作的目标路径均限定在 `.devspace/` 子目录内:

| Handler | 写入目标 |
|---------|----------|
| `handleStartDelegateRun` | `.devspace/state.json`, `.devspace/runs/{id}/run_state.json`, `.devspace/run.lock` |
| `handleSubmitCoachReview` | `.devspace/runs/{id}/` 下的报告文件, `.devspace/current_task.md` |
| `handleCreateNextTask` | `.devspace/current_task.md` |
| `handleCreateHandoffFromWebgpt` | `.devspace/ceo/*.md` |
| `handleApproveNextRun` | `.devspace/approvals/{id}.json` |
| `handleAnswerNeedUser` | `.devspace/user_answers/{id}.json` |
| `handlePause/Resume/StopDelegateRun` | `.devspace/state.json` |

无任何 handler 写入项目源码、`package.json`、`.env` 等文件。✅

**注意**: `handleSubmitCoachReview` 将 `next_task_content` 直接写入 `current_task.md`，内容由 MCP 客户端提供。这是设计意图（task handoff），但意味着下游消费者需信任此内容。已在 Contract Review 中详细讨论。

---

## 8. Audit Log Coverage

**评级: PASS (全覆盖)，存在双重日志问题**

### 覆盖路径

[tools.ts:callTool](file:///d:/Code/git/devspace/src/mcp/tools.ts#L19-L47) 是所有工具调用的统一入口：

```
客户端 → callTool → handleToolCall → handler → return
         ↓ (result)                                  
    writeAudit()
```

| 场景 | 审计覆盖 |
|------|----------|
| 正常成功 | `callTool` 写入 "OK" ✅ |
| handler 内部 REJECTED | handler 写入 "REJECTED" + `callTool` 写入 "ERROR" 或 "REJECTED" ⚠️ |
| handler 异常 | `callTool` 写入 "ERROR" ✅ |
| 未知工具 | `callTool` 写入 "UNKNOWN_TOOL" ✅ |

### 问题: 双重审计 + 状态不一致

**严重度: 低**

当 handler 内部写入审计日志并返回带 `error` + `status: "REJECTED"` 的结果时：

1. Handler 写入 `result_status: "REJECTED"`
2. `callTool` 检查: `resultObj?.error` 为 true → 设置 `resultStatus = "ERROR"`
3. `callTool` 写入 `result_status: "ERROR"`

结果：同一操作产生两条审计记录，一条标记为 "REJECTED"，另一条标记为 "ERROR"。这可能导致审计分析时的状态统计偏差。

**建议**: 在 `callTool` 中检查 `resultObj?.status === "REJECTED"` 应优先于 `resultObj?.error`，或让 handler 不再内部写审计。

---

## 额外安全发现

### S-9. 无输入大小限制 (低)

`handleCreateHandoffFromWebgpt`、`handleSubmitCoachReview`、`handleCreateNextTask` 接受的 markdown 内容无大小限制。恶意客户端可传入超大字符串导致磁盘耗尽。

**建议**: 在 `schemas.ts` 中为 string 类型添加 `maxLength` 约束，或在 handler 中添加截断逻辑。

### S-10. `require("node:fs")` 在 ESM 上下文中 (低/代码质量)

[handlers.ts:76](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L76) — `handleReadDelegateTimeline` 内部使用 `require("node:fs")` 而非顶部已有的 ESM import。虽然功能正常，但引入了 CJS/ESM 混用，且 `statSync`、`readSync` 等已在文件顶部的 import 中遗漏。

### S-11. 未使用的 import (低/代码质量)

[handlers.ts:1](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L1) — `lstatSync` 被导入但从未使用。

---

## 总结

| 检查项 | 结果 | 严重度 |
|--------|------|--------|
| API key/env 泄露 | PASS | — |
| Path traversal | PASS | — |
| Symlink traversal | PASS (TOCTOU 窗口) | 理论风险 |
| Run lock atomicity | PASS (无 stale recovery) | 中 |
| Free/Real provider gate | PASS | — |
| Real+Free double gate | PASS | — |
| Direct source modification | PASS | — |
| Audit log coverage | PASS (双重日志) | 低 |
| 输入大小限制 | 未实现 | 低 |
| ESM/CJS 混用 | 代码质量 | 低 |
| 未使用 import | 代码质量 | 低 |

**建议优先处理**: S-4a（stale lock 恢复机制）> S-9（输入大小限制）> S-8（审计双重日志修复）。
