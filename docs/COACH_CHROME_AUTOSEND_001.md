# COACH-CHROME-AUTOSEND-001 · 独立工作树开发报告

日期：2026-10-16。实现：Chrome Manifest V3 独立浏览器扩展。目标是让本地 Codex CLI 完成事件经 DevSpace Sidecar 自动投递给**用户明确绑定的 Web GPT Coach 对话**；审核裁决仍由 Web GPT 执行，不由 Chrome 扩展或本地 Codex 假冒。

## 关键工作流

1. DevSpace Codex CLI 完成后产生由 SQLite 记录的 `READY_FOR_GPT_REVIEW`，Sidecar 在 `127.0.0.1:8765/events` 返回可信事件。
2. 用户在**需要接收审核消息的 ChatGPT 具体对话**中打开扩展弹窗，先通过既有一次性 Sidecar 令牌配对，然后点击「绑定当前 ChatGPT 对话」「启用自动发送」。默认关闭。
3. 扩展后台 Chrome Alarm 每 30 秒检查事件；只认白名单事件类型、受限字段、已配对 localhost。按事件 ID、工作区 ID、任务 ID 去重，事件身份存 Chrome local，授权及 bearer 存 Chrome session。
4. 尝试发送前先持久记 `in_flight`；受控 content script 仅检查绑定的单个 tab URL 和空白输入框，禁止读取对话历史或身份数据，也不覆盖用户草稿。发现生成中、页面改变或编辑器不明时停止。
5. 页面 DOM 反馈编辑器清空时记为 `sent`（仅“浏览器交互完成”，**不是**“Web GPT 已完成审核”）；其他情况进入 `needs_attention`，停止自动队列。用户检查对话后可人工标记已发送或确认未发送再重试；不自动重试不确定投递。
6. 页面离开绑定 URL、标签页关闭、取消 Sidecar 配对或换一个配对令牌均撤销自动发送授权。Chrome 重启后 session 自动失效，需重新绑定/启用。不会自动打开或切换 ChatGPT 对话。

## 范围和设计决策

- 代码文件：`coach-browser-extension/manifest.json`、`worker.js`、`auto-worker.js`、`chatgpt-delivery.js`、`popup.html`、`autosend-popup.js`；原侧边栏、原观察面板和手动复制保留。额外修复 `src/managed-coach-sidecar.ts`：仅将服务自身已授权的 workspaceId 附带至 `/events` 回包，不扩大可见范围。
- 测试：`src/coach-auto-delivery.test.cjs` 和已有的 `src/coach-browser-extension.test.cjs`；入口 `npm run test:coach:autosend`。
- URL 仅允许 `https://chatgpt.com/c/{conversationId}` 或 `https://chatgpt.com/g/{gptId}/c/{conversationId}`；不在主页或不同会话发送。
- `content script` 位于 Chrome 隔离执行环境，只接收扩展内部消息，不调用 ChatGPT 非公开网络 API，不读取聊天正文；未识别正确输入框或发送按钮就失败关闭。
- 风险：ChatGPT DOM/前端输入组件将来改变会造成拒绝发送；不会绕过校验强行点击。30 秒事件检测是 Chrome 后台 Alarm，不是零延迟推送。
- ledger 超过 2048 条时 fail-closed；需要日后加入经过审核的存储清理或滚动保留策略，目前宁愿停发也不删去重历史。
- 旧版生产 Sidecar `/events` 缺少 `workspace_id`。插件允许接收旧版事件，但会明确要求 Web GPT 借助 DevSpace MCP 确认工作区；新的 Sidecar 随代码部署后附带自身确切 workspaceId。Sidecar 事件视图**默认只覆盖启动时选定的工作区**，跨所有 worktree 尚未实现自动审核队列，不得声称全局覆盖。

## 验证等级

- 已执行：`npm run test:coach:autosend`，Node VM **20/20 PASS**，覆盖消息来源、旧版 Sidecar 回包兼容、默认关闭、身份校验、去重、失联、页面导航、工作进程重启不确定态、草稿及 DOM 输入模拟、模拟事件到页面提交。
- 尚未执行：真实 Chrome 插件重新加载及真实 `chatgpt.com` 网页投递。不能把模拟 DOM 的 `sent` 当成真实聊天回合被服务端接受，更不能当成 Web GPT 已审核。
- TypeScript `npm run typecheck` 在干净隔离 worktree 因 `tsc: command not found` 无法运行，属于隔离环境缺少 node_modules 工具。此次新增浏览器脚本使用普通 JavaScript，不涉及 .ts 实现。
- 原生产 `/Users/liz/agy/devspace` dirty main、已配对 Sidecar 以及用户 Chrome 插件均未修改/重启。隔离路径直接加载会产生新的 Chrome 扩展 ID，因此**不是现有扩展 ID 的无感升级**。

## 用户侧真实网页验收流程（待部署后）

1. 经合并/同步到原目录并保留扩展 ID 后，在 `chrome://extensions` 对原扩展点“重新加载”。Chrome 会重新启动扩展后台，需要用 Sidecar 最新配对令牌重新配对。
2. 打开准备承担审核的 Web GPT Coach 对话，点击“绑定当前 ChatGPT 对话”，确认 URL 及“已暂停”，再启用自动发送。
3. 用隔离 worktree 启动一条无害 Codex CLI 完成任务，确认 Sidecar 获得 `READY_FOR_GPT_REVIEW`，Chrome 只向绑定会话投递一次。
4. 切到其他 ChatGPT 会话、关闭标签页、写入人工草稿、在 Web GPT 回答中途模拟收到下一事件：均应拒绝发送，不能覆盖内容。
5. 刷新/重启浏览器和 Sidecar，确认已发送的不重复；不确定状态必须人工处理。Web GPT 按 MCP 证据真正作裁决后才称完整端到端 PASS。

## 裁决

`ISOLATED_IMPLEMENTATION_DONE`；`MOCK_E2E_PASS`；`REAL_CHROME_DELIVERY_NOT_RUN`；`PRODUCTION_DEPLOY_NOT_RUN`。
