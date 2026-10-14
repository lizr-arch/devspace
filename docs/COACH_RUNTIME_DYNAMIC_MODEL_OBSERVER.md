# DEVSPACE-COACH-RUNTIME-001 — Web GPT 动态模型及实时观察合同

日期：2026-10-14。代码在隔离 worktree 开发，不直接修改运行中的 DevSpace main / Coach Sidecar。

## 目标及已实现行为
- **创建 Agent 时由 Web GPT 指定** `codex_agent_start({model, reasoningEffort, timeoutMs, ...})`。
  - 本项目唯一获准：`gpt-6-luna`（Luna 6.0 CLI 官方标识）及 `gpt-6.1-sol`。其余（尤其 `gpt-5.6-luna`）创建接口拒绝。
  - 推理强度：`none / low / medium / high / xhigh`；**建议缺省 Medium，由 Web GPT 显式传入**。服务不偷偷改模型/降级推理。
  - 最大运行超时由原 180 秒提高为 3600 秒，默认 900 秒；模型回复可能很慢，但不能依据几秒没有 token 推断失败。
- **运行期间排队调整下一回合**：`codex_agent_update_config({workspaceId, operationId, expectedRevision, model, reasoningEffort})`。
  - SQLite `coach_agent_model_configs` 事务性记录 `active`、`next`、`revision`。相同版本的并发竞争后到者拒绝，当前 Codex 子进程的 argv 从不被篡改，绝不自动 kill/restart。
  - 获证据且 Coach 裁决为 REWORK 后，`codex_agent_start_rework` 默认继承父运行的 `next` 配置；Web GPT 也可以在该调用中显式覆盖任意字段。必须保留原线程、Git 指纹与审查门禁。
  - 如果要立即变更本回合，必须**显式停止**后遵循已有隔离/审查/恢复流程；不能假装一个生成中的请求可以无损热切模型。
- **Web GPT 直接实时观察**：`codex_agent_observe({workspaceId,operationId?,cursor,limit})`，不依赖浏览器配对口令，即可以权限隔离的 MCP 工具读取本地 `AgentObserverStore` 去敏事件及进程状态。
  - 原生线程事件：`thread.started / turn.started / item.started / item.completed / turn.completed / turn.failed / runner.finalized`。
  - Runner 每 5 秒发 **`runner.heartbeat`**，只证明本机观察器/进程仍被运行器管理；不证明模型生成 token、开发有进度或卡死。
  - `codex_agent_status` 区分 `STARTING / EVENTS_FLOWING / AWAITING_MODEL / SUSPECTED_STALL / FINISHED`，暴露最后原生事件的时间、真实事件数量与沉默时长。超过 120 秒无原生事件仅叫“疑似停滞”，不会杀进程；最终结果仍由 Codex 原生事件、退出码、源代码指纹和审核证据决定。
  - 所有事件只携带合法 ID、粗粒度事件类型、工具类别、耗时等去敏字段，不携带原始 prompt、推理内容、命令行、stdout、工具参数、秘密路径。
- **Web GPT 审核义务**：在**当前活跃 ChatGPT 会话**执行模型时，持续递增 cursor 轮询事件；观察到文件变化/工具完成可以要求局部测试，看到真实 `runner.finalized` 才阅读审核证据。若长期无事件，先判断连接/运行状态，不武断终止。
- **跨会话边界**：当 Web GPT 对话结束/断线，Web GPT 不会持续驻留机器。Sidecar 继续为原生 DevSpace Runner 发布事件，本地记录保持；需下次对话/已配置定时任务恢复审核；不得宣称离线期间 Web GPT 毫秒级实时监督。

## 只读排查与独立工具链
旧测试 `project_task → Python subprocess → codex exec` 不进入原生 `AgentObserverStore`，所以不应拿观察面板“没有记录”证明模型死机。新联动必须走 `codex_agent_start` 以进入同一事件流和 Coach 审核存储。Agent 观察面板与 Web GPT 都能看到经过投影的相同原生事件，但用途不同。

## 安全与发布
本次没有使用任何收费模型或旧模型的真实调用；全部 Codex 测试以 Node 测试 fixture 产生本地 JSONL 事件。未重启/重装/更改原正在运行的 Mac DevSpace 服务。**代码留在独立开发分支，集成到 main 及服务重启必须独立批准、重新启动后才能更新对话工具目录；此时不能宣称线上 MCP 已暴露新工具。**

## 最短验收
- `tsc -p tsconfig.json --noEmit`
- `tsx src/codex-agent-runner.test.ts`
- `tsx src/codex-agent-mcp.test.ts`
- `tsx src/coach-five-cycle.test.ts`
- `tsx src/coach-review-gate.integration.test.ts`
- `tsx src/agent-observer.test.ts`
- `tsx src/coach-review-events.test.ts`
- 服务发布之后新增：只在隔离 worktree 运行一次已批准模型的真实 CLI 任务，验证 `start → observe(cursor) → config update → REWORK → evidence → review`；若提供方无返回，报告 `MODEL_EXECUTION_BLOCKED`，但 Observer 仍应产生开始与本地心跳。

## 运行时合同不包括
- 无法保证外部模型 API 一定有响应，Runner 无法将服务器无 token 输出转成模型实际推理进度。
- 不能无中断改变当前执行中的模型。默认队列下一回合。
- 不自动更改 TriaRegna、Houdini 或现有 Sidecar/Agent 配对令牌。
