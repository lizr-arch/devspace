# DevSpace CNB Git 权限与 Godot Import 能力升级报告

- 报告时间：2026-10-10
- 目标服务：DevSpace Mac 1.1.0（Cloudflare MCP 对接 ChatGPT）
- 本轮范围：仅升级 DevSpace 基础设施；**未执行** TriaRegna P2 合并、**未推送**任何 TriaRegna 分支、**未修改** `main`
- 最终状态：`DEVSPACE_CNB_GIT_AND_GODOT_IMPORT_READY`（G1–G9 全部实测通过；G10 服务端通过、客户端待重连）

---

## A. DevSpace 当前架构与真实源码位置

### A1. 真实源码与运行位置（实测确认，非假设）

| 项目 | 实际值 |
|---|---|
| 源码仓库 | `/Users/liz/Documents/Codex/2026-07-21/wo-de/work/devspace` |
| 包版本 | `@waishnav/devspace` 1.1.0，`main = dist/server.js`，`bin = devspace → dist/cli.js` |
| 启动方式 | LaunchAgent `com.liz.devspace`（`RunAtLoad` + `KeepAlive`） |
| LaunchAgent 文件 | `/Users/liz/Library/LaunchAgents/com.liz.devspace.plist` |
| 实际命令 | `/Users/liz/.hermes/node/bin/node dist/cli.js serve`，`WorkingDirectory` = 源码仓库 |
| 进程 PATH | `/usr/bin:/bin:/usr/sbin:/sbin`（launchd 最小 PATH，**不含 `dotnet`**——本轮修复点之一） |
| 用户配置 | `/Users/liz/.devspace/config.json`（由 `src/user-config.ts::devspaceConfigPath` 决定） |
| owner token | `/Users/liz/.devspace/auth.json`（0600，本轮全程未读取明文、未输出、未传递） |
| 状态目录 | `/Users/liz/.local/share/devspace`（`src/config.ts::defaultStateDir`） |
| 托管 worktree 根 | `/Users/liz/.devspace/worktrees`（`src/config.ts::defaultWorktreeRoot`） |
| 本地监听 | `http://127.0.0.1:7676` |
| Cloudflare Tunnel | `devspace-mac` → `https://mcp.workspaceport.com`（`/Users/liz/.devspace/CLOUDFLARE-TUNNEL.md`） |
| MCP 端点 | `https://mcp.workspaceport.com/mcp`（**本轮未更换**） |
| 日志 | `~/.local/state/devspace/devspace.log` / `.error.log`、`~/.devspace/logs/cloudflared.*.log` |

### A2. 关键代码路径

| 关注点 | 位置 |
|---|---|
| MCP server 组装 / tool 注册 | `src/server.ts::createMcpServer`（SDK: `@modelcontextprotocol/sdk` + `StreamableHTTPServerTransport`） |
| Tool schema 生成 | `registerAppTool`（`src/server/server-helpers.ts`）→ `McpServer.registerTool`，schema 为 zod/v4 对象，MCP `tools/list` 动态生成（**无需手工重生成**） |
| 对外 tool 目录 / 版本指纹 | `src/server/server-helpers.ts::exposedToolNames` + `createServiceRuntime`（sha256 覆盖 tools 列表、`TOOL_SCHEMA_REVISION`、`gitRemoteWrite`、`godotImport`、runner 名单、Workspace App build） |
| `TOOL_SCHEMA_REVISION` | `src/server/server-types.ts` |
| `git_fetch` / `git_merge` / `git_push` 注册 | `src/server/tools-git.ts` |
| Git remote policy | `src/server/server-helpers.ts::gitRemotePolicyForWorkspace`；`src/config.ts::parseGitRemoteWritePolicy` |
| Git 远端实现 | `src/git-remote.ts`（`fetchGit` / `fetchGitLocked` / `pushGit` / `assertApprovedRemote` / `assertSafeLocalRemoteConfig`） |
| Git 基础原语 | `src/git-tools.ts`（`runGit`、`inspectGitStatus`、mutation lock） |
| `project_task` 机制 | `src/server/tools-tasks.ts` + `src/task-manifest.ts`（`.devspace/tasks.yaml` + `approve_task_manifest` 记录的 manifest SHA，改动即失效） |
| `start_job` runner 校验 | `src/runner-registry.ts::validateArguments` + `src/runner-validation.ts::validateActionPolicy` |
| Godot 参数验证器 | `src/runner-validation.ts`（**改为新增独立 editor-import 策略，未放松原策略**） |
| 后台 Job 生命周期 | `src/background-jobs.ts`（超时、日志、并发、取消、进程组回收） |
| 对外能力自描述 | `src/server/tools-info.ts::devspace_info` |

### A3. 架构结论（配置 / 代码 / Schema / 重启 / 必须保留的安全约束）

- **纯配置即可解决**：`gitRemoteWrite` 白名单与启用开关、`gitRemoteWrite.approvedRemoteUrls` 精确绑定、`godotImport` 授权项目根。
- **必须改代码**：
  1. **Git Push 已有完整内部实现但被 `config.gitRemoteWrite.enabled` 关闭**——启用后即可暴露，无需新写推送逻辑；但本轮补强了远端 URL / 本地 Git 配置的安全校验（见 B3）。
  2. Fetch 默认 `prune=true`，与"默认不得 Prune"冲突 → 改为默认 `prune=false`（调用方仍可显式要求）。
  3. Godot `--editor` 在原策略中被硬拒绝 → 新增独立的 `godot_editor_import_v1` 固定参数策略，**不修改原 `godot_headless_v1`**。
  4. 新增 `godot_import` MCP 能力（授权、并发锁、错误普查、跟踪文件完整性）。
  5. Godot Mono 在 launchd 最小 PATH 下找不到 `dotnet` → 为 `godot` / `godot-mono` runner 补齐 .NET SDK 的 PATH / `DOTNET_ROOT`。
- **是否需要重新生成 MCP schema**：**不需要**。schema 由代码在启动时动态生成；只需重建 `dist` 并重启服务，`tools/list` 即刷新。
- **是否需要重启服务**：**需要**（配置与 tool 目录在启动时一次性加载）。
- **必须保留的安全约束（本轮全部保留，且部分加强）**：
  `git_push` 仍为 `strictObject`（无 force / refspec / delete / tag / url 入参）；仍强制 clean workspace、clean attached branch、本地 SHA 校验、远端 SHA 校验、快进校验、推送后远端复核；仍拒绝仓库本地可执行 Git 配置；
  `git_merge` / `git_push` 仍要求 DevSpace 托管 worktree；
  OAuth / Cloudflare 认证链路未被 Git 权限升级绕过（`git_*` 仍需 MCP bearer token，OAuth provider 未改动）；
  **未新增任何任意 Shell 执行入口。**

---

## B. Git Remote Policy 修改

### B1. 授权仓库（精确匹配，无子串包含）

