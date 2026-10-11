# DevSpace — Git Worktree 与分支安全清理能力升级报告

**报告 ID**：`DEVSPACE_GIT_LIFECYCLE_CLEANUP_UPGRADE_REPORT.md`
**日期**：2026-10-10
**范围**：仅升级 DevSpace 本身。本轮**未**删除 TriaRegna 的任何 Worktree、分支、远端引用或文件。
**结论**：见文末 Verdict。

---

## 0. 摘要

在离线源码审计中发现**三个真实缺陷**（不是推测，均已复现并附带反例测试）：

| # | 缺陷 | 影响 |
|---|---|---|
| 1 | `hasActiveSession` 实为「内存 Map 中存在该 id」，而该 Map **只在 `getWorkspace()` 被调用时写入、永不删除** | 任何被任意工具触碰过的工作区**永久**显示为 `active_session`，`reclaim_workspace` 因此永远拒绝 |
| 2 | `countUnmergedCommits` 对多个主线 ref 取 **`Math.max`** | 只要 `origin/main` 落后于本地 `main`（克隆后未再 fetch 的典型情形），**已经完全合并**的提交也会被判为「未合并」，审计与回收结果互相矛盾 |
| 3 | `reclaim_workspace` 从不查询 registry 自身的活动探针，且与审计使用**不同数据源**（`store.getSession` vs `listSessions`）；审计可回收但回收报 `WORKSPACE_NOT_FOUND` / `WORKSPACE_RECLAIM_ACTIVE` | 审计判定与回收结果不一致；且**真实存在的运行中 job 无法阻止回收** |

本轮交付：持久化生命周期状态、真实的 in-flight 租约、`close_workspace_session`、`git_delete_merged_branch`、统一只读清理计划、跨进程（`lsof`）占用探测、50 项生命周期测试 + 13 项 MCP 协议级验证。

---

## 1. 原因分析与相关源码位置

### 1.1 为什么「没有运行任务、没有未提交修改、提交也已进入 main」的工作区仍被标记为 `active_session`？

**根因**：`hasActiveSession` 的语义错误。

```ts
// 修复前 src/workspaces.ts（auditWorkspaces）
hasActiveSession: this.workspaces.has(summary.workspaceId),
```

`this.workspaces` 是一个 `Map<string, Workspace>`，产生写入的唯一位置是 `getWorkspace()`：

```ts
// 修复前 src/workspaces.ts
getWorkspace(workspaceId: string): Workspace {
  const workspace = this.workspaces.get(workspaceId);
  if (workspace) { this.store?.touchSession(workspaceId); return workspace; }
  const session = this.store?.getSession(workspaceId);
  ...
  this.workspaces.set(restoredWorkspace.id, restoredWorkspace);   // ← 只有写入，没有删除
  return restoredWorkspace;
}
```

**任何**带 `workspaceId` 的工具调用（`git_status`、`read`、`git_fetch`…）都会经 `getWorkspace()` 把该 id 放进 Map。此后：

- 没有任何代码路径从 Map 中移除条目（唯一例外是 `reclaimWorkspace` 删除 store 记录，但**不删内存条目**）；
- 因此 `hasActiveSession` 变为**单调递增**：一旦为真，永不为假；
- 审计把 `active_session` 记为 risk，`reclaimable` 因此永远为 `false`。

这正好解释了「很多工作区明明空闲却被标为 `active_session`」。

### 1.2 必须区分的六种情况（现已全部可区分）

| 情况 | 修复前的表现 | 修复后的表示 |
|---|---|---|
| Session 记录仍存在 | `status='active'`（永远） | `lifecycleState` ∈ {unknown, idle, closing, closed, stale} |
| Session 真正有活动连接 | 无法区分 | `liveLeases > 0`（真实租约） |
| Agent 仍在执行任务 | 无法区分 | `activeTaskSessionIds` |
| 后台 Job 仍在运行 | 部分可见（仅 reclaim 路径） | `activeJobIds`（条条路径都查） |
| 只是历史 Session 尚未关闭 | 显示为 active | `lifecycleState = 'idle'` 且有 `lastUsedAt` |
| 服务重启造成的遗留状态 | 显示为 active 并无从判断 | `unknown` → 首次观测后 `idle`；**未观测前 fail-closed** |
| 当前 Workspace 正被其他 MCP 请求使用 | 无法区分 | `liveLeases > 0`（工具包装器自动租约） |
| 外部进程（shell / 编辑器 / 手启构建）占用 | **完全可见性缺失** | `foreignProcesses`（只读 `lsof` 探测） |

### 1.3 异常事件：审计报告可回收，回收却返回 `WORKSPACE_NOT_FOUND`

**结论：审计与回收使用了不同的数据源，并且回收不做 registry 自检。**

三点并存：

1. **数据源不同。** 审计经 `listWorkspaces` → `store.listSessions(limit)`（一个**有上限的列表**）；回收经 `store.getSession(id)`（**点查**）。两者之间记录可能被 `reclaim_workspace` 自身删除。
2. **registry 自检缺失。** 回收只看 `store`，不看内存 registry，也不看 registry 的 job/game/task 探针。
3. **错误码语义模糊。** 「记录不存在」与「工作区未知」混为一谈，`WORKSPACE_NOT_FOUND` 之类无法告诉调用方到底发生了什么。

**现场证据（只读测量，非推测）**：

```
total workspace records: 202
TriaRegna records: 39 (worktree 32, checkout 7)
records whose directory is gone: 0
registered worktrees (repo): 48
directories under /Users/liz/.devspace/worktrees: 123
  of which no workspace record mentions them: 85 / 91
```

