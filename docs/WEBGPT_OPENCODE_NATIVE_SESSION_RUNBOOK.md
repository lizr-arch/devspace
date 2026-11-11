# Web GPT ↔ DevSpace ↔ OpenCode 原生 Session 操作手册

**状态（2026-11-12）：** 当前 ChatGPT 已通过 DevSpace 的 `opencode_test_session_send` 对固定、可见的 `openai/gpt-6-luna` 原生 Session 完成 3 次请求—回答（含 Luna 主动反问与 Web GPT 继续回答）；逐项 Operation Registry 回执为 `succeeded`。**这不等于本地 Agent 无人触发地主动唤醒 ChatGPT。**

## 新会话首先做什么（冷启动合同）

只要用户提到“Web GPT 与本地 Luna/DSH/OpenCode 双向通信”“直接给原 TUI 发消息”：

1. 优先发现现有 `DevSpaceMac Cloudflare` MCP 工具及本文件；**不要**先要求用户人工转发提示词，也不要先开发新 Agent 或新通信总线。
2. 选择用户明确授权的连接，调用 `devspace_info` 核实实时 Boot ID、所连服务和 allowlist。Boot ID/会话 ID/Cloudflare Quick Tunnel URL 都是**运行时身份，不是永久常量**。不能仅凭工具在模型侧可见就断定实际服务端注册或目标正确。
3. 对**用户指定的精确目录**调用 `open_workspace(mode="checkout")`，获取并复用返回的 `workspaceId`。不要凭历史 workspaceId 盲发；不需要为测试创建 worktree。
4. 先确认**当前**明确授权的 OpenCode Session ID、对应目录、TUI 可见状态，以及 `build / openai / gpt-6-luna / medium`。必须用正在授权的同一 Session；不得按最近会话、模糊匹配或自动恢复其他 Session。
5. 使用 `opencode_test_session_send({workspaceId, sessionId, operationId, text})`；每个新逻辑请求唯一 `operationId`。直接返回的 `userMessageId`、`assistantMessageId`、模型信息和 `COMPLETED` 要记录。
6. 对每轮调用 `query_operation(operationId)`，核对 `status=succeeded`、`sideEffectApplied=true`、同一 Session 的消息 ID；缺少明确回执不得宣布 PASS。最后核对 Git 工作树及实际更改范围。

### 失败时停止与恢复（禁止盲重发）

- 工具不存在：先确认 ChatGPT 挂载的**实际连接**、OAuth 授权及服务端动态工具可用性。生产 `devspace_info` 的 107 工具清单曾未显示本工具，而实际 ChatGPT 工具调用已成功；因此以**运行实例身份、实际调用和回执**判定，不把清单长度单独作为成功/失败证据。
- `spawn opencode ENOENT`：检查**处理 MCP 请求的 DevSpace 进程**实际 PATH/CLI 路径，且 `opencode --version` 可执行。本次已将 `/Users/liz/.local/bin` 纳入启动环境，OpenCode 为 2.2.7。不要修改生产隧道或把全量配置（可能含密钥）输出到工具响应。
- 401 / OAuth 失败：区分 DevSpace Owner OAuth 与 OpenCode 服务鉴权；勿混用认证令牌，勿将生产 Owner 密码复制给隔离环境；只通过本机安全授权界面输入。
- `query_operation` 为 `running`/超时/状态不确定：**不得**换 ID 立即再发同一业务消息。先只读核对原生 Session 消息和 durable 记录，查明实际是否已 POST 后再恢复；现有 `waitForTurn` 以时间而非强 parent linkage 关联助手回复，因此禁止并发使用同一个测试 Session 来冒充精确归属。
- `query_operation=unknown` 也不自动代表未送达。2026-11-12 首次 `spawn opencode ENOENT` 未产生记录；修复 CLI 后使用新 `operationId` 重试，是建立在实际失败发生在 CLI 启动之前的事实基础上。将来必须同样逐案核查。
- 任何错误目录、错误 Session、不明模型、无 TUI 的会话、无凭据隔离或可能涉及其他用户 Session，立即 STOP。

## 2026-11-12 真实通信证据

- 所用开发工作树：`/Users/liz/agy/projects/DEVSPACE-OPENCODE-NATIVE-SESSION-001`（仅该次测试的路径）。
- 测试时 DevSpace Boot ID：`d7a75944-5e66-4062-848f-9d16a76a12fa`，可执行文件 `/Users/liz/.local/bin/opencode`，版本 2.2.7（**历史基线，不是以后硬编码条件**）。
- 测试时固定 Session：`ses_e345c917effegyKUaz2PNDWyYJ`，身份 `build / openai / gpt-6-luna / medium`（**历史证据，不作为未来默认发送目标**）。
- 早先独立 Web GPT 两轮已完成：`webgpt-live-e2e-001-turn1-r2-20261112T0219` / `webgpt-live-e2e-001-turn2-20261112T0220`。
- 新增三轮往返（均由 Web GPT 发起，并从同一个原生 Session 返回）：