配置文件 `/Users/liz/.devspace/config.json`：

```json
"gitRemoteWrite": {
  "enabled": true,
  "approvedRemotes": ["origin"],
  "approvedDestinationBranches": [
    "feat/wego-p0-gui-performance",
    "fix/wego-p1-locale-native-crash",
    "devspace/integration/TriaRegna-TriaRegna-b58942f7"
  ],
  "approvedRepositoryRoots": ["/Users/liz/agy/TriaRegna"],
  "approvedRemoteUrls": {
    "origin": [
      "https://cnb.cool/hesans/TriaRegna",
      "https://cnb.cool/hesans/TriaRegna.git"
    ]
  }
}
```

匹配逻辑（`src/git-remote.ts::assertApprovedRemote` + `src/server/server-helpers.ts::gitRemotePolicyForWorkspace`）：

1. 远端名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$` 且 **精确等于** `approvedRemotes` 的某一项；
2. 远端必须真实存在于该 Git 工作区（`git remote`）；
3. **规范化后的完整远端身份**：`git remote get-url --all`（推送时为 `--push --all`）的**每一个** URL 必须**字符串精确等于** `approvedRemoteUrls[remote]` 中的某一项——不做包含、不做前缀、不做模糊匹配；
4. 授权项目：`workspace.sourceRoot ?? workspace.root` 必须**精确等于** `approvedRepositoryRoots` 中的某一项；
5. URL 传输必须安全（https 无内嵌凭证/query/fragment，或 `file://`，或本地绝对路径），且必须以 `-` 开头 / 含 `ext::` / 换行 的一律拒绝；
6. 仓库本地 Git 配置中任何 `core.sshcommand|gitproxy|askpass|editor|hookspath|fsmonitor|pager`、`credential.*`、`include*`、`url.*.insteadof|pushinsteadof`、`http.*`、`remote.*.uploadpack|receivepack|proxy|vcs|pushurl` 一律拒绝。

> **重定向防护实测**：`git remote get-url` 会应用 `url.<base>.insteadOf` 重写。实测在全局 gitconfig 中把 `https://cnb.cool/hesans/TriaRegna` 重写到 `https://evil.example/` 后，`get-url` 返回 `https://evil.example/`——因此第 3 条的精确比对会自动拒绝该重定向（`GIT_REMOTE_URL_MISMATCH`）。该行为既有仓库本地、也有用户/全局配置，覆盖生效。

`approvedRepositoryRoots` 允许为 `checkout`（root）与 `DevSpace 托管 worktree`（sourceRoot）两种形态，与原 `git_merge`/`git_push` 的托管 worktree 要求一致。

### B2. 相对升级前的实际差异

| 项 | 升级前（实测） | 升级后（实测） |
|---|---|---|
| `gitRemoteWrite.enabled` | `false` | `true` |
| `git_fetch` 结果 | `GIT_REMOTE_POLICY_DISABLED` | CNB fetch 成功 |
| `git_push` 是否暴露 | 未注册（`tools/list` 中不存在） | 已注册并按白名单生效 |
| Fetch 默认 prune | `true` | `false`（显式 `prune:true` 仍可用） |
| 仓库本地 Git 配置黑名单 | `core.sshcommand/gitproxy`、`url.*.insteadOf` 等因 git 小写化**实际从未命中** | 全部改为小写字面量，实测命中 |

### B3. 本轮新增的安全硬化（`src/git-remote.ts`）

原正则使用驼峰（`core.sshCommand`、`url.*.insteadOf`），而 `git config --local --get-regexp` 输出的 key 是**小写**的，因此这些分支此前不会命中。已改为小写字面量并扩充：

```
^(core\.(sshcommand|gitproxy|askpass|editor|hookspath|fsmonitor|pager)
 |credential\..*|include(if)?\..*
 |url\..*\.(insteadof|pushinsteadof)
 |http\..*
 |remote\..*\.(uploadpack|receivepack|proxy|vcs|pushurl))$
```

并新增回归测试：对 7 类敌意仓库本地配置，`git_fetch` 与 `git_push` 均返回 `GIT_REMOTE_CONFIG_REJECTED`，且远端 refs 完全未变动。

---

## C. Fetch 功能及权限

### C1. 实现与调用链

`git_fetch`（`src/server/tools-git.ts`）→ `gitRemotePolicyForWorkspace` → `fetchGit` → `fetchGitLocked`（`src/git-remote.ts`），底层命令固定为：

```
git fetch <--no-prune|--prune> --no-tags --no-write-fetch-head -- <remote> +refs/heads/*:refs/remotes/<remote>/*
```

- 不接收 URL、不接收 refspec、不接收任意 Git 参数；`remote` 必须通过 B1 全部校验。
- 与所有远端写操作共用 `withGitMutationLock`（按公共 Git 目录加锁，linked worktree 也串行）。

### C2. 行为保证（代码 + 实测）

| 要求 | 实现 | 实测 |
|---|---|---|
| 从授权 CNB 仓库 Fetch | ✔ | ✔ `updated/created/deleted` 计数返回 |
| 更新远端跟踪引用 | ✔ | ✔ `refs/remotes/origin/*` |
| 查询远端 main 与功能分支 | ✔ | ✔ `refs/remotes/origin/main = 21af0290…`、`feat/wego-p0-gui-performance = 588a43be…`、`fix/wego-p1-locale-native-crash = d4a43e84…` |
| 显示更新引用及 SHA | ✔ | ✔ `updatedRefs` / `createdRefs` / `deletedRefs` 含 before/after SHA |
| 不改动工作区文件 | ✔ fetch 后前后 `git status` 全字段比对，不一致即抛 `GIT_FETCH_WORKSPACE_CHANGED` | ✔ 脏工作区逐字节不变 |
| 不自动切换分支 / 不 Merge / 不 Rebase | ✔ 命令中无任何此类动作 | ✔ HEAD、branch 不变 |
| 不删除本地分支 | ✔ 仅写 `refs/remotes/*` | ✔ |
| 默认不 Prune | ✔ 本轮修正 `input.prune ?? false` | ✔ 输出 `prune=false`，`deletedRefs=[]` |
| 不改动 HEAD | ✔ 前后 `headSha` 比对 | ✔ |

> 说明：`pushGit` 内部为做 compare-and-swap 会显式调用 `fetchGitLocked(..., prune: true)`，属于推送前的远端复核，与"用户可调用的 fetch 默认不 prune"不冲突。

---

## D. Push 实现、白名单与拒绝规则

### D1. 能力真实性

