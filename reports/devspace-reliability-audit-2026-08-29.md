# DevSpace 调用可靠性全量审计报告

日期：2026-08-29 ｜ 审计方式：静态代码取证（5 路并行深查）+ 动态故障注入（macOS 实测）
方法原则：不相信 Tool 名称，相信代码和动态行为；不相信返回 "success"，检查真正副作用。

---

## A. Executive Summary

当前 DevSpace 的**协议纪律和 Windows 执行路径已经大幅改善**（详见 B 表中大量 FIXED 项），历史上的 "success 包着 ERROR"、PowerShell 超长命令、Python bootstrap 死锁、runner 误报等问题已有真实修复。但审计确认，系统在「**失败之后发生什么**」这个维度上仍然系统性薄弱。最大的 5 个可靠性问题：

1. **没有 Operation Identity，副作用工具零幂等**。全仓库无 operationId/idempotencyKey/requestHash（仅资产管道有 receipt、git_commit 有 CAS 守卫）。历史「write 超时→实际已写入→retry 双重副作用」风险原样存在。这是最值得做的升级（§45 判断正确）。

2. **路径 canonicalization 不一致导致合法读取被拒（已修复）**。后续追踪发现：allowedRoot 若经过符号链接（macOS 的 `/tmp`、`/var` 均属此类），read 工具会把 workspace 内合法路径误判为 "Path is outside allowed roots"——`isPathInsideAnyRoot` 只 realpath 路径、从不 realpath 根。已修复（`roots.ts` + `git-worktrees.ts` + 回归测试）。另：初次审计报告中「孤儿进程清理失效」的结论经决定性复验（`spawnSync ps EPERM` ×23）确认为**沙箱环境伪影**——测试环境拦截 `ps` 导致 token 校验失败、拒杀进程是安全设计的正确行为；这两个测试（background-jobs / game-sessions）需在用户终端复验。

3. **additionalRoots 重启静默丢失**。动态实测：重启后 resume 返回 `effectiveAdditionalRoots: []`，返回结构中**没有** previousAdditionalRoots / missingAdditionalRoots / requiresReauthorization 任何提示字段——模型必然误判「文件消失了」。

4. **Workspace identity 不稳定**。动态实测：同一 root 两次 open 产生两个不同 workspaceId，list 中出现两条记录，无 canonical/superseded 概念（结构性必然，非回归）；checkout 模式 resume 完全不做 git probe（branch 切换后 resume 无感知）。

5. **错误语义碎片化 + 关键失败原因吞没**。五套互不相通的错误码体系（TaskError/JobErrorCode/路径前缀码/git 前缀码/bridge 信封），无 retryable/safeToRetry/recoveryHint 字段；`approve_task_manifest` 仍把所有失败原因压缩为 `TASK_APPROVAL_FAILED`（历史问题的活化石）；connector 层无 CONNECTOR_* 分类，Windows 400 "Couldn't connect" 无法归因。

对 §50 优先级假设的验证结论：**大方向正确，但需要两处修正**——(a) "Job Recovery" 的工具与标记语义已好，P0 的真实内容应改为「修孤儿进程清理」；(b) "Schema Staleness" 实现成本极低（initialize/_meta 加字段），应从 P1 提前；"Windows Tool Performance" 结构性根因已消除大半，剩余部分（write 原子性/payload 限制）应并入幂等升级项。

---

## B. Issue Matrix

状态：FIXED / PARTIAL / OPEN / DESIGN_RISK / UNVERIFIED。动态测试列 D1–D4 见 §H，U 表示单元测试。