| 轮次 | Operation ID | User message | Assistant message | 回执 |
| --- | --- | --- | --- | --- |
| 1 | `webgpt-native-3round-001-turn1-20261112` | `msg_1cbf7ad01001hVQaC8uDvgI5WY` | `msg_1cbf7bc6e001E0BpjBbhnxJv4g` | `succeeded` / `COMPLETED` |
| 2 | `webgpt-native-3round-001-turn2-20261112` | `msg_1cbf83880001mXAssg1vF0k1Wx` | `msg_1cbf846dc001VDviZZurxs5WBP` | `succeeded` / `COMPLETED` |
| 3 | `webgpt-native-3round-001-turn3-20261112` | `msg_1cbf89620001lw7dWe0t6NGPpN` | `msg_1cbf8a2ba001CVzhC7WzUmsYlk` | `succeeded` / `COMPLETED` |

第一轮 Luna 报告真实执行 `pwd` 与 `printf '%s\\n' WEBGPT_3ROUND_C1_6F91`；向 Web GPT 主动提出 runbook/AGENTS 二选一问题。第二轮 Web GPT 明确选择 **详细 runbook + AGENTS 简短入口**；Luna 只读检查 AGENTS 不含原生 Session 入口，并提出 smoke/recovery 二选一问题。第三轮 Web GPT 选择优先 smoke；Luna 正确记得第二轮决定并返回干净的 `git status --short --branch`。三个回执独立经 `query_operation` 核对。`opencode_test_session_send` 返回的 assistant 文本证明有回复，但**仅靠文本不足以独立证明每个 shell 子命令的原生工具轨迹**；必要时再只读比对原生消息与 TUI 实际画面。

该测试**没有修改任何功能源码**；本文件与根 `AGENTS.md` 中的链接是独立文档固化事项，不应混入上述 smoke 的代码变更结论。

## 必须严格区分的三类能力

| 能力 | 当前状态 | 真正的判定 |
| --- | --- | --- |
| Web GPT 主动对指定原生 Luna Session 发消息、收到回复、连续上下文 | **PASS（单 Session 非并发）** | Web GPT 本人调用、三个不同 operationId、持久化成功回执 |
| Luna 在被请求后回复/反问 Web GPT，Web GPT 再回复 | **PASS（同步三轮）** | 同一 Session 问答连续，Luna 的问题被下一轮实际回答 |
| **无人触发时**本地 Agent 主动投递、唤醒指定 ChatGPT 对话并收到该对话的真实 ACK/回复 | **NOT ACCEPTED** | 需独立凭据绑定的 route principal、实际 ChatGPT 新 turn、真实 ACK 和反向消息回执；不接受仅 `dom_submitted` 或 MCP 自报 |

本轮只读观察：`coach_sidecar_status` 返回 stopped；`coach_route_state(snapshot)` 返回 `no trusted route principal verifier is configured`。不得通过降低 principal 安全要求、伪造 ChatGPT turn、手工复制文本来消除阻断。自主唤醒属于后续单独设计/验收任务。

## 运维纪律与固化路径

- 本任务历史功能 SHA `4d594fccdbc703cc95fca46993e9d2ef5c51fe06`，历史验收文档 SHA `18e9d54b46af8bf146f4bc3371611ee3397f4bef`；两者不可因新的运行回执而改写历史。不要在无用户授权时 merge/push `main`。
- 本 runbook 使用**稳定发现入口**，不含 Owner 密码、API Key、Token、Quick Tunnel 临时 URL 等秘密；严禁通过 `read` 整份 OpenCode provider 配置来诊断 Session。
- 功能仍受“单一授权 Session + 单目录 + 本地 loopback 服务 + 非并发使用”的测试级限制。运行证据不是全面多 Agent 可用性证明。
- 完整测试曾有与适配器无关的 `npm test` exit=1（`src/tria-task-integration.test.ts:536`）；不能把单项测试通过描述为全量 PASS。
- **避免 Web GPT 下次遗忘：** 在连接该 DevSpace 工作树时，`AGENTS.md` 自动提供此 runbook 链接；新对话应按前面的冷启动合同重新查询真实 runtime。要对所有新会话稳定生效，需经过独立审查后把该两处文档入口合入正式 DevSpace 仓库，并在用户常用 ChatGPT 项目指令中放一条“涉及本地 Agent 时，优先读取 DevSpace AGENTS.md 和此 runbook”的提示。仅依赖聊天历史或模型记忆不具备确定性。