- 升级前 `git_push` **完全未注册**（`tools/list` 无此项），`tools-git.ts` 中实现被 `config.gitRemoteWrite.enabled` 整体包裹。
- 升级后 **真实存在**，实测 `tools/list` 返回 61 个已注册工具（含仅 App 可见的 `report_workspace_app_error`），`devspace_info` 对外声明 60 个模型可见工具，其中包含 `git_push`。
- **不是**"把 enabled 改成 true 就宣称完成"：本轮除配置启用外，还完成
  1) 仓库本地 Git 配置黑名单修复（B3，否则重定向/凭证注入分支形同虚设）；
  2) 在隔离本地 bare 远端上做了**完整的 MCP 级正反向推送验证**（含一次真实快进推送成功，见 G3/G4）；
  3) 修正 fetch 默认 prune 与推送前置校验的一致性。

### D2. 白名单

默认允许的目标（`approvedDestinationBranches`）：

- `feat/wego-p0-gui-performance`
- `fix/wego-p1-locale-native-crash`
- `devspace/integration/TriaRegna-TriaRegna-b58942f7`（当前 P2 隔离集成分支）

**`main` 默认禁止**（未列入白名单，实测拒绝）。未来 P2 全量验证通过后，需要**另一次明确授权**（在 `/Users/liz/.devspace/config.json` 的 `approvedDestinationBranches` 中显式加入 `main` 并重启服务）才能临时允许向 `main` 普通推送。

### D3. 推送前置/后置校验（`src/git-remote.ts::pushGit`，逐条实测）

| # | 校验 | 失败码 | 实测 |
|---|---|---|---|
| 1 | 工作区 clean（staged/unstaged/untracked/conflicts 均为空） | `GIT_WORKSPACE_NOT_CLEAN` | ✔ |
| 2 | 必须 attached branch（非 detached） | `GIT_DETACHED_HEAD` | ✔ |
| 3 | 远端名精确授权 + 真实存在 + URL 精确绑定 + 本地 Git 配置安全 | `GIT_REMOTE_NOT_APPROVED` / `GIT_REMOTE_NOT_FOUND` / `GIT_REMOTE_URL_MISMATCH` / `GIT_REMOTE_CONFIG_REJECTED` / `GIT_REMOTE_INVALID` | ✔ |
| 4 | 目标分支白名单 | `GIT_DESTINATION_BRANCH_NOT_APPROVED` | ✔ |
| 5 | `sourceRef` 必须是当前 HEAD（`HEAD:任意分支` 不可绕过） | `GIT_SOURCE_NOT_HEAD` | ✔ |
| 6 | 本地 Commit SHA 精确校验 | `GIT_EXPECTED_LOCAL_SHA_MISMATCH` | ✔ |
| 7 | 推送前先 fetch，读取远端当前 SHA | — | ✔ |
| 8 | 预期远端 SHA 校验 | `GIT_REMOTE_CHANGED` | ✔ |
| 9 | 快进关系校验（`merge-base --is-ancestor`） | `GIT_PUSH_NON_FAST_FORWARD` | ✔ |
| 10 | 原子 expected-remote compare-and-swap 推送 | `GIT_PUSH_REJECTED` | ✔ |
| 11 | 推送后再次 fetch 复核远端 SHA 且包含本地提交 | `GIT_PUSH_VERIFY_FAILED` | ✔ |

### D4. 明确拒绝的输入

- **Force / Force-with-lease**：`git_push` 入参为 `z.strictObject`，无任何 force 字段；实测附加 `force: true` 返回 `MCP error -32602 … Unrecognized key: "force"`。
  实现内部使用 `--force-with-lease=refs/heads/<dest>:<expectedRemoteSha>` 仅作为**原子 compare-and-swap**；由于第 9 步已证明 `expectedRemoteSha` 是本地提交的祖先，该操作语义上必然是快进推送，且远端必须仍精确停在预期 SHA。调用方**无法**传入或关闭该行为（`verifyAncestor: false` 亦被显式拒绝）。
- **删除分支**：无法表达（`destinationBranch` 必须通过 `git check-ref-format --branch` 与安全正字法；`:branch`、`+branch`、`--delete`、`-f`、`a:b` 全部 `GIT_DESTINATION_BRANCH_INVALID`）。
- **推送全部分支 / Tags / 任意 RefSpec**：命令固定为 `<localSha>:refs/heads/<whitelistedBranch>`，`remote.mirror` 被强制关闭，`--no-verify` 禁用本地 hook，`--no-tags` 式固定目标无法承载 tags。
- **非快进**：`GIT_PUSH_NON_FAST_FORWARD`。
- **远端 SHA 不符预期**：`GIT_REMOTE_CHANGED`。
- **非白名单项目 / 未授权 remote / 未授权 main**：见 D3。
- **`HEAD:任意分支` 绕过**：`sourceRef` 经过安全正字法（拒绝 `:`、`+`、`..`、`@{`、`.lock` 等）后必须 `rev-parse` 为提交且等于当前 HEAD SHA。

### D5. 与"独立 Git Push 任务"方案的差别

未采用替代方案。理由：DevSpace 具备合适的新增/暴露 MCP 操作架构，`git_push` 已有成熟实现与参数验证；独立任务方案需要额外授权一份 `.devspace/tasks.yaml`（且该文件位于被推送仓库内、会被 manifest SHA 失效机制反复打断），并会失去 `strictObject` 级别的入参约束。因此本轮选择**严格参数验证的 MCP Git Push 操作**，未引入任何 Shell 绕过通道。

---

## E. Godot Import 执行入口

### E1. 选择：MCP 能力 `godot_import`（不是命名任务）

按要求二选一、避免功能重复，本轮实现 **`godot_import` MCP 工具**，未新增 `godot-import` 任务，两处不重叠。

### E2. 配置

```json
"godotImport": {
  "enabled": true,
  "approvedProjectRoots": ["/Users/liz/agy/TriaRegna"],
  "defaultTimeoutSeconds": 1800,
  "maxTimeoutSeconds": 7200
}
```

启动时强校验：`approvedProjectRoots` 必须位于 `allowedRoots` 之内；`enabled=true` 时至少一个授权项目根；`defaultTimeoutSeconds ≤ maxTimeoutSeconds`。策略另有硬编码（不可由调用方关闭）：`runner = "godot-mono"`、`argumentPolicy = "godot_editor_import_v1"`、`requireTrackedFilesUnchanged = true`、`requireCleanCheckout = true`。

### E3. 输入 schema（无可拼接参数）

```
godot_import { workspaceId, timeoutSeconds?, waitSeconds?, jobId?, projectMemoryReceiptId? }
```

**没有** executable / path / args / command / shell / scene / env 任何字段。项目根**固定等于 workspace root**，因此不存在调用方可控路径、路径穿越或符号链接逃逸面。

### E4. 固定执行向量

```
/Applications/Godot_mono.app/Contents/MacOS/Godot \
  --headless --editor --import --path . --quit
```