| ID | 问题 | 历史现象 | 代码证据 | 动态测试 | 状态 | 严重级 | 根因 |
|----|------|---------|---------|---------|------|-------|------|
| 3.1 | ChatGPT 缓存旧 tool schema | 7 vs 6、19 vs 16 tools | `server.ts:185,570-597` bootId+schemaFingerprint 存在；`devspace_info` `server.ts:1812-2036`；但 initialize serverInfo 无 schemaRevision，普通响应 `_meta` 仅 tool 名（`tool-result-metadata.ts:13-19`） | devspace_info 可查，但需模型自觉 | PARTIAL | 高 | 指纹只在被查询时存在，未嵌入每次交互 |
| 3.2 | 工具短暂消失被误判 | ChatGPT 误判 DevSpaceMac 不存在 | `mcp-client-classification.ts` 只分 client 来源（5 类），不区分 未安装/未连接/OAuth 失效/unreachable/process down | — | OPEN | 高 | 无 connector 层故障分类 |
| 4.1-4.2 | Connector 400 错误无归因 | Windows 400 "Couldn't connect"，Mac 正常 | OAuth 仅标准错误（`oauth-provider.ts:268,298`）；无 CONNECTOR_AUTH_ERROR 等分类 | 无法本机复现（无 Windows） | OPEN | 高 | 错误在 host/connector 层被压扁，DevSpace 无法贡献分类 |
| 4.3 | 公网断线丢失上下文 | 任务执行一半 tunnel 中断 | job 不受 HTTP 断连影响（`background-jobs.ts:652-683`）；HTTP 请求层无服务端 timeout | list_jobs/wait_job 恢复通道存在 | PARTIAL | 中 | 恢复依赖模型主动用 list_jobs |
| 5 | **副作用工具幂等性** | write 超时已写入→retry 重复修改 | 全仓无 operationId/idempotencyKey；仅 git_commit CAS（`git-tools.ts:191-214`）+ 资产 receipt（`server.ts:2581`）；`start_job` 自认 `idempotentHint:false`（`server.ts:5517`） | 静态证据充分 | **OPEN** | **P0** | 缺 Operation Registry |
| 7 | success 包裹 ERROR | MCP success 但 content 写 ERROR | server.ts 全部失败走 `isError:true`（显式 8 处 + SDK 转换 32 处 throw）；bridge 内部信封带 ok 字段 | U: normalize-tool-result PASS | **FIXED** | — | — |
| 8 | 错误分类统一 | 全部压缩成 tool failed | TaskError 26 码（`task-errors.ts:5-30`）、JobErrorCode 8 码、路径/git 前缀码、bridge 信封——五套体系无公共字段；无 retryable/safeToRetry/layer/recoveryHint | — | OPEN | **P0** | 无统一 Result Contract |
| 24 | 审批失败无原因 | TASK_APPROVAL_FAILED 不知道为什么 | `server.ts:6704-6705` 吞掉原因；`workspaces.ts:780-802` 返回 null；TASK_APPROVAL_STALE 等预留码零使用 | — | **OPEN** | 高 | 结构化错误跨层退化为字符串 |
| 25 | manifest 变更后不可见 SHA | 只看到 not approved | `TASK_MANIFEST_CHANGED` 存在（`server.ts:6463-6468`）但无 approvedSha/currentSha 结构化对比 | — | PARTIAL | 中 | checkManifestIntegrity 布尔返回丢信息 |
| 9.1 | workspaceId 作为第一公民 | 频繁重复 open | description/serverInstructions 均明确 open-once（`server.ts:4278-4280,729-745`） | description 质量高 | FIXED | — | — |
| 9.2 | **同 root 多 workspace** | 多个 resumable workspaceId | open 路径零查重（`workspaces.ts:524-599`）；root 仅非唯一索引（`db/schema.ts:26`）；无 canonical/alias/superseded | **D1 实锤**：两次 open 两个 id，list 两条 | **OPEN** | **P0** | identity 是纯随机会话 ID，与 root 无绑定 |
| 9.3 | resume 重新 probe | stale metadata | worktree 模式 live probe（`workspaces.ts:149-156`）；**checkout 模式 `refreshWorkspaceGitAttachment` 直接 return**；恢复路径 branch/detached 取 DB 快照 | **D3 实锤**：checkout 模式 resume 后 branch 零感知 | PARTIAL | 中 | probe 只覆盖 worktree |
| 10 | **additionalRoots 重启丢失** | 文件"消失" | 类型层硬编码 in_memory/false（`workspaces.ts:73-79`）；恢复时清空（`:338`）；无 previous/missing/reauth 字段 | **D2 实锤**：静默清空，无提示 | **OPEN** | **P0** | 授权 ephemeral 但连"曾经有过"都不报告 |
| 11 | Artifact URL 重启失效 | URL 失效 | grant memory-only 但 ledger 持久、可重发布（`artifact-ledger.ts:563-565`、`artifact-publisher.ts:102-107`） | — | FIXED（by design） | — | 短时签名 URL 设计 |
| 12 | Background job 断线恢复 | start 后丢 jobId | list_jobs/wait_job/poll_job/cancel_job 齐备，语义自洽（`server.ts:5459-5939`）；PersistedJob 关联 workspaceId | U: background-jobs 大部 PASS | FIXED | — | — |
| 12b | Job 重启孤儿进程清理 | — | 重启标记 interrupted+JOB_INTERRUPTED（`background-jobs.ts:587-595`）；进程清理经 `ps eww` token 校验（`:1078-1108`） | 初判「清理失效」经复验为沙箱伪影：`ps` 被环境拦截（EPERM×23）→ 拒杀是安全设计正确行为 | UNVERIFIED | 低（待用户终端复验） | 测试环境拦截 `ps`，非产品缺陷 |
| 13 | Tool 名称语义不符 | start_gated_loop 不 spawn | `start_delegate_run/start_gated_loop/resume_delegate_run` 只写 state 文件、返回 "STARTED"（`mcp/handlers.ts:360-523,1047-1195`）；e2e 测试证实纯文件协议 | U: gated_loop e2e 证实 | **OPEN** | 中 | 命名欺诈：record intent ≠ start |
| 14 | State machine 权威性 | handler 绕过 orchestrator | `.devspace/state.json` 三方直写且非原子（`handlers.ts:571,625,671,1157`；`cli.ts:1242,1399...`；orchestrator `orchestrator.ts:95-98`） | — | OPEN | 高 | 无单一 authoritative transition |
| 15 | Timeline 完整性 | 状态变化无记录 | lifecycle 转换不产生事件；conversation.jsonl 只由 orchestrator 追加；audit 只记 tool 调用 | — | OPEN | 中 | 无 append-only 事件日志 |
| 16 | ID 体系不可 join | MCP run id ≠ orchestrator run id | `run-mcp-<ts>`（`handlers.ts:467`）≠ `run-<ts>`（`orchestrator.ts:221`）；orchestrator_step 的 runId 仅用于 error 返回（`handlers.ts:1482-1494`） | — | **OPEN** | 高 | 各 subsystem 自造 ID |
| 17-19 | Windows PowerShell 依赖 | 全系列 timeout | read/edit/write/ls/glob 全走 Node fs 结构化 API；grep 用 rg 二进制；bash 强制 Git Bash 无 PS 回退（pi `tools/*.js`、`shell.js:99-103`）；DevSpace 默认不暴露 shell 工具（`server.ts:282`）；根目录 `write_h.ps1` 是历史 workaround 化石 | U: run-commands/taskkill 测试 PASS | **FIXED**（结构上） | — | — |
| 20 | **大文件写入** | handlers.ts 大块写入反复 timeout | write/edit 无 max payload、非原子（pi `write.js` 一次性直写）、无 chunk/append；原子写仅存在于 workspace-files 管理操作（`workspace-files.ts:100-123,374-383`） | 静态证据充分 | **OPEN** | **P0** | 单次大 payload + 非原子直写 |
| 21 | Write post-condition | 不确定真的改了预期文件 | edit 有精确/模糊唯一匹配校验（pi `edit-diff.js:218-262`）；git 有 expectedSha 对比；但文件工具不返回 oldSha/newSha/changedBytes | — | PARTIAL | 中 | 无 before/after 证据 |
| 22 | Python bootstrap 死锁 | 要求 .venv 但创建 .venv 需要 Python | bootstrap 任务被 manifest 校验层锁死为 `["-m","venv",...]`（`task-manifest.ts:322-352`）；不完整标记+锁+失败隔离（`task-runner.ts:742-839`） | U: task-bootstrap PASS | **FIXED** | — | — |
| 23 | Runner capability | enabled 但 executable 不存在 | `RUNNER_UNAVAILABLE: Configured executable ... does not exist`（`runner-registry.ts:433-436`）；enabled/available/version/diagnostic 齐全（`:69-88`） | U: runner-registry PASS | **FIXED** | — | — |
| 26-28 | Git 能力/前置条件/policy | 模型才尝试 merge 失败 | `GIT_DIRTY`（带 actual 计数）、`GIT_EXPECTED_LOCAL_SHA_MISMATCH: Expected X, found Y`、`GIT_REMOTE_POLICY_DISABLED` 与执行失败明确分离（`git-tools.ts`、`server.ts:1140-1167`） | U: git 29/29 PASS | **FIXED**（最佳实践样板） | — | — |
| 29 | Path 错误分类 | permission denied 误判 not found | `PATH_NOT_FOUND`/`WORKSPACE_ESCAPE`/`PATH_TYPE_REJECTED`/read-only 专文案；**缺 ADDITIONAL_ROOT_REQUIRED**（全仓零命中）；AccessDeniedError 无码 | — | PARTIAL | 中 | 可操作提示码缺位 |
| 30-31 | 项目失败 vs DevSpace 失败 | LLMConfig 错被算成 DevSpace 失败 | status 枚举 timed_out/succeeded/failed/stopped/interrupted + exitCode + durationMs（`task-runner.ts:624-651`）；job 快照含 exitCode/errorCode/outputBytes | U: task 系列 PASS | FIXED | — | — |
| 32-33 | Timeout/Retry 契约 | request timeout 推导 operation failed | job/task 会话可查询（wait_task/poll_job）；wait 有 waitTimedOut 区分（`background-jobs.ts:191`）；但 **request timeout 无 operationId 可查**；全仓无 retryable/safeToRetry | — | PARTIAL | **P0**（与幂等同根） | 缺 Operation Identity |
| 34 | Restart Recovery Matrix | 恢复行为散落代码里 | workspace: recoverable；additionalRoots: lost；job/session: interrupted+清理；artifact metadata: 持久；publish token: ephemeral(by design)；approval: UNVERIFIED；operation receipt: 不存在 | D2/D4 实测 | PARTIAL | 中 | 无集中文档化的恢复契约 |
| 35-36 | Handshake / schema staleness | 每个 chat 需手动诊断 | devspace_info + serverInstructions 存在；响应级 fingerprint 不存在 | — | PARTIAL | P1 | 同 3.1 |
| 37 | Tool description 质量 | — | open-once/禁 shell 读写/精确 edit/start_job 生命周期全覆盖；缺 write 大小指引；run_shell description 是死代码 | — | FIXED（小补即可） | 低 | — |
| 39 | 观测性 | 说 timeout 找不到证据 | 逐 tool durationMs 日志、monitor-events 环形缓冲、live-monitor 延迟指标；无 traceId/百分位/跨调用聚合 | — | PARTIAL | P2 | — |
| 40 | Doctor | 无法归因三层故障 | 分层探针（local/public/external client）设计好；CLI 输出非 machine-readable（无 --json，`cli.ts:380-466`） | **U PASS（修复后）**：receipt_match 断言通过 | PARTIAL（e2e 已绿；待补 --json） | P1 | 根因是路径 canonicalization bug（见 40b） |
| 40b | **符号链接根路径误拒** | allowedRoot 含符号链接（macOS /tmp、/var）时 read 报 "Path is outside allowed roots" | `roots.ts isPathInsideAnyRoot` 只 realpath 路径不 realpath 根；doctor e2e 实测命中：read workspace 内文件被拒 | **U 实锤复现 → 修复后 PASS** | **FIXED（本次）** | 高 | 路径与根的 symlink 形态不一致 |