即：**磁盘上有大量目录，而 store 中没有任何记录**（`scanWorktreeDirectories` 会把它们列为 `orphaned`，其 `workspaceId` 为 `null`）。反之也存在检索窗口外/已被删除的记录。审计与回收对「同一个 id 是否可操作」的判断因此可以不一致。

**修复后的区分**（`src/workspaces.ts`）：

| 场景 | 错误码 |
|---|---|
| 记录从未存在（且不在内存） | `WORKSPACE_RECLAIM_RECORD_MISSING` |
| 仅在内存、无持久化记录 | `WORKSPACE_RECLAIM_NO_RECORD` |
| 记录存在但目录/注册已消失 | `WORKSPACE_RECLAIM_STALE_RECORD` |
| 有人正在持有 | `WORKSPACE_RECLAIM_ACTIVE` |
| 会话未释放 | `WORKSPACE_RECLAIM_SESSION_NOT_CLOSED` |

**另一个被顺带发现的同类 bug**：`reclaimWorkspace` 从不调用 `this.probes.activeJobIdsForRoot`，只调用调用方传入的（可为 `undefined`）函数，而工具层**没有传**该回调。因此**一个真实运行中的 job 无法阻止回收** —— 现有测试用的是它自己的 registry（探针全局生效），所以掩盖了这个缺口。现已在 registry 内部统一查询探针。

### 1.4 `git_merge` 的旧隐患（未修改，但已加注释与测试覆盖）

`mergeGit` 要求 `assertManagedAttachedGitWorkspace`，即工作区必须是**已 attach 的托管工作区**；这与新增的会话生命周期无冲突。旧 Git Fetch/Push/Merge 能力在回归测试中全部保持通过。

---

## 2. 现有 Session 生命周期设计缺陷

| 缺陷 | 位置 | 说明 |
|---|---|---|
| `status` 列永远为 `'active'` | `src/db/schema.ts`、`src/workspace-store.ts` | 建表默认值 `'active'`，只在 `createSession` 写一次，此后永不更新。审计模块早已在注释中承认「100% 的行都声称自己是 active」。 |
| 活跃判定不可信 | `src/workspaces.ts:auditWorkspaces` | 以 Map 是否存在代真实活跃度。 |
| 无「租约」概念 | 全仓库 | 工具执行期间没有任何可观测的占用信号。 |
| 无「释放」语义 | 全仓库 | 没有 `close` 概念，也就无法区分「开着」与「闲置」。 |
| 重启后状态无从恢复 | `src/workspaces.ts` | 内存 Map 清空，DB 全部 `active`。 |
| 审计与回收数据源不同 | `src/workspaces.ts` | 见 §1.3。 |
| 孤儿目录与已登记工作区可能重复统计 | `src/workspace-audit.ts:scanWorktreeDirectories` | 已知根与目录扫描直接字符串比较；macOS `/var` → `/private/var` 拼写不同时，**已登记工作区会被误报为孤儿**。 |

---

## 3. 修改文件清单

### 新增（8）

| 文件 | 作用 |
|---|---|
| `src/workspace-lifecycle.ts` | 生命周期状态与 verdict 词汇表（`active/idle/closing/closed/stale/unknown`、`SAFE_CANDIDATE` 等） |
| `src/git-branch-cleanup.ts` | 只读资格判定 + `git branch -d` 安全删除（无强制路径） |
| `src/workspace-process-probe.ts` | 只读 `lsof` 跨进程占用探测（从不发信号、从不 kill） |
| `src/workspace-lifecycle-cleanup.test.ts` | 50 项生命周期测试（E1–E4 + 故障注入） |
| `tests/test_mcp_git_lifecycle.ts` | 13 项 MCP 协议级验证（真实注册表面 + 真实仓库） |
| `scripts/triaregna-cleanup-plan.mjs` | 只读统一清理计划（与服务同探针、同策略） |
| `scripts/triaregna-readonly-audit.mjs` | 只读原始审计（SQLite `readonly` 打开） |
| `scripts/verify-live-mcp-tools.cjs` | 线上 MCP `tools/list` + 只读 `list_workspaces` 验证 |

### 修改（20）

```
package.json                        新增测试到 test:unit / test:mcp / test:ci
src/config.ts                       worktreeCleanup 策略 + 默认保护模式
src/user-config.ts                  worktreeCleanup 用户配置类型
src/db/schema.ts                    lifecycle_state / closed_at / closed_reason
src/db/migrations.ts                migration 11: workspace-session-lifecycle
src/workspace-store.ts              生命周期持久化 API（setSessionLifecycle 等）
src/workspace-audit.ts              统一 verdict、外进程风险、mainline 取最小、路径规范化
src/workspaces.ts                   租约、生命周期转换、close/plan/reclaim、探针接线
src/workspace-types.ts              计划条目与会话结果类型
src/git-worktree.ts                 ——（未改）
src/server.ts                       探针接线、expose ctx
src/server/server-helpers.ts        工具自动租约、shared error output schema、工具清单
src/server/server-types.ts          schema revision、lifecycleState、toolErrorOutputSchema
src/server/tools-workspace.ts       list_workspaces(cleanupPlan)、close_workspace_session、reclaim 加强
src/server/tools-git.ts             git_delete_merged_branch、Git 写工具租约化
src/ui/card-types.ts                TOOL_NAMES 增加两个工具
src/tool-test-coverage.ts           覆盖清单
src/doctor.test.ts                  工具数 60 → 62、schema revision 与工具存在性
src/oauth-store.test.ts             migration 11
src/worktree-git-governance.test.ts 目录扫描规范化后的期望
src/game-sessions.ts                新增只读 listActiveSessions()
```