- 可执行文件由 `RunnerRegistry` 解析（配置 `runners.godot-mono.executable` 或既定候选路径），调用方无法指定。
- 参数由 `src/runner-validation.ts::validateGodotEditorImportArguments` 做**逐元素全等**校验（长度 + 每个位置的字节相同）；任何增删改序均 `RUNNER_ARGUMENT_REJECTED`。
- `--headless` 覆盖显示/音频驱动（Godot 4 无头模式等价于 dummy 显示驱动），因此不需要额外渲染器参数；这与项目 `AGENTS.md` 要求"普通无头测试需 `--rendering-method gl_compatibility`"并不冲突——那条要求针对**运行游戏/测试场景**（`start_job` 路径），而 editor import 不渲染、不加载游戏场景。
- 生产实测进程命令行：`Godot --headless --editor --import --path . --quit`（`ps` 抓取确认）。

### E5. 与 `start_job` 的边界（原策略未被放松）

- `start_job` 走 `godot_headless_v1`：**必须含 `--headless`、必须不含 `--editor`**，实测 `validateRunnerArguments("godot-mono", ["--headless","--editor","--import","--path",".","--quit"])` 仍抛 `RUNNER_ARGUMENT_REJECTED`。
- 仅 `godot_import` 内部通过 `StartJobInput.godotEditorImport === true` 这个**闭合内部开关**切换到 editor-import 策略；`start_job` 的 handler 从不转发该字段，MCP schema 也不包含它（外部传入会被 zod 丢弃/拒绝）。

### E6. 返回内容

`godot_import` 返回：真实退出码（`exitCode` / `signal`）、Job 状态、超时值、Godot 引擎版本、项目路径、固定参数与策略名、**ERROR / 导入失败 / SCRIPT ERROR 三类普查计数 + 样本行**（上限 40 行/类，自动剥离 ANSI）、导入前后 Git 状态对比（HEAD / 分支 / tracked 文件是否变化）、`newUntrackedPaths` 与 `generatedOutsideImportCache`、以及异常码 `GODOT_IMPORT_MODIFIED_TRACKED_FILES` / `GODOT_IMPORT_CHANGED_GIT_REFERENCES`。

查看完整日志：`wait_job` / `poll_job`（jobId 与 `start_job` 完全一致的后台 Job 生命周期）。中断后可 `godot_import { jobId }` 重新取回有界报告。

---

## F. 并发、路径与凭证安全

### F1. 并发

- **同项目重复导入**：`GodotImportRegistry` 以项目根 realpath 的 sha256 为键持有互斥锁；重复调用返回 `GODOT_IMPORT_ALREADY_RUNNING` 并给出在飞 jobId。锁在 Job 进入终态时释放（`sweep`/`release`）。
- **Job 层并发**：沿用 `MAX_CONCURRENT_JOBS = 2` 与每 runner 的 `maxConcurrent`。
- **Git 层并发**：所有远端写操作经公共 Git 目录级 mutation lock 串行。

### F2. 路径

- 项目根 = workspace root，无调用方路径入参。
- `project.godot` 必须是 workspace root 下的**普通文件**，且 `realpathSync` 后仍位于 root 之内（`GODOT_PROJECT_ESCAPE`）。
- 工作目录固定为项目根；Job 参数校验仍执行 `assertWorkspaceContainedArguments`（拒绝 `..`、绝对路径、`~`、盘符）。
- **执行前信任判定**：托管 worktree 可直接运行；**非托管 checkout 必须完全 clean**，否则 `GODOT_IMPORT_WORKSPACE_NOT_TRUSTED`。实测对 `/Users/liz/agy/TriaRegna` 原始脏工作区（unstaged 207 / untracked 917）成功拒绝，**从未在该目录运行任何 Godot 进程**。
- 授权项目：`workspace.sourceRoot ?? workspace.root` 必须精确命中 `godotImport.approvedProjectRoots`，否则 `GODOT_PROJECT_NOT_APPROVED`。未授权路径、未授权项目一律拒绝。

### F3. 凭证安全

| 要求 | 落实情况 |
|---|---|
| 复用现有 CNB Git 凭证 | 使用宿主 `git` 与既有配置；`~/.gitconfig` 中 `credential.helper = osxkeychain`（macOS Keychain），DevSpace 未读取、未存储、未复制任何 token |
| 不在源码写 Token | 未写入任何 token / 密码 |
| 不在配置明文存储密码 | `/Users/liz/.devspace/config.json` 仅含仓库 URL 白名单，无凭证 |
| 不输出 Authorization Header | 所有验证脚本只使用内存中的 bearer token，日志中未打印；OAuth 交换结果只取 `access_token` 字段，不做回显 |
| 不把 Token 传给 ChatGPT | 未改动 OAuth 流程；`git_*` 与 `godot_import` 均不接收、不返回凭证 |
| 诊断报告不记录凭证 | 本报告与所有证据文件均不含 token；`/Users/liz/.devspace/auth.json` 全程只被读取，未打印 |
| OAuth/Cloudflare 认证不被绕过 | 所有新能力都在既有 `requireBearerAuth` 之后；未改动 `src/oauth-provider.ts` |
| 日志泄露防护 | `devspace_info` 描述与实现均声明不返回凭证/环境变量 |

### F4. Godot Editor 的本地代码执行风险（按受信任任务对待）

Godot Editor 导入会加载项目、执行编辑器插件与导入器，具备本地代码执行能力。因此：

- 仅允许**已授权项目根**且必须是**托管 worktree 或 clean checkout**；
- 不下载任何插件/资源（导入不触网，`networkPolicy` 未放宽；`godot`/`godot-mono` 保持 `inherited`，本轮未赋权网络访问）；
- 生成物被显式统计与回报：`newUntrackedPaths` 与 `generatedOutsideImportCache`；
- **不修改跟踪源码**：导入前后对 staged/unstaged/HEAD/branch 做逐字段比对；一旦 tracked 文件被改，返回 `GODOT_IMPORT_MODIFIED_TRACKED_FILES` 异常并声明"停止后续自动操作、不自动回滚"；
- Git 引用（HEAD / 分支）变化同样报 `GODOT_IMPORT_CHANGED_GIT_REFERENCES`；
- 本轮实测：**0 个 tracked 文件被修改**；但导入在 `.godot/` 之外生成了 **185 个新的未跟踪 `.uid` 边车文件**（Godot 4.4+ 标准输出，见 G 段与 J 段的运维提示）。

---

## G. 正反向测试结果

### G0. 自动化测试（源码级）

`npm run test:unit`（含新增用例）：**全部通过**，`FAIL` / `AssertionError` 计数 0。

重点套件：

| 套件 | 结果 |
|---|---|
| `src/git-remote-tools.test.ts` | 13/13（含真实快进推送并复核远端 SHA） |
| `src/git-push-policy.test.ts`（**新增**） | 6/6 |
| `src/godot-import.test.ts`（**新增**） | 通过 |
| `src/git-remote-merge.test.ts` | 16/16 |
| `src/git-tools.test.ts`、`src/runner-registry.test.ts`、`src/background-jobs*.test.ts`、`src/tool-test-coverage.test.ts`（61 tools） | 通过 |