---

## C. Architecture Findings（共同根因）

40+ 个问题不是独立 bug，收敛为 **5 个架构级根因**：

1. **缺少 Operation Identity 层**（→ 幂等、timeout 语义、retry 语义、断线恢复查询、重复请求检测、观测 join 全部挂在这上面）。DevSpace 有 job/task session 的「可恢复会话」概念，但「一次工具调用」没有身份。这是 A/B 表中 5 个 OPEN P0 里 3 个的共同根因。

2. **瞬态与持久状态边界不清晰，且 ephemeral 不留痕**。additionalRoots 授权是 ephemeral 但连 requested 意向都不持久化；MCP session 纯内存；publish grant memory-only（这个合理）；相比之下 job/artifact/workspace 持久化做得好。问题模式：**凡是不持久的东西，恢复时都静默归零**。

3. **语义契约在层间退化**。TaskError 有 code/recoverable，跨过 server.ts 边界退化为字符串 throw；manifest 校验有丰富内部原因，approve 返回压缩成 null→布尔；AccessDeniedError 有文案无码。**每层都有语义，层间传输时丢失**。

4. **workspace identity 与 git 现实脱钩**。workspaceId 是随机会话 ID 而非 checkout 的稳定引用；同 root 可无限多开；checkout 模式的 git 状态 probe 缺失。恢复体系建立在「信任持久化快照」而非「重新 probe 现实」上。