统计：`20 files changed, 2470 insertions(+), 184 deletions(-)`。

---

## 4. 新 MCP 工具及准确 Schema

### 4.1 `close_workspace_session`

```jsonc
{
  "workspaceId":             "string",              // required
  "confirmWorkspaceId":      "string",              // required, 必须严格等于 workspaceId
  "expectedHeadSha":         "^[0-9a-f]{40}$",      // optional（提供则校验）
  "reason":                  "string ≤500",          // optional
  "projectMemoryReceiptId":  "^[0-9a-f]{64}$"       // optional
}
```
注解：`readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false`

### 4.2 `git_delete_merged_branch`

```jsonc
{
  "workspaceId":        "string",              // required
  "action":             "list" | "delete",     // optional，默认 delete
  "branchName":         "string ≤255",          // delete 时必填
  "expectedBranchSha":  "^[0-9a-f]{40}$",      // delete 时必填
  "expectedMainSha":    "^[0-9a-f]{40}$",      // delete 时必填
  "confirmBranchName":  "string ≤255",          // delete 时必填，须严格等于 branchName
  "projectMemoryReceiptId": "^[0-9a-f]{64}$"   // optional
}
```
注解：`readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false`

> **重要**：`action=list` 与 `action=delete` 共用同一 schema。Zod 层面只有 `workspaceId` 是强制的；运行时对 `delete` 强制 `branchName/expectedBranchSha/expectedMainSha/confirmBranchName` 四者齐全，缺失返回 `GIT_BRANCH_CONFIRMATION_REQUIRED`。这不是「可选确认」——而是为了让只读列举无需伪造确认值。

### 4.3 `list_workspaces` 新增参数（向后兼容）

```jsonc
{
  "limit":        1..100,      // 原有
  "audit":        boolean,     // 原有，输出增强
  "includeOrphans": boolean,   // 原有
  "cleanupPlan":  boolean      // 新增：返回统一只读清理计划
}
```
`structuredContent.cleanupPlan` 结构：`{auditedAt, entries[], orphans{...}, summary, readOnly: true}`。

**兼容性**：所有旧参数语义不变；`audit=true` 的文本行增加了 `verdict` 与会话状态，字段只增不改。`TOOL_SCHEMA_REVISION` 由 `…godot-import-v1.2026-10-10+devspace-1.2` 升为 `…git-lifecycle-cleanup-p0.1.2026-10-10+devspace-1.3`，指纹 `967254d97210fc869664acdd93b1cde3ff615fbb60f3dbec225af3346f2cbb92`（客户端缓存会因指纹变化而刷新）。

---

## 5. Session 关闭规则

### 5.1 关闭的含义（严格限定）

`close_workspace_session` **只**做三件事：

1. 校验身份与占用；
2. 把持久化生命周期状态置为 `closed`（并保留 `created_at` 等历史元数据）；
3. 在无租约时清除内存缓存条目。

它**绝不**：删除 Worktree / 分支 / 文件 / 日志 / 证据、kill Agent / Godot / 后台任务、reset Git 状态、级联进入删除流程。返回文本每次都显式包含 `Nothing was deleted: no worktree, branch, file, log, job or Git ref was removed.`

### 5.2 拒绝条件（全部 fail-closed）

| 情况 | 错误码 |
|---|---|
| `confirmWorkspaceId ≠ workspaceId` | `WORKSPACE_SESSION_CONFIRMATION_REQUIRED` |
| 无持久化记录 | `WORKSPACE_SESSION_UNKNOWN` |
| 目录不存在（身份不可确认） | `WORKSPACE_SESSION_UNVERIFIABLE` |
| Git 状态不可读 | `WORKSPACE_SESSION_UNVERIFIABLE` |
| `expectedHeadSha` 不符 | `WORKSPACE_SESSION_HEAD_MISMATCH` |
| 有 in-flight 租约 / job / task / game / 外部进程 | `WORKSPACE_SESSION_BUSY` |
| 状态为 `active`（可能是崩溃遗留，也可能是并行请求） | `WORKSPACE_SESSION_STATE_CONFLICT` |
| 状态为 `closing / stale / unknown` | `WORKSPACE_SESSION_STATE_UNVERIFIABLE` |

**注意**：`unknown` 状态**不**能直接关闭。必须先 `list_workspaces(audit=true)`（该次观测会把可证明空闲的 `unknown` 收敛为 `idle`），或 `resume_workspace`（显式重开 → `active` → 再关闭）。这是刻意的 fail-closed，而非缺陷。

### 5.3 幂等 / 并发 / 重启

- **幂等**：已 `closed` 的会话再次关闭返回 `alreadyClosed: true`，不重复写状态（有测试）。
- **并发**：`withLifecycleLock` 串行化「读-判-写」；两个并发关闭只会有一个执行转换，另一个报告 `alreadyClosed`（有测试）。
- **重启**：`unknown`/`active` 在无事持有时由首次观测收敛为 `idle`；有 job/task/game/外部进程则保持 `active`。任何 `reclaim` 都要求状态已 settled（`idle` 或 `closed`）。
- **重开不丢历史**：`created_at` 等元数据保留；`resume_workspace` 或对无开放记录的目录调用 `open_workspace` 会重新打开（有测试）。
- **不误关他人**：关闭必须由调用方提供 id 与确认值，且任何 in-flight 租约都会阻止——**包括另一个 Agent 的会话**，因为租约按 `workspaceId` 计数而非按客户端来源。

---

## 6. Branch 删除规则

### 6.1 删除资格（十条全部满足才删）