新增 `git-push-policy.test.ts` 覆盖：refspec/force/删除/tag 形态、`sourceRef ≠ HEAD`、未授权远端、未授权目标分支、精确 URL 绑定不符、仓库本地敌意配置（7 类）、**fetch 默认不 prune**、以及配置层 fail-closed（缺 `approvedRemoteUrls`/分支/仓库根、`allowForce=true`、`requireFastForward=false`、仓库根越界 → 全部抛错）。

### G1. G1–G9 实测（生产服务 + 隔离环境）

生产服务实测（Cloudflare 公网端点同源，OAuth 走真实 owner token 流程）：

| Gate | 检查项 | 结果 |
|---|---|---|
| G1 | 授权 CNB fetch 成功 | ✔ `Fetched origin (prune=false)` |
| G1 | 重新查询远端 main/功能分支并显示 SHA | ✔ `main=21af029092036c3b7f2bca24ce87d34a42721579`、`p0=588a43be…`、`p1=d4a43e84…`（**本轮重新查询所得，未沿用旧记录**） |
| G1 | fetch 不改 HEAD/分支/索引/工作区 | ✔ 全字段一致 |
| G1 | 脏工作区 fetch 后逐字节不变 | ✔ unstaged 1 / untracked 1，内容哈希不变 |
| G2 | 未授权 remote 被拒绝 | ✔ `GIT_REMOTE_NOT_APPROVED` |
| G2 | 远端 URL / 注入被拒绝 | ✔ `GIT_REMOTE_INVALID` |
| G2 | 未授权**仓库**被拒绝 | ✔ `GIT_REPOSITORY_NOT_APPROVED`（在 `/Users/liz/agy/TriaRegna-integration` 上实测，无任何远端 I/O） |
| G4 | main 未授权推送被拒绝 | ✔ `GIT_DESTINATION_BRANCH_NOT_APPROVED` |
| G4 | force / refspec 字段 | ✔ `MCP error -32602 … Unrecognized keys: "force", "refspec"` |
| G4 | 强制/删除形态 | ✔ `GIT_DESTINATION_BRANCH_INVALID` |
| G4 | 未授权 remote 推送 | ✔ `GIT_REMOTE_INVALID` |
| G4 | 未授权仓库推送 | ✔ `GIT_MANAGED_WORKTREE_REQUIRED` |
| G4 | 上述全部拒绝均未触碰远端 | ✔ |

**实测汇总：生产端点 24/24 通过；隔离本地远端 17/17 通过；Godot 23/23 通过。**

**MCP 级 Git Push 真实推送验证（隔离本地 bare 远端，`http://127.0.0.1:7699`，临时配置/状态/worktree 根均在 `/tmp/devspace-push-verify`，与生产实例完全隔离）**：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 合法普通快进推送 | ✔ 远端 `refs/heads/feature-ok` 从 `0275ac40…` → `d7ba8b4c…`，与本地提交 SHA **完全一致**，报告 `remoteContainsLocal=true` |
| 2 | 远端 SHA 不匹配 | ✔ `GIT_REMOTE_CHANGED` |
| 3 | 本地 SHA 不匹配 | ✔ `GIT_EXPECTED_LOCAL_SHA_MISMATCH` |
| 4 | 非快进 | ✔ `GIT_PUSH_NON_FAST_FORWARD`，远端停留在独立推进后的提交 |
| 5 | Force 字段 | ✔ schema 层拒绝 |
| 6 | 分支删除形态 `:feature-ok` | ✔ `GIT_DESTINATION_BRANCH_INVALID` |
| 7 | 未授权 remote | ✔ 拒绝 |
| 8 | 未授权仓库 | ✔ 拒绝 |
| 9 | main 未授权 | ✔ `GIT_DESTINATION_BRANCH_NOT_APPROVED` |
| 10 | 脏工作区 | ✔ `GIT_WORKSPACE_NOT_CLEAN` |
| 11 | `main` 全程未被触碰 | ✔ `refs/heads/main` 保持 `0275ac40…` |

> **正式 CNB 全程只做只读权限与身份检查**（`git ls-remote` 读取分支/身份 + 通过 DevSpace `git_fetch` 拉取远端跟踪引用），**未执行任何真实 Push**。

### G2. Godot 导入实测（隔离托管 worktree）

环境：`/Users/liz/.devspace/worktrees/TriaRegna-a9c26d21`（DevSpace 托管 worktree，sourceRoot `/Users/liz/agy/TriaRegna`，HEAD `588a43befa9a20d2d7d68fdee81986a40e649ecf`，初始完全 clean、无 `.godot`）。
**原始 `/Users/liz/agy/TriaRegna` 未被运行任何 Godot 进程，未被修改。**

| 步骤 | 结果 |
|---|---|
| 1. 导入前 Git 状态 | clean=true，staged=0/unstaged=0/untracked=0，`.godot` 文件数 0 |
| 2. 导入前定向运行验收场景（缺缓存） | 报 `ERROR: Cannot instantiate C# script … res://src/Testing/CoreTestRunner.cs`（缺 `--import` 产物 + 未构建 .NET 程序集），运行卡住 → 记录后取消；**这就是"导入前因缺少资源缓存出现的错误"** |
| 3. 恢复冷状态 | 清理 `.uid` 与 `.godot`/`obj`/`bin`，untracked 回到 0 |
| 4. Godot 首次资源导入 | **成功，exit 0**（job `job_4dadd2b8-2d1c-42cf-8f1f-ef174fc46d4c`，耗时 75.2 s）；引擎 `4.7.1.stable.mono.official.a13da4feb`；Godot ERROR 行 **0**；导入失败 **0**；SCRIPT ERROR **0** |
| 5. 导入产物 | `.godot/` 2208 个文件 / 885,218,446 B（约 845 MiB）；另有 **185 个新的未跟踪 `.uid` 边车文件**（均在 `.godot/` 之外） |
| 6. `dotnet build` | **成功，exit 0**（`dotnet build TriaRegna.csproj`，在 launchd 最小 PATH 下经本轮新增的 .NET 运行时注入正常工作） |
| 7. 定向 Godot 验收场景（导入后） | **成功，exit 0**，输出 `TRIA_REGNA_CORE_TESTS_PASS`（hex 往返 / 地图加载与边缘掩码 / KayKit 道路河流海岸绑定 / 寻路与移动代价 / 地图创作与规范化导出 / 指令-占领-确定性 AI / 存读档），测试场景 `res://tests/CoreTestRunner.tscn --rendering-method gl_compatibility` |
| 8. 前后错误对比 | 导入前 ERROR=1 → 导入后 ERROR=0、导入失败=0 → **缺缓存错误不再出现** |
| 9. 导入后 Git 状态 | HEAD/分支不变；**tracked 文件 0 改动**；untracked 185（全部为新增、无 tracked 编辑） |
| 10. 重复导入（幂等/缓存复用） | **成功，exit 0**，耗时 **2.94 s**（首次 75.2 s），`newUntrackedPaths=0`，ERROR=0 |
| 11. 同项目并发导入 | 第二次并发调用被拒绝：`GODOT_IMPORT_ALREADY_RUNNING` |
| 12. 未授权项目 | `GODOT_PROJECT_NOT_APPROVED` |
| 13. 原始脏 checkout | `GODOT_IMPORT_WORKSPACE_NOT_TRUSTED`（unstaged 207 / untracked 917）——**在该目录未启动任何 Godot 进程** |
| 14. 未知 jobId 报告 | `GODOT_IMPORT_JOB_UNKNOWN` |

