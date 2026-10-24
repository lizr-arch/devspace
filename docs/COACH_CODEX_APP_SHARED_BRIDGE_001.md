# DEVSPACE-CODEX-APP-BRIDGE-001 — ChatGPT App 原生 Codex 共享会话

## 目标

一个 DevSpace 工作树对应一条明确绑定的 Codex App 会话。Web GPT 经共享 App Server 发送消息，Codex 在 App 内同一会话连续执行并回复，DevSpace 读取真实结果。不模拟键盘、不清理锁、不修改 Codex 历史数据库。

**本通信桥不取代原 codex_agent_start 的冻结 TASK、不可变证据、测试 Gate 和 Web GPT Review。** App 回复完成不是代码验收 APPROVED。

## 本机实证

2026-10-24：ChatGPT App 26.1016.62342，Codex CLI 0.162.1，共享 Socket 位于用户主目录 .codex/app-server-control/app-server-control.sock。ChatGPT App 使用 ws+unix 共享服务之后，在同一 vscode 来源线程内连续收到 COACH_SHARED_1_ACK、COACH_SHARED_2_ACK；用户打开该会话继续观测时又收到 COACH_OPEN_VIEW_20261024_ACK。所依赖的 App 启动入口为实验性质。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| codex_app_shared_status | 只读共享 Socket 连接检查 |
| codex_app_thread_read | 确认工作树归属并读取受限历史 |
| codex_app_thread_current | 读取该工作树已绑定的线程 ID |
| codex_app_turn_receipt | 读取 PENDING / UNCERTAIN / COMPLETED 状态 |
| codex_app_thread_create | 新建 vscode 非临时线程并绑定当前工作树 |
| codex_app_thread_bind | 显式绑定已存在的线程，不允许悄悄改绑 |
| codex_app_thread_send | 向绑定线程发送单个回合并保存持久防重收据 |

所有调用先做 DevSpace 工作树授权；线程 cwd 必须与 root 的 realpath 精确一致。不同项目、exec 来源和临时线程拒绝。一个工作树只能绑定一条线程，同一线程也不能被其他工作树重复绑定；不同 Web GPT 对话使用不同托管工作树，不能由最近活跃窗口猜测路由。绑定记录采用不可静默替换的持久文件，若必须迁移线程，需经过单独核验和授权，不能盲目删除绑定。

每个工作树下 operationId 防重。重复成功调用只回读原始收据；超时/重启后的 UNCERTAIN 必须先检查 receipt 和历史，不得自动重放。工作区写入回合需要 sandbox=workspace-write 以及真实冻结 TASK；默认仅只读。新桥不能替代现有独立 Review Gate。

## 已知兼容性边界

在当前 Codex 版本下，使用 thread/start 新建的尚未加载线程有时会返回 list_turns is not supported yet 或收不到首轮完成事件；因此新建成功**不等于**可立即自动执行。优先使用用户已在 App 中打开并完成过消息的已加载线程，再进行真实只读验收。收到超时或 UNCERTAIN 时不能重复发送，更不能假定上次没有执行。

## Mac 启动与回滚

先确保私有共享 Codex App Server 已运行。完全退出 ChatGPT App 后，执行：

    node scripts/launch-chatgpt-shared-codex.mjs --check
    node scripts/launch-chatgpt-shared-codex.mjs --launch

脚本检查 App 安装、私有 Socket 和 App 不在运行，再通过 open -a ChatGPT.app --env CODEX_APP_SERVER_WS_URL=ws+unix://...:/rpc 启动。若 App 已打开就拒绝，不会强制退出、重启或抢锁。

**回滚：退出 ChatGPT App，按平时方式打开。** 该环境参数仅当次启动生效，不安装 Login Items、launchctl 环境变量、LaunchAgent 或系统全局配置。后续 App/CLI 版本兼容性须独立验收。

## 发布门槛