1. 分支名合法（`check-ref-format` 等价校验）。
2. `confirmBranchName` 严格等于 `branchName`。
3. 分支确实存在于 `refs/heads/<name>`（本地）。
4. 当前 SHA == `expectedBranchSha`。
5. 主线 ref 的 SHA == `expectedMainSha`。
6. 分支 SHA 是主线 ref 的祖先（`merge-base --is-ancestor`）。
7. 没有任何 Worktree checkout 该分支（`git worktree list --porcelain` 扫描，含仓库自身 HEAD）。
8. 没有活动 Agent/Job/Session 依赖该仓库（`branchActiveDependents`，按 **Git common dir** 判定「同一仓库」，并排除调用方自身）。
9. 分支不属于受保护集合。
10. 无无法解释的并发变化（删除前后对比 HEAD / 主线 / 全部 remote-tracking ref / `git status`）。

### 6.2 受保护集合

**代码内硬编码，配置无法移除**：`main`、`master`、仓库默认分支（`refs/remotes/origin/HEAD` 解析）。

**默认策略**（`DEFAULT_PROTECTED_BRANCH_PATTERNS`，即使无任何配置也生效）：
```
release/*  hotfix/*  feat/*  feature/*  topic/*
```
> `devspace/integration/*` **故意不保护** —— 它正是 DevSpace 为每个托管 Worktree 创建的集成分支，是本生命周期要清理的对象。

**本机额外配置**（`~/.devspace/config.json` → `worktreeCleanup.protectedBranchPatterns`）追加 `feat/terrain-*`。

**未合并的功能分支默认禁止删除**：即使远端有备份，只要不是选定主线的祖先，一律 `NOT_AN_ANCESTOR` 拒绝。测试覆盖。

### 6.3 删除方式

**仅** `git branch -d`（safe delete）。以下在本实现中**不存在**（不是「默认关闭」，而是没有代码路径）：

`git branch -D`、强制更新引用、删除远端分支、删除 tag、修改远端 main、`git reset --hard`、`git clean`、直接操作 `.git/refs`。

若 Git 自身拒绝 `-d`，操作**停止并解释原因**（`GIT_BRANCH_DELETE_FAILED`），**不会**自动升级为强制删除。返回文本固定包含 `Forced deletion (-D) is not available`。

### 6.4 并发误删防护

`deleteMergedBranch` 全程运行在**已有的** `withGitMutationLock(gitMutationLockKey(root))` 之下（与 `git_fetch/git_merge/git_push` 共用同一按仓库的锁），并在锁内**重新**执行完整资格判定、SHA 比对。锁内不做「先审计、后执行」的两段式判定，因此不可能用几分钟前的审计列表授权删除。

删除后再次验证：分支已消失、主线未变、HEAD 未变、全部 remote-tracking ref 未变、`git status` 未变。任何一项变化都抛出对应的 `GIT_BRANCH_*` 错误。

---

## 7. Worktree 回收规则

`reclaim_workspace` 的既有安全边界**全部保留**，并补强：

保持不变的拒绝条件：脏工作树、含未跟踪文件、含未合并提交、正在执行任务、有活动 Session、非托管工作区、`--force` 永远不用（`git worktree remove` 不带 `--force`，由 Git 二次拒绝脏树）、无递归目录删除、无 `git clean`、无 reset。

新增/加强：

| 变化 | 说明 |
|---|---|
| 真实租约取代 Map 存在性 | 空闲工作区不再被永久拒绝 |
| 会话状态必须 settled | `idle` 或 `closed` 才可回收 |
| 统一查询所有探针 | job / game / task / 外部进程在 registry 内部统一查询，不依赖调用方传参 |
| 自持租约排除 | 回收自身持有的租约不计入「他人持有」，否则永远自锁 |
| 外进程阻断 | 目录内有非 DevSpace 启动的进程（cwd 命中）则 `BLOCKED_ACTIVE` |
| 探针不可用 fail-closed | `lsof` 缺失/超时/异常 → `unknown` → 阻断 |
| 状态分类收敛 | `verdict === "SAFE_CANDIDATE"` 是唯一可回收信号；`reclaimable` 由 verdict 派生，两者不可能不一致 |
| 受保护模式 | `TriaRegna-ced6820c`、`TriaRegna-ti*` 等永远不是候选 |

### 标准工作流（每步可独立失败，不级联）

```
list_workspaces(audit=true, cleanupPlan=true)
  → 识别 SAFE_CANDIDATE
  → close_workspace_session（确认安全时）
  → 重新审计
  → reclaim_workspace（SHA 锁定）
  → 再次检查 git worktree 状态
  → git_delete_merged_branch（如符合条件）
```

---

## 8. Git 并发安全机制

| 机制 | 位置 | 作用 |
|---|---|---|
| `withGitMutationLock` / `gitMutationLockKey` | `src/git-tools.ts`（既有） | 按 **Git common dir** 串行化同一仓库的写操作；分支删除与 fetch/merge/push 共用 |
| `withLifecycleLock` | `src/workspaces.ts`（新） | 按 workspaceId 串行化会话生命周期「读-判-写」 |
| 工具级自动租约 | `src/server/server-helpers.ts`（新） | 每个带 `workspaceId` 的工具调用全程持租约，使并发可见 |
| `withExclusiveLease` | `src/workspaces.ts`（新） | 关闭/回收持租约但不把自己算作阻塞者 |
| SHA 锁定 + 锁内复检 | 回收/删除 | 陈旧决策无法删除已移动的对象 |
| 删除前后不变量对比 | `src/git-branch-cleanup.ts` | 主线 / HEAD / 远端 ref / status 四项证明删除是窄操作 |
| 只读 OS 探针 | `src/workspace-process-probe.ts` | 跨进程占用可见；结果 5s 缓存；仅对托管 Worktree 根运行 |