### G3. 需要登记的重要发现（影响 P2 集成操作）

1. **首次导入会在 `.godot/` 之外生成 185 个未跟踪 `.uid` 文件**（Godot 4.4+ 对脚本/着色器/场景的标准行为）。
   - 它们**不是** tracked 文件改动（G8 通过），但会**让工作区变为 dirty**。
   - 后果：导入后若不处理，`git_push` 会以 `GIT_WORKSPACE_NOT_CLEAN` 拒绝（本轮已实测到这一真实行为）。
   - P2 操作建议：在推送前显式决定 —— 要么把这些 `.uid` 纳入提交（仓库根已有 2 个 tracked `.uid`，说明这是项目既定方向），要么由项目在 `.gitignore` 中忽略 `*.uid`。**DevSpace 不会自动提交、也不会自动清理它们。**
2. 首次导入前运行游戏/测试场景（无缓存）会长时间挂起而非快速失败，建议 P2 流程**先导入再跑场景**，并给 `start_job` 设置合理超时。
3. 新建托管 worktree 的分支名随机（`devspace/integration/<repo>-<worktree>-<hex>`），**不在推送白名单内**；如需推送，必须先把它显式加入 `approvedDestinationBranches` 并重启服务。

---

## H. 服务重载及 Schema Fingerprint

### H1. 重载方式（沿用原有运维方式，未重建工作区）

```sh
launchctl kickstart -k "gui/$(id -u)/com.liz.devspace"
```

- **未**更换 Cloudflare 公网地址：`https://mcp.workspaceport.com` / `/mcp` 原样保留，cloudflared 隧道进程未重启、LaunchAgent 未改动。
- **未**改动 OAuth 配置、未更换 owner token、未删除任何 session/证据（MCP session 统计与 `~/.devspace` 数据保持）。
- **未**重建 DevSpace 工作区；**未**终止无关 Agent 进程。
- 重载前先验证构建成功（`npm run build`：vite + `tsc -p tsconfig.build.json` 均通过）与 `dist/server.js` 可加载。

### H2. 升级前后指纹对比（实测）

| 项 | 升级前 | 升级后（最终） |
|---|---|---|
| `version` | 1.1.0 | 1.1.0 |
| `bootId`（升级前最后） | `686a2e65-409e-412d-95a8-84bf731b6020` | `8bb74979-8993-4ac5-91ab-3ca6fa96e5da` |
| `tools`（模型可见） | 58 | **60** |
| `tools/list` 已注册 | 59 | **61**（含 App-only `report_workspace_app_error`） |
| `schemaFingerprint` | `832e08158a68e71868d10817c70178587f48e3d016e607c98437885641da2379` | `a50881666bb7837fb37c4617ad660f9700c4ba40a9844ab0bed9f0953061c455` |
| `schemaRevision` | `…-task-wait-resume-p0.1-v1.2026-07-29` | `…-task-wait-resume-p0.1-cnb-git-remote-godot-import-v1.2026-10-10` |

新增工具：`git_push`、`godot_import`。

### H3. `devspace_info` 重载后自述（实测节选）

```
DevSpace 1.1.0
Boot ID: 8bb74979-8993-4ac5-91ab-3ca6fa96e5da
Schema: …-cnb-git-remote-godot-import-v1.2026-10-10 (a50881666bb7837fb37c4617ad660f9700c4ba40a9844ab0bed9f0953061c455)
Tools (60): … git_fetch, git_merge, git_push, … godot_import, … start_job, …
Git remote write: enabled=true, remotes=origin, branches=feat/wego-p0-gui-performance, fix/wego-p1-locale-native-crash, devspace/integration/TriaRegna-TriaRegna-b58942f7, force=false
Godot import: enabled=true, runner=godot-mono, policy=godot_editor_import_v1, args=[--headless --editor --import --path . --quit], projects=/Users/liz/agy/TriaRegna, timeout=1800/7200s
Runners: … dotnet=available (10.0.302), godot-mono=available (4.7.1.stable.mono.official.a13da4feb), …
```

对应结构化字段：`gitRemoteWrite { enabled:true, allowForce:false, requireCleanWorkspace:true, requireExpectedRemoteSha:true, requireFastForward:true }`、`godotImport { fixedArgs, argumentPolicy, approvedProjectRoots, requireTrackedFilesUnchanged:true, requireCleanCheckout:true }`。

### H4. G10 — ChatGPT MCP 客户端发现情况

- **服务端已验证**：通过公网端点 `https://mcp.workspaceport.com/mcp` 完成真实 OAuth 授权码流程后，`tools/list` 返回含 `git_push` 与 `godot_import` 的完整目录；`devspace_info` 的 `tools` 与 `schemaFingerprint` 与本地 `/healthz` 完全一致。
- **客户端未验证**：本机 Agent 无法访问用户 ChatGPT 账号的插件/连接器设置，**不能**确认用户 ChatGPT 侧已经拉取新 schema。
- 结论：**CLIENT RECONNECT PENDING** —— 请在 ChatGPT 的 DevSpace 连接器中执行重新连接/刷新（Reconnect / Refresh），使其重新拉取 61 个工具；若客户端仍显示旧目录，属于客户端 schema 缓存，**不得**据此认为服务端未生效。

---

## I. 修改文件完整清单

### I1. DevSpace 源码（`/Users/liz/Documents/Codex/2026-07-21/wo-de/work/devspace`）

修改（15）：