1. npm run typecheck 通过。
2. src/coach-app-server-bridge.test.ts：连续两回合、历史回读、工作树隔离、已有 writer 拒绝、断线不重放、并发防重、绑定保护。
3. src/coach-tool-catalog.test.ts：工具目录和只读权限分离。
4. 服务实际发布后，通过 devspace_info 核对新工具；发布前不得声称当前 MCP 已提供它们。
5. 在干净专用工作树用真实共享 Socket 创建、绑定并发送两轮，再从 App 用户视角确认可见。
6. 自动审核 Runner 如需切换到这条通信桥，另行迁移不可变证据、测试和 REWORK 合同，不能因为通信成功就跳过。

## 2026-10-24：桌面侧栏与独占写入锁的真实兼容性限制

在用户 Mac 上观察到运行中的 ChatGPT Desktop 与独立 Codex daemon 并存。daemon 子进程实际持有 thread-writer-locks 下多条会话的内核锁；原共享启动器仅匹配固定 /Applications/.../ChatGPT 进程路径，导致在 Desktop 已启动时误报 appRunning=false。启动器现以 ps 首段可执行文件名 ChatGPT 为准，并在 ps 失败时 fail closed，不再误把同名的 node/codex 进程算作 Desktop。

这**不修复 Codex Desktop 自身的侧栏实时更新或跨后端 writer handoff**。外部 app-server 创建的新线程即使被 thread/list 和 thread/read 枚举，仍可能直到桌面应用重启才显示（OpenAI codex issues #30895 / #36363）；桌面端与守护进程各自加载同一会话可能报 already has an active writer（#37403 等）。

为避免重现：
- 用户需要**在原生 ChatGPT App 内创建新线程**，先验证它在侧栏可见；Web GPT 仅绑定已存在的、明确归属工作树的线程。不要把外部 thread/start 返回成功视为原生 App 创建/自动刷新成功。
- 对正被其它后端占用的线程，只读读取日志、列出持有者。不得删除 ~/.codex/thread-writer-locks 内文件，也不得直接 kill 正在持有 writer 的进程（可能还有开发任务/子进程）。
- 手动恢复时先核实有无进行中的任务，随后通过当前持有者支持的取消、关闭或 idle unload 释放；只有确认可以停止受影响服务时才评估有控制的重启，不能用无条件重启整台 DevSpace。
- CODEX_APP_SERVER_WS_URL 指向共享 daemon 的桌面启动方式仍属实验方案，可能与 codex_app 专用工具冲突（#47425）。用户若要原生 App 稳定性，优先使用正常启动和 App 自己创建的会话，不强制这条启动方式。
- scripts/launch-chatgpt-shared-codex.mjs --check 的 appRunning=true 仅表示发现进程，**不代表当前 App 已连接共享服务**。相反 false 只表示未发现已知可执行名，不构成强制启动的授权。

## 安全恢复结果（2026-10-24，原生 App 优先）

- 事发时 `~/.codex/app-server-daemon/daemon.pid` 记录 PID 33270，真实 writer locks 为 `01a16cef-0e26-7660-99f9-03caac52cfdf` 和 `01a16cf8-9102-7102-8fc9-9b925b1f1a21`。
- 经共享 App Server `thread/loaded/list` 与 `thread/read` 交叉核查，只有这两条线程，均为 `idle`、无 activeFlags；DevSpace 主工作区无运行中的 background validation job。
- 使用官方受支持的 `codex app-server daemon stop` 安全停机，返回 `status:stopped`。此后 `thread-writer-locks/` 只剩 `.coordination.lock`，共享 Socket 不再可用，原线程的 rollout 文件仍分别位于 `~/.codex/sessions/2026/10/24/`；没有删除对话或强杀进程。
- 外部 `thread/start` 不保证 App 正在运行时侧栏即时刷新。DevSpace 的 MCP `codex_app_thread_create` 从本轮起明确拒绝外部创建（`CODEX_APP_NATIVE_THREAD_CREATION_REQUIRED`）。应先在桌面 App 内原生创建，再核对同一 thread ID。
- 在无法证明桌面 App 与共享 daemon 属于同一个 writer 的情况下，`codex_app_thread_send` 同样默认拒绝（`CODEX_APP_SHARED_WRITES_PAUSED_UNTIL_OWNER_VERIFIED`）。这会暂停 Web GPT 向原生 Codex App 自动下发消息，直到可靠的单后端归属机制通过真实桌面重启/恢复验收；不可绕开保护。
- 不改动 Codex 的本地会话、rollout、history、锁文件，不自动启动旧 daemon，也不改用户远程控制设置。GUI 的恢复与列表实时刷新仍须在用户正在运行的 App 中验收；程序侧不能保证上游原生 bug 永不重现。
- 针对性闸门：`src/coach-app-server-mcp.test.ts` 检查两个外部写接口 fail-closed；`src/coach-tool-catalog.test.ts` 确认工具仍有明确可见的禁用说明；启动器检测与 TypeScript 检查通过。