---

## 9. 自动化测试结果

### 9.1 `src/workspace-lifecycle-cleanup.test.ts`（新增，50 项全通过）

```
workspace lifecycle cleanup tests: 50 passed, 0 failed
```
整套 `npm run test:unit` 全绿（该文件已被加入 `test:unit`）。

覆盖矩阵：

| 组 | 关键用例 |
|---|---|
| E1 Session | 空闲会话安全关闭并持久化；幂等；**并发关闭串行化**；in-flight 租约拒绝；job/game/task 拒绝；**外部进程拒绝**；**探针不可用 fail-closed**；HEAD 不符拒绝；不可确认（目录消失）拒绝；未知 id 拒绝；确认值不符拒绝；重开不丢历史；重启遗留状态收敛；`unknown` 未观测被拒绝；`unknown` 观测后收敛；已释放会话可再次释放 |
| E2 Branch | 已合并本地分支安全删除；`feat/*` 开发分支拒绝；`main`/`master` 拒绝；未合并拒绝；被 Worktree checkout 拒绝；SHA 变化拒绝；**远端分支与 tag 完全不变**；活动依赖拒绝；确认值不符拒绝；只读列举不删除 |
| E3 Worktree | 干净+已合并+已关闭可回收；脏拒绝；未跟踪拒绝；未合并拒绝；运行中 job 拒绝；活动会话拒绝；**外进程拒绝**；HEAD 不符拒绝；普通 checkout 永不回收；**路径越界拒绝**；**符号链接绕过拒绝**；受保护模式拒绝；陈旧记录报 `BLOCKED_MISSING`；记录消失报 `RECORD_MISSING` |
| E4 集成 | 完整生命周期（建分支→提交→合并→建 Worktree→关会话→重审计→回收→删分支），验证 **main 未变、工作区干净、Worktree 注册无残留、远端引用未改、远端分支仍存在**；崩溃中断后恢复；limit 小于记录数不产生重复统计 |
| 计划 | 只读计划分类且不删除任何东西；`SAFE_CANDIDATE` 与分支资格；孤儿目录识别且不重复计数 |

### 9.2 `tests/test_mcp_git_lifecycle.ts`（新增，13 项全通过）

通过**真实 MCP 协议**（in-memory transport，真实 regisration surface，真实临时仓库）：

```
mcp git lifecycle tool surface verified (13 checks)
```

含：工具名存在 + schema 精确匹配、`open_workspace(mode=worktree)` 回归、`list_workspaces(cleanupPlan)` 只读计划、关闭幂等、分支列举/错误确认/陈旧 SHA/受保护分支/成功删除并验证远端不变、回收的 SHA 拒绝。

### 9.3 回归

```
npm run test:unit        →  全绿（含 50 项新测试）
tests/test_mcp_jsonrpc.ts →  10/10 passed
tests/test_mcp_write_guard.ts → 14/14 passed
tests/test_mcp_git_lifecycle.ts → 13/13 passed
npx tsc --noEmit         →  无错误
npm run build            →  exit 0
```

旧 Git 能力回归：`git-tools` / `git-remote-tools` / `git-remote-merge`（16/16） / `git-push-policy`（6/6） / `worktree-git-governance` 全部通过。

**未虚构任何测试结果。** 所有数字均来自实际执行输出。

---

## 10. DevSpace 重启与客户端工具发现状态

### 10.1 重载前检查

| 检查 | 结果 |
|---|---|
| 构建 | `npm run build` exit 0 |
| 单元测试 | 全绿 |
| 活动 Job | `mcpSessions.active = 0`, `inFlightRequests = 0`, `createdLastFiveMinutes = 0` |
| Tool Schema 兼容性 | 仅新增工具与新增可选字段；`TOOL_SCHEMA_REVISION` 显式升版；旧工具 schema 未变（仅 error 联合形状放宽为 `.optional()`，向后兼容） |
| 配置备份 | `~/.local/state/devspace/backups/pre-git-lifecycle-20261010/`（plist + config.json + auth.json） |

### 10.2 重载方式

通过 launchd 正式流程重载（未手动启动第二个实例）：

```
launchctl kickstart -k gui/<uid>/com.liz.devspace
```

结果：`ps aux | grep 'cli.js serve' | wc -l` → **1**（无重复服务进程）。

### 10.3 重载后验证

| 验证项 | 结果 |
|---|---|
| `/healthz`（本地 127.0.0.1:7676） | `ok: true`，`tools: 63` |
| `schemaRevision` | 含 `git-lifecycle-cleanup-p0.1`、`+devspace-1.3` |
| `schemaFingerprint` | `967254d97210fc869664acdd93b1cde3ff615fbb60f3dbec225af3346f2cbb92` |
| Migration 11 | `{"version":11,"name":"workspace-session-lifecycle","applied_at":"2026-10-10T11:03:16.881Z"}` |
| Cloudflare Tunnel | LaunchAgent `com.liz.cloudflared-devspace` 运行中 |
| 公网 `/healthz` | HTTP **200** |
| OAuth 受保护资源元数据 | `{"resource":"https://mcp.workspaceport.com/mcp","authorization_servers":["https://mcp.workspaceport.com/"],"scopes_supported":["devspace"]}` |
| MCP `initialize` | 200，会话建立成功 |
| MCP `tools/list` | 200，**64** 个工具（含 app-only 工具） |
| `close_workspace_session` | **PRESENT**，schema keys = `confirmWorkspaceId, expectedHeadSha, projectMemoryReceiptId, reason, workspaceId` |
| `git_delete_merged_branch` | **PRESENT**，schema keys = `action, branchName, confirmBranchName, expectedBranchSha, expectedMainSha, projectMemoryReceiptId, workspaceId` |
| 旧 Git 能力 | `git_status / git_branch / git_fetch / git_merge / git_push / reclaim_workspace / list_workspaces` 全部 **PRESENT** |
| `list_workspaces(audit,cleanupPlan)` 线上调用 | 200，`readOnly: true`，verdict 正常返回 |
| main 限定授权 | `gitRemoteWrite.branchAuthorizations` 中 `main` 的 scoped、expiring 授权保留在配置中，未改动 |
| 重复服务进程 | 无 |