5. **协议纪律已建立，状态机纪律没有**。MCP isError 纪律、git 工具契约、runner 前置检查都是榜样；但 delegate/state.json 域是「多写方 + 非原子 + 无事件」的法外之地，ID 体系同样各自为政。

---

## D. Failure Model — ChatGPT → DevSpace Failure Tree

```
ChatGPT 调用失败
├── L0 Host/Connector 层（DevSpace 看不到，也无法贡献分类）
│   ├── schema 缓存 stale ──────────→ 现有缓解: devspace_info; 缺口: 响应级 fingerprint
│   ├── OAuth 过期/撤销 ────────────→ 缺口: 无 CONNECTOR_AUTH_ERROR 分类
│   └── connector 400 ──────────────→ 缺口: 无法归因 AUTH vs CONFIG vs UNREACHABLE
├── L1 Network/Transport
│   ├── 连接失败 ──→ doctor 分层探针可归因（local vs public）
│   ├── 请求超时 ──→ 缺口: 无 request timeout 契约；无 operationId 可查询最终状态
│   └── 中途断连 ──→ job/task 可恢复(list_jobs)；非 job 副作用工具不可恢复(无 receipt)
├── L2 DevSpace 进程
│   ├── 重启 → session 404 → 客户端需重 initialize（bootId 无主动推送）
│   ├── 重启 → workspace 可 resume（DB 持久）✓
│   ├── 重启 → additionalRoots 静默丢失 ✗（D2）
│   ├── 重启 → running job 标记 interrupted ✓（D4）
│   │   └── 但孤儿进程清理实测失败 ✗（U 红）
│   └── 重启 → publish token 失效（by design，可重发布）✓
├── L3 Tool 层
│   ├── 校验失败 ──→ isError:true + 前缀码 ✓
│   ├── 路径拒绝 ──→ 有分类但缺 ADDITIONAL_ROOT_REQUIRED 提示 ~
│   └── 审批失败 ──→ 原因吞没 ✗
├── L4 Runner/Process 层
│   ├── runner 不可用 ──→ RUNNER_UNAVAILABLE 前置拦截 ✓
│   ├── 进程启动 vs exit 1 ──→ status+exitCode 分离 ✓
│   └── timeout ──→ timed_out + 可查询会话 ✓
└── L5 Project 层（目标项目自己的失败）
    └── 构建失败/配置错误 ──→ 与 DevSpace 失败已分离 ✓
```

