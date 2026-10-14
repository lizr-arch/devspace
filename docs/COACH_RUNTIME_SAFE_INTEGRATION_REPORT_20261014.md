# DEVSPACE-COACH-RUNTIME-001 安全集成审查报告
日期：2026-10-14
Reviewer：Web GPT；**中文报告**；仅本地隔离 worktree，**不宣称生产部署成功**。

## 一、裁决

| Gate | 结果 |
|---|---|
| 原升级功能提交 | PASS，`8cdc835577f37ee38da5738a329d0923e96f3a26` |
| 独立集成分支 FF-only | PASS，基于 `b90be2d9308d37cd6ac7a6677da6fa342982f51b`，无冲突 |
| 实际 Browser Sidecar HTTP 和 MCP Observer 读取**同一次本地模拟 Agent** | PASS，`COACH_RUNTIME_SAME_AGENT_MCP_BROWSER_OBSERVER_CANARY_PASS` |
| Dynamic `gpt-6-luna` Medium → `gpt-6.1-sol` High | PASS，下一回合队列生效，旧进程不变 |
| 安全身份/泄密负例 | PASS，未授权 HTTP 401；禁止模型不能执行；Web GPT 观察状态只暴露白名单字段 |
| Web GPT 游标恢复 | PASS，重启后的过期游标返回 `reset=true` 并正确重播现有事件 |
| TypeScript / build / Runner+MCP / 5轮返工 / guardian recovery | PASS |
| 当前 DevSpace main 合并 | **BLOCKED_OWNER_DIRTY**；未覆盖第三方成果 |
| 当前 7676 DevSpace 服务升级和真实网页联测 | **NOT_RUN**；不可冒充隔离测试 |
| 真正允许模型的长时推理完成 | **NOT_RUN**；原本缺 `turn.completed` 的问题仍待生产可观测升级后复测 |

## 二、证据位置

隔离 worktree：`/Users/liz/.devspace/worktrees/devspace-59bc367b`

分支：`devspace/integration/devspace-devspace-59bc367b`

feature 起始提交：`8cdc835577f37ee38da5738a329d0923e96f3a26`

端到端与安全修复提交：`818d400f5ed48a7232685426f22e81bfbba5c504`

核心源码：`src/coach-model-policy.ts`、`src/codex-agent-runner.ts`、`src/coach-review-events.ts`、`src/server/tools-codex-agent.ts`、`src/server/tools-codex-review.ts`、`src/agent-observer.ts`。

复核脚本：`src/coach-runtime-canary.integration.test.ts`。
运行：
`/Users/liz/.local/bin/node --import /Users/liz/agy/devspace/node_modules/tsx/dist/loader.mjs src/coach-runtime-canary.integration.test.ts`。

隔离 worktree 下的 `.devspace/tasks.yaml` 和 `.devspace/link_deps.py` 仅是本机临时准入任务；`node_modules` 是指向主仓库依赖目录的符号链接。它们是隔离测试辅助文件，均**未提交**到 release 代码分支。

## 三、原 main 的完整保护

审查时：
- `main` HEAD = `b90be2d9308d37cd6ac7a6677da6fa342982f51b`；
- 未暂存：`docs/gemini-spark-usage-guide.md`、`package.json`、`src/server/express-routes.ts`；
- 未跟踪：`tests/test_gemini_tool_expansion.ts`；
- 未做任何 reset、clean、stash、覆盖、提交他人代码、合并 main 或推送远端。
- 运行中的生产 DevSpace boot ID = `0acc6dbd-fc69-4ac2-89e2-3ace345ef5e2`，Coach Sidecar `coach-feed` 8765 仍在运行，现有扩展配对不动。

## 四、实际集成和部署剩余步骤

1. 等待这四个并行文件的合法所有者完成提交或明确移交；**不要猜测哪个文件可删**。准备干净目标后重新获取 `main` SHA、核查其与 `818d400` 的共同祖先。
2. 若当前 `main` 仍为 `b90be2d` 且为 clean，则允许显式 SHA 守卫的 `git_merge(mode=ff_only,sourceRef=818d400f5ed48a7232685426f22e81bfbba5c504)`。若 `main` 已更新，先重新审查并集成新变更，禁止依据过期 SHA 强行操作。
3. 完成一次正式 `npm run build` 和针对性 Coach 门禁，在**安排好的可控窗口**检查运行中的操作和授权会话，部署到生产。重启前备份现有配置；不得假定旧的浏览器扩展 token 在新代 Sidecar 中自动继承。
4. 升级后以 `devspace_info` 确认新的运行时 schema 标识和 boot ID；刷新 ChatGPT DevSpace connector 工具发现，确认出现 `codex_agent_update_config`、`codex_agent_observe` 及新模型枚举。
5. 现有 Sidecar 在之前是旧版启动。要让扩展通过 `/agent/events` 看到**跨工作树原生 Agent**，需要在用户明确批准提升观察权限后，以 `adminObserverScope=all_native_worktrees`、已授权 `pairedExtensionId` **重新配对**。这会换一次性 bearer token，原 token 不能被静默提升；浏览器需要重新配对。代码虽支持，但当前已缓存的 MCP 工具签名可能尚未呈现该选项，必须更新后核验。
6. 使用允许的 `gpt-6-luna` Medium 在**隔离工作树**发起一条小型只读真实 CLI 任务，MCP 启动并同时读取进度、heartbeat 和浏览器 `/agent/events`。只有真实 `turn.completed`、退出码和证据文件验证通过才能声明 Model 通道恢复；无答复只记 `MODEL_EXECUTION_BLOCKED`，不暗中切换旧模型。
7. 只有生产同步观察与真实模型执行双重通过，才允许按 `TR-MAP-V1` 三批施工合同恢复定军山无人值守开发。

## 五、用户判断

这一轮真正交付的是**完整、隔离、经实机 HTTP/MCP 联测的升级候选**。现阶段不能把已运行的旧服务器标成新版本，也不能声称用户 Chrome 扩展已经成功使用新观察接口。对生产发布的准确裁决：`ISOLATED_INTEGRATION_READY; PRODUCTION_BLOCKED_OWNER_DIRTY`。