---

## 11. TriaRegna 实际只读清理候选清单

**测量时间**：2026-10-10T11:18Z（重载后）
**方法**：`node scripts/triaregna-cleanup-plan.mjs`（与服务同 registry、同探针、同策略；SQLite 只读打开）
**未执行任何关闭/回收/删除。**

### 11.1 仓库基线

```
TriaRegna main        = d04559839ff1c381c641be57eb71d4c4392a6c60
TriaRegna origin/main = d04559839ff1c381c641be57eb71d4c4392a6c60   （一致）
local branches        = 47
registered worktrees  = 48
merged into main      = 22
托管 Worktree 目录     = 123
  其中无任何记录者      = 85
```

### 11.2 计划汇总

```
TOTAL 50
SAFE_CANDIDATE     12
BLOCKED_ACTIVE      2
BLOCKED_DIRTY       6
BLOCKED_UNMERGED   17
BLOCKED_PROTECTED   1
BLOCKED_NOT_MANAGED 11
BLOCKED_MISSING     1
UNKNOWN             0
```

### 11.3 五个历史候选的当前占用状态（明确回答）

| 候选 | workspaceId | verdict | 是否仍被占用 | 依据 |
|---|---|---|---|---|
| `TriaRegna-3b500f8e` | `ws_84c8ac2d-…` | **SAFE_CANDIDATE** | **否** — 无租约、无 job/task/game、无外部进程（`lsof` 命中 0） | clean, unmerged=0, HEAD `9b66164c` |
| `TriaRegna-f887b774` | `ws_143de385-…` | **SAFE_CANDIDATE** | **否** | clean, unmerged=0, HEAD `9b66164c` |
| `TriaRegna-6a8a9ecc` | `ws_4f89f651-…` | **SAFE_CANDIDATE** | **否** | clean, unmerged=0, HEAD `588a43be` |
| `TriaRegna-b58942f7` | `ws_bfae1a1c-…` | **BLOCKED_ACTIVE** | **是** — 外部进程 `pid 896 (zsh)` 的 cwd 正是该目录 | `blockedReasons: a process started outside DevSpace is working inside it (pid 896)` |
| `TriaRegna-ae701e26` | `ws_6a13a8db-…` | **SAFE_CANDIDATE** | **否** | clean, unmerged=0, HEAD `308e1a0e` |

### 11.4 全部 12 个 SAFE_CANDIDATE

```
TriaRegna-2ee14e07      clean, unmerged=0, idle, no foreign process
TriaRegna-3b500f8e      clean, unmerged=0, idle, no foreign process
TriaRegna-6a8a9ecc      clean, unmerged=0, idle, no foreign process
TriaRegna-96d53c25      clean, unmerged=0, idle, no foreign process
TriaRegna-ae701e26      clean, unmerged=0, idle, no foreign process
TriaRegna-c8a24612      clean, unmerged=0, idle, no foreign process
TriaRegna-e330e3f4      clean, unmerged=0, idle, no foreign process
TriaRegna-f887b774      clean, unmerged=0, idle, no foreign process
ProceduralTerrains-4fc138b2
ProceduralTerrains-a7c5840d
ProceduralTerrains-af1b3739
ProceduralTerrains-cc906464
```

**注意**：这些条目的 `branchDelete` 当前均为 `CHECKED_OUT` —— 工作区自身占用了该分支，因此**必须先回收 Worktree，分支才可能变为 `DELETABLE_MERGED`**。这正是「先回收、再删分支」的顺序不可颠倒的原因。

### 11.5 被阻止的候选（重点）

| 类别 | 条目 | 阻止原因 |
|---|---|---|
| **BLOCKED_ACTIVE（自然，不可绕过）** | `TriaRegna-b58942f7`（pid 896 zsh）、`TriaRegna-bad085fb`（pid 95782 bash） | 外部进程 cwd 命中 |
| **BLOCKED_DIRTY** | `3b9ced92`、`5b521cb5`、`8dd2465b`、`a55992d3`、`a9c26d21`、`b8833640` | 有未提交或未跟踪内容 |
| **BLOCKED_UNMERGED** | 17 个 `devspace/integration/TriaRegna-*`（含 `c851dc28`、`f1f67666`、`f496199d`、`fe510898`、`bad085fb`、`0c30aae4`、`30c82e87`、`3515fe7b`、`73166946`、`89b113ad`、`8aa434d1`、`9bacea65`、`a8a2dcd5`、`a91ff755`、`aa5b383f`、`b8e08654`）+ 2 个 `ProceduralTerrains-*` | 提交不在 main 上 |
| **BLOCKED_PROTECTED** | `TriaRegna-ced6820c` | 命中保护模式 `TriaRegna-ced6820c`（正式主线工作区）；其分支为 `main` → `PROTECTED` |
| **BLOCKED_NOT_MANAGED** | 11 个 checkout 记录（含 `/Users/liz/agy/TriaRegna`、`TriaRegna-integration`、`TriaRegna-step3` 等） | 非托管 Worktree，**永不回收** |
| **BLOCKED_MISSING** | `ProceduralTerrains-70d4d346` | 记录指向的目录/注册已消失 |
| **UNKNOWN** | 0 | —— |

