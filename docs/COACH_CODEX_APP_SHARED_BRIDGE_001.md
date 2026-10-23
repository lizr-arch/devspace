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

## 安全限制

固定本机 owner-only Socket，校验权限与 UID，拒绝符号链接；请求/帧/回复大小受限。不接公网 WebSocket，不新增后台监听端口，不修改用户正在打开的 ChatGPT App 或其它会话。不冒充 Codex 运行结果已经通过独立测试。