## 2026-10-24：原生 rollout 只读解析与 App 自有 writer 判定

实测的真实 rollout（`~/.codex/sessions/…`）并不使用早期的 `event_msg.user_message` 结构，而是同时写入两类记录：

- `event_msg` + `payload.type = task_started | task_complete`（按 `turn_id` 表示回合生命周期）与 `item_completed`（`item.type = UserMessage | AgentMessage`，正文在 `item.content[]`）。
- `response_item` + `payload.type = message`（`role = developer | user | assistant`）；其中 user 记录还包含客户端生成的 AGENTS.md 指令和 `<environment_context>`，不是人的回合。

`readNativeCodexThread` 因此优先使用 `event_msg` 的 `UserMessage`/`AgentMessage` 作为对话文本（`response_item` 仅作旧格式回退），并过滤合成 user 前缀。`turns` 取已开始的 turn 数；`status = idle` 仅当至少有一个 turn，且每个已开始 turn 都有对应 `task_complete`、最后一条回合记录也是完成；其余（含尾部未完成的 live turn）一律 `unknown`，绝不把不确定状态报成 IDLE。解析前校验首条 `session_meta` 的 `id`/`session_id`、`source === "vscode"`、`cwd` 的 realpath 等于工作树 realpath；文件缺失、损坏、身份不符、锁文件/目录权限异常都 fail closed。仅当 rollout 末尾是未写完的半行（且文件本身未以换行结束）时忽略该半行。

`openNativeCodexThread` 的 owner 判定不再要求锁持有者的父进程必须是 ChatGPT App 主进程（真实 App-owned backend 的父进程是 launchd，PID 46163：`~/.codex/packages/app-server-daemon/releases/…/bin/codex app-server … --managed-daemon`）。现在仅当锁持有者同时满足以下条件才接受为 App 自有 writer：与当前进程同一 uid、二进制位于本机 `$CODEX_HOME/packages/app-server-daemon/releases/<version>/bin/codex`、命令为 `app-server` 且带 `--managed-daemon`、该线程锁文件本身为非符号链接且属主为同一 uid。Codex CLI（`…/CodexCLI.app/…/codex app-server --listen stdio://`）、无 `--managed-daemon` 的 app-server、其它 uid、以及任何出现两个持有者的情形继续以 `CODEX_NATIVE_THREAD_HELD_BY_OTHER_APP` 拒绝。该检查只读锁文件，不获取、不删除、不绕过任何锁；仍需运行中的唯一 ChatGPT App 才发起 `codex://threads/<UUID>` 导航。

真实线程证据（只读，2026-10-24）：线程 A `01a16cef-0e26-7660-99f9-03caac52cfdf`（cwd `devspace-3352a613`，source `vscode`）解析出 3 turns / 3 user / 16 assistant，status `idle`；线程 B `01a16cf8-9102-7102-8fc9-9b925b1f1a21`（cwd `TriaRegna-c3207114`）解析出 3 turns / 3 user / 78 assistant，但最后一个 turn 没有 `task_complete`，status 正确保持 `unknown`。两线程锁持有者均为 PID 46163，判定为 `APP_OWNED`；伪造的 CLI/无托管标记/异 uid writer 均被拒绝。未做 App GUI 端到端验收。
## 安全限制

固定本机 owner-only Socket，校验权限与 UID，拒绝符号链接；请求/帧/回复大小受限。不接公网 WebSocket，不新增后台监听端口，不修改用户正在打开的 ChatGPT App 或其它会话。不冒充 Codex 运行结果已经通过独立测试。