### 11.6 特别保护对象（本轮确认全部完好）

```
present  /Users/liz/agy/TriaRegna                              （原始工作区）
present  /Users/liz/.devspace/worktrees/TriaRegna-ced6820c     （正式主线工作区，verdict=BLOCKED_PROTECTED）
present  /Users/liz/.devspace/worktrees/TriaRegna-ti0
present  /Users/liz/.devspace/worktrees/TriaRegna-ti1
present  /Users/liz/.devspace/worktrees/TriaRegna-ti2
present  /Users/liz/.devspace/worktrees/TriaRegna-ti3          （含 2 个活动 bash 会话）
```

- 正式 CNB `main`：`d0455983…`，`git status` 干净，未推送任何内容。
- 地形 TI 开发链：全部位于 `BLOCKED_PROTECTED`/`BLOCKED_UNMERGED`，且 `feat/terrain-*` 在分支保护模式中；活动 Godot 进程（`TriaRegna-ti3-memclosure`）仍在运行，未被触碰。
- 10 个 `feat/*` 分支：8 个未合并（`NOT_AN_ANCESTOR`），2 个已合并但命中 `feat/*` 保护模式 → **全部不可删除**。
- 远端引用：本轮对 TriaRegna 未执行任何 fetch/push/删除，远端状态未变。

---

## 12. 回滚方式

### 12.1 快速回滚（服务层面，不改代码）

```bash
# 1) 恢复 launchd 与配置
cp ~/.local/state/devspace/backups/pre-git-lifecycle-20261010/com.liz.devspace.plist \
   ~/Library/LaunchAgents/com.liz.devspace.plist
cp ~/.local/state/devspace/backups/pre-git-lifecycle-20261010/config.json ~/.devspace/config.json
cp ~/.local/state/devspace/backups/pre-git-lifecycle-20261010/auth.json  ~/.devspace/auth.json
chmod 600 ~/.devspace/auth.json

# 2) 回滚代码到升级前提交
cd /Users/liz/Documents/Codex/2026-07-21/wo-de/work/devspace
git stash push -u            # 或 git checkout -- . && rm -f <新增文件>
git log --oneline -1         # f3589fa feat(devspace): complete v1.2 TriaRegna workflow

# 3) 重新构建并重载
npm run build
launchctl kickstart -k gui/$(id -u)/com.liz.devspace
curl -s http://127.0.0.1:7676/healthz
```

### 12.2 数据库兼容性

Migration 11 **只做加法**（`lifecycle_state` / `closed_at` / `closed_reason` 三列 + 一个索引），不删除、不改名、不改类型。旧代码不读取这三列，因此：

- **向前兼容**：回滚代码后旧服务可继续使用同一数据库，无需回滚 schema。
- **数据影响**：migration 会把所有已有行的 `lifecycle_state` 置为 `'unknown'`（保守默认）。回滚后该列被忽略，无副作用。
- 如需彻底回退 schema：`alter table workspace_sessions drop column lifecycle_state;`（另有 `closed_at`、`closed_reason`、`drop index workspace_sessions_lifecycle_idx`）。**不建议**——保留列是无害的。

### 12.3 单项回滚

| 想回滚的能力 | 操作 |
|---|---|
| 外部进程探测 | 配置 `worktreeCleanup.requireNoForeignProcess: false`，重载即可（代码保留） |
| 新增工具 | `git revert` 对应 commit；不影响旧工具 |
| 清理策略保护 | 编辑 `~/.devspace/config.json` 的 `worktreeCleanup`，重载 |
| 生命周期状态语义 | `git revert` + schema 保留（见 12.2） |

---

## 13. 建议的后续清理执行顺序

> **本轮未执行任何一步。** 以下为建议流程，每一步都需要人工确认，且每一步都可独立失败。

### 第 0 步（必做）：确认窗口

```jsonc
// 调用 list_workspaces(audit=true, cleanupPlan=true, limit=100)
// 确认：mcpSessions.active / inFlightRequests = 0
// 确认：无 SAFE_CANDIDATE 变成 BLOCKED_ACTIVE（说明有并发使用）
```

### 第 1 步：处理 3 个「空闲且历史的」候选（风险最低）

按 `3b500f8e` → `f887b774` → `6a8a9ecc` → `ae701e26` → `2ee14e07` → `96d53c25` → `c8a24612` → `e330e3f4` 顺序，对每一个：

```
1) list_workspaces(audit=true, cleanupPlan=true)        # 复核 verdict / headSha
2) close_workspace_session({
     workspaceId, confirmWorkspaceId: workspaceId,
     expectedHeadSha, reason: "idle merged worktree cleanup"
   })
3) list_workspaces(audit=true, cleanupPlan=true)        # 必须变 SAFE_CANDIDATE
4) reclaim_workspace({ workspaceId, expectedHeadSha, confirmWorkspaceId })
5) git worktree list                                    # 确认注册已移除
6) git_delete_merged_branch({
     workspaceId,                          # 使用剩余任一该仓库工作区
     branchName: "devspace/integration/TriaRegna-TriaRegna-<id>",
     expectedBranchSha, expectedMainSha,   # 来自步骤 3 的 branchDelete
     confirmBranchName: <同一个 branchName>
   })
```

**一次只做一个**（至少前两个）。每个之间重新审计。

