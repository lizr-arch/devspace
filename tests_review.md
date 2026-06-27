# Tests Review

## MCP Smoke Test Coverage

`runSmoke()` ([server.ts L105-L179](file:///d:/Code/git/devspace/src/mcp/server.ts#L105-L179)) 通过 `handleToolCall()` 直接调用 [handlers.ts](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L408-L424) 中的分发函数，走的是真实的 handler 路径而非只测 helper。

**调用链路验证：**
- `runSmoke()` → `handleToolCall()` → 各 `handle*()` 函数（真实路径）
- 不经过 `callTool()` → `writeAudit()` 审计路径（smoke 中未覆盖审计日志写入）

**覆盖的 13 个工具：**

| 工具 | Smoke 测试 | 测试内容 |
|------|-----------|---------|
| `get_delegate_status` | ✅ Test 3 | 无 state 时返回 status |
| `read_delegate_timeline` | ✅ Test 13 | 返回 entries 数组 |
| `read_current_task` | ❌ 未覆盖 | — |
| `read_handoff_summary` | ❌ 未覆盖 | — |
| `read_run_artifacts` | ✅ Test 10 | 返回 artifacts 对象 |
| `validate_handoff` | ✅ Test 2 | 返回结果 |
| `list_runs` | ✅ Test 9 | 返回 runs 数组 |
| `preview_delegate_run` | ✅ Test 4 | 返回 checks 对象 |
| `start_delegate_run` | ✅ Test 5 | 默认参数返回 STARTED |
| `pause_delegate_run` | ❌ 未覆盖 | — |
| `resume_delegate_run` | ❌ 未覆盖 | — |
| `stop_delegate_run` | ✅ Test 8 | 返回 STOPPED |
| `answer_need_user` | ✅ Test 12 | 返回 ANSWERED |

**工具覆盖：9/13（69%）。** 4 个工具未被测试：`read_current_task`、`read_handoff_summary`（只读）、`pause_delegate_run`、`resume_delegate_run`（状态转换）。

> 注：`read_current_task` 和 `read_handoff_summary` 为只读工具，缺失风险低。`pause_delegate_run` 和 `resume_delegate_run` 是状态转换工具，缺失风险较高。

---

## Negative Tests

**已覆盖的 negative cases：**

| 场景 | 测试 | 结果 |
|------|------|------|
| free mode 无 `allow_free_mode` | ✅ Test 6 | `REJECTED` |
| real provider 无 `allow_real_provider` | ✅ Test 7 | `REJECTED` |
| path traversal `../../package.json` | ✅ Test 11 | 返回 error |

**未覆盖的 negative cases：**

| 场景 | 风险 | 说明 |
|------|------|------|
| `read_run_artifacts` 缺少 `run_id` | 中 | [handlers.ts L91](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L91) 有 early return，但未被测试 |
| `answer_need_user` 缺少 `answer` 或 `decision` | 中 | [handlers.ts L382-L385](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L382-L385) 有校验，未被测试 |
| `answer_need_user` 无效 decision | 中 | [handlers.ts L388-L390](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L388-L390) 校验 `continue/skip/abort`，未被测试 |
| `start_delegate_run` 缺少 `delegate_contract.md` | 高 | [handlers.ts L261-L264](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L261-L264) 检查文件存在，smoke 运行时文件可能恰好存在导致未测到拒绝 |
| `start_delegate_run` 缺少 `stop_conditions.md` | 高 | 同上 |
| `start_delegate_run` 并发 lock 竞争 | 中 | [handlers.ts L271-L274](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L271-L274) 检查 run.lock，但 smoke 顺序执行无法测到竞态 |
| `read_run_artifacts` 路径含 `..` 但不以 `../../` 开头 | 低 | [handlers.ts L14](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L14) 的 `full.includes("..")` 检查可覆盖，但未测试变体如 `runs/legit/../../../etc/passwd` |
| 未知 tool name 经 `callTool()` 路径 | 低 | [tools.ts L20-L23](file:///d:/Code/git/devspace/src/mcp/tools.ts#L20-L23) 有处理，但 smoke 直接调 `handleToolCall` 绕过了 |

**Path traversal 安全性评估：**

[safePath()](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L10-L16) 实现了双重检查：
1. `resolve()` 后检查 `startsWith(base)` — 防止绝对路径逃逸
2. `full.includes("..")` — 防止相对路径穿越

这是一个合理的防御，但 `includes("..")` 会误杀合法路径（如目录名含 `..`），虽然在实际场景中 `.devspace` 下不太可能出现这种情况。

---

## Run Artifact Coverage

[handleReadRunArtifacts()](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L90-L109) 读取以下 8 个 artifact：

```
run_state.json, local_report.md, coach_review.md,
next_task.md, final_report.md, blocked_report.md,
budget_stop_report.md, user_question.md
```

**Smoke 测试评估：**

Test 10 仅检查 `!!artifacts?.artifacts`（对象是否存在），未验证：
- 各 artifact 文件是否被正确读取
- 不存在的 artifact 是否返回 `null`
- artifact 内容是否为有效字符串

**Artifact 完整性对比：**

| Artifact | Handler 定义 | Smoke 验证 | 说明 |
|----------|-------------|-----------|------|
| `run_state.json` | ✅ | ❌ 仅检查对象存在 | 运行状态核心文件 |
| `local_report.md` | ✅ | ❌ | 本地执行报告 |
| `coach_review.md` | ✅ | ❌ | 教练审查报告 |
| `next_task.md` | ✅ | ❌ | 下一步任务 |
| `final_report.md` | ✅ | ❌ | 最终报告 |
| `blocked_report.md` | ✅ | ❌ | 阻塞报告 |
| `budget_stop_report.md` | ✅ | ❌ | 预算停止报告 |
| `user_question.md` | ✅ | ❌ | 用户问题文件 |

**结论：artifact 列表完整（8/8 定义），但 smoke 测试未逐项验证各 artifact 的读取结果。**

---

## Behavior Tests

### Timeout

- **未测试。** `timeout` 参数在 [handleStartDelegateRun()](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L239) 中仅作为返回值传递，未在 handler 层实际执行超时逻辑。Smoke 未验证 timeout 值是否被正确记录到 `run_state.json`。

### Lock

- **部分测试。** Test 5 (`start_delegate_run`) 隐式创建 lock，Test 8 (`stop_delegate_run`) 隐式释放 lock。
- **缺失：** 未测试 lock 已存在时的拒绝行为（需要在 start 之前手动创建 `run.lock` 文件）。

### Paused

- **未测试。** `handlePauseDelegateRun()` ([handlers.ts L322-L340](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L322-L340)) 完全未被调用。
- 未验证：从 `DELEGATE_RUNNING` 状态暂停、从无效状态暂停的拒绝、暂停后状态变为 `READY_TO_DELEGATE`。

### Resume

- **未测试。** `handleResumeDelegateRun()` ([handlers.ts L342-L360](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L342-L360)) 完全未被调用。
- 未验证：从 `READY_TO_DELEGATE` 恢复、从无效状态恢复的拒绝。

### Stopped

- **已测试。** Test 8 验证 `stop_delegate_run` 返回 `STOPPED`。
- **缺失：** 未测试无 state 时 stop 的拒绝（`NO_STATE` 分支）。

### 生命周期测试

Smoke 测试的实际执行顺序是：`start → stop`，这是一个最简生命周期。

**缺失的生命周期场景：**
- `start → pause → resume → stop`（完整暂停恢复流程）
- `start → start`（并发 lock 拒绝）
- `stop → stop`（重复 stop 应返回 `NO_STATE`）
- `pause` 在无 state 时（应返回 `NO_STATE`）

---

## Issues Found

### 高优先级

1. **`pause_delegate_run` 和 `resume_delegate_run` 未被测试。** 这是 MCP 控制流的核心功能，存在状态机 bug 的风险。

2. **Lock 竞争未测试。** Smoke 顺序执行无法验证并发场景下的 lock 保护。建议增加：先手动创建 `run.lock`，再调用 `start_delegate_run`，验证返回 `REJECTED`。

3. **Missing handoff 文件拒绝路径未被显式测试。** Smoke 运行时 `.devspace/ceo/` 目录可能恰好存在 `delegate_contract.md` 和 `stop_conditions.md`，导致 Test 5 总是走成功路径。应显式测试文件缺失时的拒绝。

### 中优先级

4. **`read_run_artifacts` 未逐项验证 artifact。** 仅检查对象存在，未验证各 artifact 文件是否被正确读取为字符串或 null。

5. **`answer_need_user` 的输入校验未测试。** 缺少 `answer`/`decision` 为空、`decision` 无效等 negative case。

6. **`read_current_task` 和 `read_handoff_summary` 未测试。** 虽为只读工具，但作为 13 个注册工具的一部分，应有基本覆盖。

7. **Audit 日志路径未验证。** Smoke 经 `handleToolCall()` 直接调用，绕过了 [tools.ts](file:///d:/Code/git/devspace/src/mcp/tools.ts#L19-L31) 中的 `writeAudit()` 调用，审计日志写入未被测试。

### 低优先级

8. **`safePath()` 的 `includes("..")` 可能误杀。** 如果 `.devspace/runs/` 下存在包含 `..` 的目录名（虽然不太可能），会被误判为 path traversal。建议改为对 `resolve()` 后的路径段逐一检查。

9. **Smoke 未通过 `callTool()` 路径。** 直接调用 `handleToolCall()` 绕过了 [tools.ts L19-L31](file:///d:/Code/git/devspace/src/mcp/tools.ts#L19-L31) 的 schema 校验和错误处理，这部分逻辑未被覆盖。

10. **`handleValidateHandoff()` 使用 `require()` 动态加载。** [handlers.ts L113](file:///d:/Code/git/devspace/src/mcp/handlers.ts#L113) 中的 `require("../delegate/handoff.js")` 在 ESM 环境下可能失败，fallback 到文件存在性检查。Smoke 未验证哪种路径被实际执行。

---

## Verdict

**FAIL**

Smoke 测试覆盖了基本的 happy path（start → stop）和 3 个关键 negative case（free mode gate、real provider gate、path traversal），但存在以下关键缺失：

- **状态机不完整**：`pause` 和 `resume` 完全未测试，无法验证完整的 delegate 生命周期
- **Negative cases 不足**：缺少 lock 竞争、missing handoff 文件、输入校验等关键拒绝路径
- **Artifact 验证薄弱**：仅检查对象存在，未验证各 artifact 文件的读取正确性
- **审计路径未覆盖**：`callTool()` → `writeAudit()` 路径被绕过

建议在现有 smoke 基础上增加以下测试：
1. `start → pause → resume → stop` 完整生命周期
2. Lock 已存在时的拒绝测试
3. Missing handoff 文件的拒绝测试
4. `answer_need_user` 输入校验 negative cases
5. `read_run_artifacts` 逐项 artifact 验证
6. 通过 `callTool()` 路径的至少一个测试以覆盖审计日志