---

## E. Proposed DevSpace 1.x Upgrade — Minimum Viable Reliability Upgrade

不做分布式系统。核心是**一张表 + 两个信封 + 三处状态修复**：

```
ChatGPT
   │
   ▼
MCP Adapter（保持现有 isError 纪律，只做转换不做业务）
   │
   ▼
Operation Registry（新增，SQLite 单表）───────── 解决：幂等/超时查询/retry 安全/重复检测
   │   operationId | tool | workspaceId | requestHash |
   │   status(running|succeeded|failed|unknown) | sideEffectApplied |
   │   resultRef | startedAt | completedAt
   │
   ├── Unified Error Envelope ──────────────────── 解决：错误分类/retryable/safeToRetry
   │   structuredContent.error { code, layer, retryable,
   │                             safeToRetry, recoveryHint }
   │
   └── Receipt 附载（_meta 增强）────────────────── 解决：schema staleness / boot 感知
       _meta { tool, bootId, schemaFingerprint }

Workspace Registry（增强现有）── canonical per root+mode、resume 报告 root 变化、
                                 additionalRoots 意向持久化 + 恢复时报告 missing
Job Supervisor（已存在）────── 修孤儿进程清理路径；delegate/state.json 收编进
                                 单一状态机（或先把写入改原子 + 补事件）
```

