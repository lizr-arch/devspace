# COACH-CODEX-ROUTE-DIAG-20261016 — 真实模型调用故障与 Chrome 审核闭环状态

日期：2026-10-16。工作区：`/Users/liz/agy/devspace`。本报告仅记录可核实的本机只读探针结果；未取得的信息不得推断为成功或失败。

## 事实与证据

- 真实 DevSpace `codex_agent_start`：`coach-chrome-e2e-real-20261016-01`，`gpt-6.1-sol` / Low / Read-only，120 秒后 `STOPPED / codex_execution_timeout`；原生事件显示 `thread.started`、`turn.started` 和多次 `error / RETRYING`，未产生 `READY_FOR_GPT_REVIEW`。
- 第二次：`coach-chrome-e2e-luna-20261016-02`，`gpt-6-luna` / None / Read-only，55 秒后相同 `STOPPED / codex_execution_timeout`；未产生真实完成证据。
- 独立 Python 任务、Node/Codex 实际命令探针：CLI `codex-cli 0.162.1`。限制 16 秒的探针有会话启动事件但尚无错误；63 秒探针则有 `thread.started`、`turn.started`、一条真实 `type:error`，分类为 **timeout**，未得到 `turn.completed`。诊断脚本仅输出白名单错误类型、不输出原始错误内容。
- 本机模型缓存同时包含 `gpt-6-luna` 与 `gpt-6.1-sol` 名称，但缓存存在不等于模型服务可用，不能据此判断认证或网络必然正常。
- 原 DevSpace 工作区 SQLite 审核队列：4 条待审核，未超过 50 条 Sidecar 响应上限；这不能证明 Chrome 标签页、扩展授权或消息投递正常。
- 原 Sidecar 仍在 `127.0.0.1:8765` 运行，并登记 Chrome 扩展 ID `bapcebjlgncogfpgbhllioaichcldkbl`。
- Chrome 自动发消息的真实端到端验收**尚未完成**，不能将代码测试或配对登记等同于浏览器发送成功。

## 代码整改

- `src/codex-agent-runner.ts`：只对真正的 Codex `error`/`turn.failed` 事件进行白名单分类，返回 `errorEventCount` 和 `lastErrorCategory`，类别为 `authentication`、`model_unavailable`、`rate_or_quota`、`provider_5xx`、`transport`、`timeout`、`unclassified`。不保留原始错误文本。
- `src/server/tools-codex-agent.ts`：观察接口可读取上述安全分类；不暴露敏感错误内容。
- `src/codex-agent-runner.test.ts`：覆盖各类别与文本不泄露、暂时性错误后完成任务的既有逻辑。
- 集成提交 `4c9b3c02c95a37c54a03e66834f7db2dd4d27806`；原工作区 `npm run typecheck` 和 `npm run test:coach:mac` 均通过。
- 原有 `AGENTS.md`、`package.json`、`src/server/express-routes.ts` 等其他开发者未提交变更保持原样。

## 未完成的验收及安全注意

1. **先做服务端问题定位**：审查本机/CLI 到实际模型服务的代理、网络请求超时、认证与后端状态。直接证据是 timeout 类别；不能未经验证就断言网络或认证故障。
2. **在获得服务所有权/空闲窗口后**，以安全构建与受控重启加载最新编译产物。Git 源码已修改但运行中的 DevSpace 服务不会因为 TypeScript 文件修改而自动加载新诊断功能。不能盲目停止 Sidecar 或正在运行的 Codex。
3. 以一条少于 60 秒成功完成的、只读的 Codex 真实任务验证完成证据、`READY_FOR_GPT_REVIEW` 和 Sidecar 队列。
4. 最后由 Chrome 自动发往**用户明确绑定的** ChatGPT Coach 会话，并读取实际消息和审核裁决。只有这一步成功才可标记 `REAL_BROWSER_E2E_PASS`。
5. 扩展配对与授权状态目前无法通过本次 DevSpace MCP 读取；若弹窗显示 `needs_attention`，先人工确认是否发出，禁止不确定情况下自动重复发送。

结论：`NATIVE_CODEX_MODEL_TIMEOUT_REPRODUCED`；`SAFE_DIAGNOSTIC_CODE_TEST_PASS`；`CHROME_REAL_DELIVERY_NOT_VERIFIED`。