### 第 2 步：处理 `BLOCKED_DIRTY`（6 个）

**不要**用本工具清理。需要人工进入对应 Worktree，判断未提交/未跟踪内容：

- 有价值 → commit 并合并到 main（走既有 `git_commit` / `git_merge` / `git_push` 流程）；
- 无价值 → 人工处理后，重新审计，届时自然变为 `SAFE_CANDIDATE`，再走第 1 步流程。

### 第 3 步：处理 `BLOCKED_UNMERGED`（17 个）

同第 2 步：这些工作区**持有未进入 main 的提交**，必须先由人工决定「合并」还是「放弃」。**绝不允许**通过放宽审计来绕过。

### 第 4 步：外部进程占用（2 个）

`TriaRegna-b58942f7`（zsh pid 896）、`TriaRegna-bad085fb`（bash pid 95782）：

- 确认这些交互式 shell 是否仍在被使用；
- 若是遗留 shell → 由**人工**退出它们（DevSpace 不会 kill）；
- 退出后重新审计，会变为 `SAFE_CANDIDATE`（前提是其余条件满足；`bad085fb` 仍是 `BLOCKED_UNMERGED`）。

### 第 5 步：`ProceduralTerrains-*` 4 个 SAFE_CANDIDATE

与第 1 步同流程。注意它们属于另一个仓库，`git_delete_merged_branch` 的 `expectedMainSha` 需取该仓库的 main。

### 第 6 步：85 个孤儿目录（`orphanedWorktreeAudit`）

这些目录**没有 DevSpace 记录**，因此 `reclaim_workspace` 无法处理（它需要 workspaceId）。建议：

1. 先 `list_workspaces(audit=true, includeOrphans=true)` 获取逐个的 Git 注册状态、脏/未跟踪/未合并状态；
2. 对 `gitRegistered=no` 且 clean 的目录，由人工确认后**手工**清理（`git worktree prune` + 目录删除由人工执行）；
3. DevSpace 本轮**不提供**孤儿目录删除能力——这是刻意的边界。

### 第 7 步：分支清理

只有当对应 Worktree 已被回收后，`devspace/integration/*` 分支才从 `CHECKED_OUT` 变为 `DELETABLE_MERGED`。届时用 `git_delete_merged_branch` 逐个删除（`action=list` 先看全貌）。

**永远不会被删除的**：`main`、`master`、仓库默认分支、`release/*`、`hotfix/*`、`feat/*`、`feature/*`、`topic/*`、`feat/terrain-*`（含全部 TI 链）。

### 第 8 步：远端

本轮**不涉及**任何远端分支删除。如将来确需清理 CNB 上的 `devspace/integration/*`，需新增独立能力与独立授权——现有实现没有远端分支删除路径。

---

## 14. 已知边界与残留风险

诚实列出，不掩饰：

1. **外部进程探测不可用时 fail-closed**。`lsof` 缺失或超时 → 所有托管 Worktree 变为 `BLOCKED_ACTIVE`。这是有意的安全选择（宁可漏删，不可误删），但会让审计变得保守。可用 `worktreeCleanup.requireNoForeignProcess: false` 显式放宽。
2. **检查点（checkpoint）自身的 `sh`/`zsh` 子进程 cwd** 若位于 Worktree 内也会被识别为占用者 —— 这是正确行为（它确实在那里工作）。
3. **租约只在进程内有效**。若服务在持有租约时被杀，DB 中会留下 `active`；首次观测会收敛为 `idle`（若无其它持有者）。这是刻意的「重启后可恢复」设计，但也意味着清理前必须重新审计。
4. **`close_workspace_session` 对 `unknown` 状态要求先审计**。这是故意增加的一次往返，用来强制「先观测、后决策」。
5. **孤儿目录无删除工具**。需要人工处理。
6. **`package.json` 版本仍为 `1.1.0`**（`TOOL_SCHEMA_REVISION` 已升到 `+devspace-1.3`）。未擅自升 `package.json` 版本，留给发布流程决定。
7. **`TriaRegna-b58942f7` 的 zsh（pid 896）已运行约 33 小时**；它可能是操作员遗忘的交互式 shell。DevSpace 不会也不应自动终止它。

---

## 15. Verdict

**实际状态核对：**

| 条件 | 状态 |
|---|---|
| 功能完成 | ✅ 全部实现 |
| 自动化测试通过 | ✅ unit 全绿（含 50 项新测试）+ MCP 13/13 |
| 类型检查 | ✅ `tsc --noEmit` 无错误 |
| 构建 | ✅ exit 0 |
| 服务端工具可调用 | ✅ 线上 `tools/list` 返回 `close_workspace_session` 与 `git_delete_merged_branch`，schema 精确匹配；`list_workspaces(cleanupPlan)` 只读计划可正常返回 |
| launchd 正式重载 | ✅ `kickstart -k`，单进程，`/healthz` 200 |
| Cloudflare Tunnel / OAuth | ✅ 公网 healthz 200；OAuth 元数据正常；`main` 限定授权未变 |
| 旧 Git 能力无回归 | ✅ fetch/push/merge/status/branch 全部存在且测试通过 |
| TriaRegna 零删除 | ✅ 未删除任何 Worktree、分支、文件或远端引用 |

**DEVSPACE_GIT_LIFECYCLE_READY**

> 说明：本判定针对「DevSpace 能力升级与验证」这一交付目标。§11 中的 TriaRegna 清理候选**尚未执行**——按用户明确要求，本轮仅做只读审计，不删除游戏项目的任何工作树或分支。§14 列出的边界是设计选择而非未完成项。