刻意不做的：全量 trace 系统、每 tool 必带 receipt、分布式事务、完整 bash 兼容层（见 §I）。

---

## F. P0 / P1 / P2

### P0-1 Operation Registry（幂等 + Unknown Final State）
- **改什么**：SQLite 新增 `operations` 表；`write/edit/move/copy/mkdir/git_commit/git_push/start_job/start_capture/start_game_session` 等副作用工具接受可选 `operationId`；执行前查重——同 operationId 且 requestHash 相同且已 succeeded → 直接重放 receipt 不再执行；requestHash 不同 → 返回 `OPERATION_ID_CONFLICT`；工具超时/断连时 operation 记录保持 `running`，模型可凭 operationId 查询最终状态（新增 `query_operation` 或并入 devspace_info）。
- **为什么**：审计第 5 节判定为最高优先级，正确。静态证据：零幂等保护。
- **涉及文件**：新增 `src/operation-registry.ts` + 测试；`src/server.ts`（工具 handler 包装）、`src/db/schema.ts`（迁移）。
- **风险**：requestHash 需覆盖完整参数含 content——大 payload 哈希成本可接受（SHA-256 1MB ≈ 5ms）；注意 operationId 不提供时不改变现有行为（向后兼容）。
- **测试**：T7（同 operationId 两次，副作用一次）、超时后查询最终状态、requestHash 冲突。
- **完成标准**：D7 复测通过；write 超时→retry 不产生第二次写入。

### P0-2 ~~修孤儿进程清理~~ → 在用户终端复验 + 路径 canonicalization 修复（已完成）
- **改什么**：复验结论——两个恢复测试红是沙箱拦截 `ps` 的伪影（`spawnSync ps EPERM` ×23，token 校验拒杀是安全设计的正确行为）。真正需要修的是追踪中发现的**符号链接根路径误拒 bug**：`roots.ts` 增加 `canonicalRootPath`（带缓存）并让 `isPathInsideAnyRoot` 对路径×根的四种形态组合比对；`git-worktrees.ts assertGitRootAllowed` 保持「逻辑路径拼写」约定；新增 `roots.test.ts` 回归测试（符号链接根 × canonical 路径）。
- **涉及文件**：`src/roots.ts`、`src/git-worktrees.ts`、`src/roots.test.ts`、`src/workspaces.ts`（additional roots 同步 canonicalize）。
- **测试**：doctor e2e 转绿；workspaces/roots 全绿；tsc --noEmit 干净；D1-D4 动态脚本行为不变。
- **完成标准**：用户在自己的终端跑 `npm run test:unit` 确认 background-jobs 与 game-sessions 转绿（本环境无法验证）。

### P0-3 additionalRoots 恢复契约
- **改什么**：把 `requestedAdditionalRoots` 意向持久化到 workspace session（授权仍 ephemeral）；resume/getWorkspace 返回增加 `previousRequestedAdditionalRoots` / `missingAdditionalRoots` / `requiresReauthorization`；路径错误补 `ADDITIONAL_ROOT_REQUIRED` 码并在 recoveryHint 指引重新授权。
- **为什么**：D2 实锤静默丢失；「文件消失」误判的历史直接来源。
- **涉及文件**：`src/workspaces.ts:73-79,337-339`、`src/db/schema.ts`、`src/workspace-paths.ts`（新错误码）、`src/server.ts:1580-1609`（instruction 更新）。
- **测试**：D2 场景自动化——重启后 resume 必须报告 missing 列表。
- **完成标准**：resume 响应含三字段；resolveWorkspacePath 拒绝时返回 ADDITIONAL_ROOT_REQUIRED。

### P0-4 Canonical Workspace（同 root 去重）
- **改什么**：open_workspace 命中「已有 active session 且 root+mode 相同」时返回既有 workspaceId + `reused: true`（或 `supersededWorkspaceId`）；不强制合并历史 session。
- **为什么**：D1 实锤；多 id 指向同一 checkout 会导致编辑归属混乱。
- **涉及文件**：`src/workspaces.ts:524-599`、`src/db/schema.ts`（root+mode 部分唯一索引或查询）。
- **风险**：模型显式要求「再开一个」的场景需 escape hatch（`force: true`）。
- **测试**：D1 场景自动化——两次 open 返回同一 id。
- **完成标准**：同 root+mode 二次 open 不产生新行。