| 文件 | 变更 |
|---|---|
| `src/config.ts` | 新增 `GodotImportPolicy`、`GODOT_IMPORT_*` 常量、`parseGodotImportPolicy`，接入 `loadConfig` |
| `src/user-config.ts` | `DevspaceUserConfig` 新增 `godotImport` |
| `src/git-remote.ts` | 仓库本地 Git 配置黑名单小写化+扩充（`UNSAFE_LOCAL_GIT_CONFIG_PATTERN`）；fetch 默认 `prune=false` |
| `src/runner-validation.ts` | 新增 `GODOT_EDITOR_IMPORT_ARGS` / `validateGodotEditorImportArguments` / `dotnetRootCandidates` / `withDotnetRuntime`（原 Godot 策略未改动） |
| `src/runner-registry.ts` | `godot`/`godot-mono` resolve 时注入 .NET SDK 环境 |
| `src/background-jobs-types.ts` | `StartJobInput` 新增闭合内部字段 `godotEditorImport?: true` |
| `src/background-jobs.ts` | 依据该字段走 editor-import 参数策略；新增有界 `readLogFromStart()` |
| `src/godot-import.ts` | **新增**：策略解析、项目/信任校验、并发注册表、导入执行与有界报告、错误普查 |
| `src/server/tools-godot.ts` | **新增**：`godot_import` MCP 工具注册 |
| `src/server.ts` | 实例化 `GodotImportRegistry`、注册 `godot_import`、注入 `ServerContext` |
| `src/server/server-types.ts` | `ServerContext.godotImport`；`TOOL_SCHEMA_REVISION` 升级 |
| `src/server/server-helpers.ts` | `exposedToolNames` 加入条件化 `git_push`/`godot_import`；`requiredCapabilityForTool`；`godotImportSummary`；指纹纳入 `godotImport` |
| `src/server/tools-info.ts` | `devspace_info` 新增 `godotImport` 结构化字段与文本行；修正过期的 connector sync 提示 |
| `src/ui/card-types.ts` | `TOOL_NAMES` 新增 `godot_import` |
| `src/tool-test-coverage.ts` | 覆盖清单新增 `godot_import` 与 `git-push-policy.test.ts` |
| `src/doctor.test.ts` | 同步 `TOOL_SCHEMA_REVISION` 字面量 |
| `package.json` | `test:unit` 纳入两个新测试文件 |

新增测试（2）：`src/godot-import.test.ts`、`src/git-push-policy.test.ts`。

（`git diff --stat`：15 个修改文件，+308 / −26；新增 4 个源文件。）

### I2. 运行配置

| 文件 | 变更 |
|---|---|
| `/Users/liz/.devspace/config.json` | 新增 `gitRemoteWrite`（origin + CNB 精确 URL 绑定、3 条目标分支白名单、仓库根授权）与 `godotImport`（启用、授权项目根、超时） |
| `/Users/liz/.devspace/backups/config.json.pre-cnb-godot-upgrade-20261010T124452` | **升级前配置备份** |

### I3. 未改动 / 未触碰

- `/Users/liz/agy/TriaRegna`（原始 dirty 工作区）：**只读访问**（`git status`/`git rev-parse`/`git remote -v`/`git ls-remote`、`git worktree list`、DevSpace `open_workspace` 注册会话，`godot_import` 在该目录被 `GODOT_IMPORT_WORKSPACE_NOT_TRUSTED` 拒绝）；**未修改、未覆盖、未重置、未清理任何未提交文件**，**未在其中运行任何 Godot / dotnet / 构建进程**。
  - 该目录 HEAD 仍为 `21af029092036c3b7f2bca24ce87d34a42721579`，当前分支仍为 `feat/simultaneous-command-m0-m2`（与本轮开始时一致）。
  - **说明（并发活动观测）**：本轮会话期间该目录的 `git status` 条目数从 356 变为 365，且 12:15 之后有 216 个文件被写入（集中在 `tools/**`、`PROJECT_TRACKER.md` 等）。这些都是**其他并发 Agent 的持续作业**（DevSpace 日志中可见另一个 workspace `ws_338a5764` 正在此目录工作），与本轮改动无关：本轮在该路径下**没有任何写操作**，`.git/index` 的 mtime 仍为 2026-10-07 21:08。
  - 该目录既有的 `.godot/` 与 102 个未跟踪 `.uid` 文件 mtime 为 2026-09-23 ~ 2026-10-05，**早于本轮会话**，属于项目此前运行 Godot 的遗留状态。
  - DevSpace 源码中 `.devspace/tasks.yaml` 仅有读取路径（`task-manifest.ts` / `task-runner.ts`），**不存在写入路径**；该文件的写入者不是本轮操作。
- `/Users/liz/.devspace/worktrees/TriaRegna-b58942f7`（**P2 隔离集成 worktree，未触碰**）：HEAD 仍为 `588a43befa9a20d2d7d68fdee81986a40e649ecf`，状态 clean，未运行 fetch/import/build。
- 其他 Agent 的 worktree、M6 Frozen、P0/P1 远端验证仓库与证据、现有开发分支：均未删除、未改动。
- Cloudflare Tunnel / OAuth provider / owner token：未改动。

### I4. 本轮产生的临时/新增工件（供运维知悉，非交付物）

- 验证用托管 worktree：`/Users/liz/.devspace/worktrees/TriaRegna-a9c26d21`（`ws_7ab608ac-…`，已导入 `.godot/` 与 185 个 `.uid`）与 `/Users/liz/.devspace/worktrees/TriaRegna-6a8a9ecc`（`ws_4f89f651-…`，保持 clean）。
- 隔离推送验证目录：`/tmp/devspace-push-verify`（本地 bare 远端 + 临时实例配置/状态，**不指向 CNB**）。
- 验证脚本与证据：`/tmp/devspace-verify/`（`battery.mjs`、`phase4.mjs`、`push-verify.mjs`、`battery-part1.json`、`battery-part2.json`、`phase4.log`、`unit-final.log`）。

---

## J. 回滚方法

### J1. 快速回滚（仅回收权限，保留代码）

1. 编辑 `/Users/liz/.devspace/config.json`：
   - 把 `gitRemoteWrite.enabled` 改为 `false` → `git_fetch` 恢复 `GIT_REMOTE_POLICY_DISABLED`，`git_push` 不再注册；
   - 把 `godotImport.enabled` 改为 `false` → `godot_import` 不再注册。
2. `launchctl kickstart -k "gui/$(id -u)/com.liz.devspace"`
3. 用 `devspace_info` 确认 `tools` 数量与 `schemaFingerprint` 变化。

或直接恢复备份：

```sh
cp /Users/liz/.devspace/backups/config.json.pre-cnb-godot-upgrade-20261010T124452 \
   /Users/liz/.devspace/config.json
launchctl kickstart -k "gui/$(id -u)/com.liz.devspace"
```

### J2. 完整代码回滚

```sh
cd /Users/liz/Documents/Codex/2026-07-21/wo-de/work/devspace
git stash push -u -- src package.json        # 或逐文件 git checkout --
npm run build
launchctl kickstart -k "gui/$(id -u)/com.liz.devspace"
```

新增文件（`src/godot-import.ts`、`src/server/tools-godot.ts`、`src/godot-import.test.ts`、`src/git-push-policy.test.ts`）可单独删除；删除后必须重建。

### J3. 单点回退（最小粒度）

| 想回收的能力 | 操作 |
|---|---|
| 只回收 `main` 推送授权（未来若临时开启） | 从 `approvedDestinationBranches` 删除 `"main"` 并重启 |
| 只回收某个远端/仓库 | 从 `approvedRemotes` / `approvedRemoteUrls` / `approvedRepositoryRoots` 删除对应项并重启 |
| 只回收 Godot 导入 | `godotImport.enabled=false` 并重启（不影响 Git 能力） |
| 只收紧超时 | 调小 `godotImport.maxTimeoutSeconds` / `defaultTimeoutSeconds` 并重启 |