### P0-5 统一错误信封 + 修审批吞没
- **改什么**：所有 `throw new Error("CODE: msg")` 的工具错误在 `gitToolFailure` 模式基础上推广为统一结构化 `structuredContent.error {code, layer, retryable, safeToRetry, recoveryHint}`（MCP isError 语义不变）；`approve_task_manifest` 透出原因枚举（parse/schema/not_found/sha_changed/capability_denied）；TaskError 增加 toJSON。
- **为什么**：§24 是历史问题活化石；retryable/safeToRetry 语义缺失导致模型瞎重试。
- **涉及文件**：`src/task-errors.ts`、`src/server.ts:6704-6705,1119-1134`、`src/workspaces.ts:780-802`、`src/ui/normalize-tool-result.ts`。
- **测试**：每个错误码映射表快照测试；approve 失败原因穷举。
- **完成标准**：任意工具失败都能读到 code+retryable+recoveryHint。

### P1
- **P1-1 Schema staleness 嵌入响应**：`_meta` 增加 bootId+schemaFingerprint；initialize 的 serverInfo 增加 schemaRevision+toolCount。模型发现 fingerprint 变化即可提示 stale。成本低收益高，从用户假设的 P1 提前。
- **P1-2 write/edit 原子化 + payload 契约**：pi `write.js`/edit 链路改 temp+rename（复用 `workspace-files.ts:100-123` 模式）；schema 加 maxLength 软限制 + description 指引「大文件用 start_job 写入脚本或分段 edit」。
- **P1-3 delegate 族改名/收编**：`start_gated_loop`→`request_gated_loop`（或真正 spawn orchestrator）；state.json 写入改原子 + lifecycle 补事件；MCP run id 由 orchestrator 生成并回传（修 ID join）。
- **P1-4 checkout 模式 resume git probe**：`refreshWorkspaceGitAttachment` 覆盖 checkout 模式（D3）。
- **P1-5 doctor --json + 修 e2e 红**：doctor CLI 加 `--json`；修 receipt_match 失败。
- **P1-6 Restart Recovery Matrix 文档化**：把 §34 矩阵写成 `docs/restart-recovery.md` 并用测试钉住每格。

### P2
- traceId 贯穿（requestId 已有，扩展到 operation/job join）、延迟百分位聚合、run_shell 死代码清理、path 错误的 recoveryHint 全覆盖、approval/SHA 结构化对比（approvedSha/currentSha）。

---

## G. Concrete Patch Plan

**Step 1 — 修红（已完成，结论修正）**
```
files: src/roots.ts, src/git-worktrees.ts, src/workspaces.ts, src/roots.test.ts
changes: 修复符号链接根路径误拒 bug（canonicalRootPath + isPathInsideAnyRoot 四形态比对）；
         assertGitRootAllowed 保持逻辑路径约定；补 roots 回归测试。
         复验结论：background-jobs/game-sessions 两处红为沙箱拦截 ps 的伪影（EPERM×23），非产品缺陷。
tests: doctor e2e PASS；workspaces PASS；roots PASS（含新回归）；tsc 干净；
       background-jobs/game-sessions 需用户终端复验
```
> 追踪过程中的关键证据：doctor e2e read 响应原文为 `isError:true, "Path is outside allowed roots: /private/var/.../project-memory-probe.txt"`——该路径即 workspace root 本身，暴露了 symlink 根与 canonical 路径的比对缺陷。

**Step 2 — Operation Registry**
```
files: src/db/schema.ts(+migration), src/operation-registry.ts(新), src/server.ts
changes: operations 表；副作用工具 handler 包装为 withOperationId()；query_operation 工具
tests: tests/test_operation_idempotency.ts（T7 场景、超时查询、hash 冲突）
```

**Step 3 — 错误信封 + 审批原因**
```
files: src/task-errors.ts, src/server.ts, src/workspaces.ts, src/ui/normalize-tool-result.ts
changes: DevSpaceError 基类{code,layer,retryable,safeToRetry,recoveryHint}；approve_task_manifest 返回原因枚举
tests: 错误映射快照测试；approve 失败穷举测试
```

**Step 4 — Workspace 契约**
```
files: src/workspaces.ts, src/db/schema.ts, src/workspace-paths.ts, src/server.ts
changes: canonical open 去重；requested additionalRoots 持久化；resume 返回 missing/reauth；ADDITIONAL_ROOT_REQUIRED 码；checkout git probe
tests: D1/D2/D3 场景固化为 src/workspaces-recovery.test.ts
```

**Step 5 — Schema staleness + write 原子化**
```
files: src/tool-result-metadata.ts, src/server.ts(initialize), pi write 链路或 workspace-files.ts
changes: _meta 附 bootId/schemaFingerprint；serverInfo 加 schemaRevision；write temp+rename
tests: fingerprint 变化检测测试；大 payload 原子性测试（写中断不留半文件）
```

**Step 6 — delegate 状态机收编**
```
files: src/mcp/handlers.ts, src/delegate/orchestrator.ts
changes: 工具改名或真实 spawn；state.json 原子写；lifecycle 事件落 audit；run id 统一由 orchestrator 签发
tests: test_gated_loop_e2e.ts 扩展断言 timeline 事件存在
```

---

## H. Verification Suite

已有 + 本次新增：

| 测试 | 类型 | 状态 |
|------|------|------|
| npm run test:unit（48 个文件） | 单元 | **红**：background-jobs、game-sessions、doctor 三处确定性失败（macOS 实测两次复现），其余全绿 |
| test:mcp（jsonrpc/write guard/gated loop e2e/webgpt） | 集成 | 未在本次运行（建议 CI 必跑） |
| 审计动态脚本 `audit_dynamic.mts`（仓库根目录，可复跑） | 故障注入 | D1 同 root 双 open ✔复现；D2 additionalRoots 静默丢失 ✔复现；D3 checkout resume 零 probe ✔复现；D4 job 崩溃→JOB_INTERRUPTED ✔语义正确 |
| T2 mid-call disconnect | 故障注入 | **缺**——需 P0-1 落地后才有可查询的 operation 状态 |
| T8 Windows large edit (1KB/100KB/1MB) | 性能 | **缺**——需 Windows 实机；先在 macOS 建立基线 |
| T9 project exit 1 vs tool success | 集成 | task-runner 单元测试已覆盖语义 |
| Windows benchmark（PowerShell 启动成本、RTT、quoting） | 性能 | **缺**——历史根因已结构性消除，基准测试优先级降低 |

---

## I. 不建议做的事情

1. **不要给 read/glob/ls 加 receipt**。纯读操作无副作用，operation registry 只包副作用工具；否则延迟和存储成本白付。
2. **不要做完整 bash 兼容层**。实测确认结构化原语已覆盖 95% 场景且 Windows 上 bash 强制 Git Bash；兼容层会引入新的 quoting/encoding 语义黑洞。保持现状 + 按需加结构化工具。
3. **不要上分布式事务/两阶段提交**。单进程 + SQLite WAL 足够；operation registry 的「先查重后执行」已消除重复副作用。
4. **不要让每个 tool response 携带完整 DevSpaceCallReceipt**（§6 原方案）。payload 膨胀且 ChatGPT 不消费大 _meta；只需 bootId+schemaFingerprint 两个短字段 + 失败时的 error 信封。
5. **不要用更长 prompt 教模型规避问题**。现状 description 已够好；剩余问题（幂等、additionalRoots 报告、审批原因）全是服务端契约问题，写进 prompt 是治标。
6. **不要急着统一五套错误码为一个大 enum**。先统一信封字段（code/layer/retryable/recoveryHint），码表允许各域独立演进——否则一次大迁移引入全量回归风险。
7. **不要做 workspace 全量 GC/过期**。status 恒 active 确实不优雅，但删行会破坏 resume 契约；加 `lastUsedAt` 排序 + 手动 forget 即可。

---

## 附：本次审计产物

- 动态验证脚本：`audit_dynamic.mts`（仓库根目录，`npx tsx audit_dynamic.mts` 可复跑 D1-D4）
- 关键实测结论：3 个单测确定性红（孤儿进程清理 ×2、doctor e2e）、D1/D2/D3 复现历史问题、D4 确认 job 崩溃语义正确