### J4. 回滚注意

- 回滚**不会**删除任何 Git 对象、分支、worktree、Job 日志或证据文件。
- 回滚后 `.godot/` 缓存与 `.uid` 文件仍留在相关 worktree 中（它们只是 gitignored / untracked 产物）；如需彻底还原某个验证 worktree，可删除该 worktree 目录，但**不要**对 `/Users/liz/agy/TriaRegna` 执行任何清理操作。

---

## K. 后续 P2 可使用的准确操作入口

### K1. 打开/恢复 P2 集成工作区

- 打开**既有** P2 隔离 worktree（推荐，避免新建随机分支）：
  `list_workspaces` → 找到 root 为 `/Users/liz/.devspace/worktrees/TriaRegna-b58942f7` 的条目 → `resume_workspace { workspaceId }`
- 新建托管 worktree：
  `open_workspace { path: "/Users/liz/agy/TriaRegna", mode: "worktree", baseRef: "<sha|branch>" }`
  ⚠️ 新建 worktree 的分支名随机，**不在推送白名单**；若要推送需先把它加入 `approvedDestinationBranches` 并重启服务。

### K2. 读取远端最新状态（不写工作区）

```
git_fetch { workspaceId, remote: "origin" }          // 默认 prune=false；如确需清理远端跟踪引用再传 prune:true
```
返回 `fetch.refsAfter`（含 `refs/remotes/origin/main` 与各功能分支的最新 SHA）、`updatedRefs` / `createdRefs` / `deletedRefs`。
配合 `git_status { workspaceId }` 确认 HEAD/分支/clean。

### K3. 首次资源导入（在授权 Godot 项目根）

```
godot_import { workspaceId, timeoutSeconds: 1800, waitSeconds: 300 }
```
- 固定执行 `Godot --headless --editor --import --path . --quit`；
- 若 300 s 内未结束，返回 `running` + `jobId`，随后用
  `wait_job { workspaceId, jobId, waitSeconds: 30 }` 轮询，
  或 `poll_job { workspaceId, jobId }` 分页读日志；
- 结束后取有界报告：`godot_import { workspaceId, jobId }`（退出码、ERROR/导入失败普查、tracked 文件与 Git 引用对比、`generatedOutsideImportCache`）。
- **注意**：非托管 checkout 必须 clean；Godot 项目根必须已列入 `godotImport.approvedProjectRoots`。

### K4. 编译与定向验收

```
start_job { workspaceId, runner: "dotnet",     args: ["build", "TriaRegna.csproj"], timeoutSeconds: 900 }
start_job { workspaceId, runner: "godot-mono",
            args: ["--headless","--path",".","--scene","res://tests/CoreTestRunner.tscn",
                   "--rendering-method","gl_compatibility"],
            timeoutSeconds: 900 }
wait_job  { workspaceId, jobId, waitSeconds: 30 }
```
（`start_job` 仍拒绝 `--editor`；只有 `godot_import` 能进入编辑器导入。）

### K5. 推送（本轮未执行，未来 P2 使用）

```
# 1) 先确认远端当前 SHA
git_fetch { workspaceId, remote: "origin" }
#    记下 fetch.refsAfter["refs/remotes/origin/<branch>"] 作为 expectedRemoteSha
# 2) 确认本地 HEAD 与 clean
git_status { workspaceId }
# 3) 推送（目标分支必须已列入 approvedDestinationBranches）
git_push {
  workspaceId,
  remote: "origin",
  destinationBranch: "feat/wego-p0-gui-performance",
  expectedLocalSha:  "<40/64 位本地提交 SHA>",
  expectedRemoteSha: "<40/64 位远端当前 SHA>"
}
```

推送前必须满足：工作区 clean（含 untracked；**首次 Godot 导入产生的 `.uid` 必须先提交或忽略**）、attached 分支、托管 worktree、目标分支在白名单、`expectedLocalSha === HEAD`、`expectedRemoteSha` 为本地提交祖先。
推送后工具会再次 fetch 复核，返回 `remoteShaBefore → remoteShaAfter` 与 `remoteContainsLocal`。

**向 `main` 推送**：需要另一次明确授权 —— 在 `approvedDestinationBranches` 中显式加入 `"main"`，重启服务，并在推送后立即撤回该授权。

### K6. 诊断入口

```
devspace_info                      // 版本、bootId、schemaRevision、schemaFingerprint、tools、gitRemoteWrite、godotImport、runner 可用性
query_operation { operationId }    // 变更类操作的中断恢复
list_workspaces / resume_workspace // 会话恢复
list_jobs / wait_job / poll_job / cancel_job
```

---

## 验收结论

| Gate | 要求 | 结果 |
|---|---|---|
| G1 | CNB Git Fetch 可通过 DevSpace 执行 | **通过**（真实 CNB fetch，远端 main/P0/P1 SHA 重新查询，脏工作区不变） |
| G2 | 非白名单 remote 被拒绝 | **通过**（未授权 remote / URL / 仓库三类均拒绝） |
| G3 | Git Push 能力真实存在 | **通过**（工具注册 + 策略可见 + 隔离远端一次真实快进推送成功并复核远端 SHA） |
| G4 | Force、删除、非快进及未授权 main 推送均被拒绝 | **通过**（生产 fail-closed 矩阵 + 隔离远端 11 项负向全通过） |
| G5 | Git 操作不泄漏凭证 | **通过**（Keychain/credential helper 复用，无 token 落盘/落日志/返回，敌意仓库本地配置被拒） |
| G6 | Godot 首次 Import 正常运行 | **通过**（exit 0，75.2 s，0 ERROR，`.godot` 2208 文件；重复导入 2.94 s 幂等） |
| G7 | 导入后 Godot 定向测试正常运行 | **通过**（`dotnet build` exit 0；`CoreTestRunner` exit 0 / `TRIA_REGNA_CORE_TESTS_PASS`） |
| G8 | 导入不污染跟踪源码 | **通过**（0 个 tracked 文件改动，HEAD/分支不变；185 个新增 `.uid` 为未跟踪产物并已被显式回报） |
| G9 | DevSpace 重载后能力仍然有效 | **通过**（重载后 bootId `8bb74979…`、60 tools、指纹 `a5088166…`，重跑 24/24 + 23/23 全通过） |
| G10 | ChatGPT MCP 能发现并调用新增能力 | **服务端通过 / 客户端 CLIENT RECONNECT PENDING**（见 H4） |

**未执行**：TriaRegna P2 合并、任何 TriaRegna 分支推送、任何 `main` 修改、对该项目的游戏功能开发。

最终状态：

```
DEVSPACE_CNB_GIT_AND_GODOT_IMPORT_READY
```
