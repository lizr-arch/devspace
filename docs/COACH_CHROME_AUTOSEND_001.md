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
- 测试：`src/coach-auto-delivery.test.cjs` 和已有的 `src/coach-browser-extension.test.cjs`。原项目 `main` 已由浏览器扩展测试入口自动引入新增测试，运行 `npm run test:coach:mac` 或 `npm run test:coach:observer` 即覆盖；独立开发工作树另保留 `npm run test:coach:autosend`。
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

## 2026-10-16 · Chrome 0.3.1 热修复：内容脚本不可达

用户真实浏览器回报：`pending=3, sent=0, needs_attention=1`，`unknown:coach-lean-diagnose-20261012-handshake01:10` 报「内容脚本不可达」。这是扩展重新加载后原已打开的 ChatGPT 页没有新注入内容脚本的典型场景；不能把它视为已发送。

修复：增加 `scripting` 权限与仅 `https://chatgpt.com/*` 的主机授权。在事件正式发送前通过 `COACH_AUTO_PING` 验证目标会话的现有内容脚本；若缺失则仅向已绑定标签页动态注入一次，重复注入不重复注册监听器。新发送类型改为 `COACH_AUTO_DELIVER_V2`，避免潜在旧版本监听器重复处理。动态注入权限失败时保留 `pending`，不产生未确认的发送。**原有 `needs_attention` 仍须由用户检查对话消息后手动确认；不得自动重试。**

用户需要在 `chrome://extensions` 重新加载 DevSpace Coach Watch 0.3.1，核查新增 ChatGPT 网站权限、配对与当前对话绑定。若登录/配对已经有效则勿重复清除配对。运行 `npm run test:coach:observer` 覆盖自动注入及其他安全门禁。生产 Chrome 真实消息投递仍必须单独验证。

## 2026-10-19 · Chrome 0.3.2 真实用户故障修复

来自已配对的浏览器现场状态：`pending=9, sent=0, needs_attention=1`，同一四个旧审核事件同时存在 `unknown:operationId:eventId` 与 `workspaceId:operationId:eventId` 两套键；新工作区键中的事件 #10 报「找不到唯一的 ChatGPT 编辑器」。

- 扩展继续只识别唯一可见且确实为可编辑状态的 ChatGPT 输入框。除了旧 `#prompt-textarea`，增加明确的 `aria-label="Ask ChatGPT"`、`aria-label="向 ChatGPT 提问"` 候选以及已知的发送按钮标签；不扫描任意编辑区域，不覆盖用户草稿。在检测到停止生成按钮时拒绝发送。
- 仅在获得 Sidecar 经过配对认证的 **确切相同** `operation_id + event_id` 且有新 `workspace_id` 时，旧键才会归并。原旧键转为 `merged` 审计痕迹，独立于活动计数；`sent` 与 `needs_attention` 的结果不会被当作新任务而自动重发。若两个键状态冲突，遵循最保守状态；无法精确匹配的不迁移。
- 内容脚本对**明确在输入前返回**的失败增加 `notSubmitted`，Worker 保留 `pending` 并在后续轮询重试，不再误判为 `needs_attention`。已插入文本、已按发送、或结果不明则仍进入人工核查。迁移前已经出现的 `needs_attention` 不自动重置。
- `npm run test:coach:observer` 包含上述身份归并、防重发、编辑器候选与多编辑器拒绝、草稿保护、生成状态、发送前失败的回归。模拟测试通过不意味着真实 Chrome 页面提交成功。

部署提示：在 `chrome://extensions` 重载同路径 DevSpace Coach Watch **0.3.2**，必要时重新配对并绑定当前 ChatGPT 对话。恢复发送前先核查旧事件 #10 是否实际出现在聊天中；确认没有发送后方可使用「确认未发出，重试」。新版本不会自行处理旧版的不确定记录。原 DevSpace Sidecar 不需要重启。

## 2026-10-19 · Chrome 0.3.3 热修复：旧内容脚本残留与透明状态

现场反馈在 0.3.2 提交后仍为 `pending=9, sent=0, needs_attention=1`，因此原新版本并未完成队列迁移，不能声称浏览器端已通过。进一步发现一个真实协议漏洞：旧扩展加载过的页面内容脚本可能在 Chrome 扩展重载后仍回应原 `COACH_AUTO_PING`；0.3.2 无法识别其内容脚本版本，会错把旧编辑器代码视为可用。

0.3.3 使用独立 `COACH_AUTO_PING_V3` + `COACH_AUTO_DELIVER_V3` 和回包 `protocol:3` 校验。旧 V2 脚本不处理 V3 投递，新代码即使同页保留旧监听器也只安装一次 V3 监听器。后台只有确认 V3 回包才复用旧标签页，否则为已绑定 ChatGPT 标签页重新注入新版脚本。

**被动迁移**：读取弹窗状态时，只根据本地账本中唯一匹配的已授权 `workspaceId:operationId:eventId` 与旧 `unknown:operationId:eventId` 进行安全归并，无需网络、不触发发送；找不到唯一工作区的不动。历史不确定态仍须用户核实，不能因为迁移而自动重新发送。

**诊断可见性**：弹窗显示扩展实际运行版本、最近轮询结果、队列阻断原因；`现在检查一次` 不再一律提示“操作成功”。无效配对、Sidecar HTTP 拒绝、未绑定/未启用、队列锁定都有不同状态。仍不展示令牌或聊天内容。

原 Sidecar 可继续运行，无需重启。只需在原 `chrome://extensions` 重载同目录扩展，并确认弹窗显示 **v0.3.3**；若看到仍为旧版本，则本地 Chrome 尚未加载此次源文件，不能把队列的旧数值解释为 0.3.3 运行结果。重载后留意仍有一条 `needs_attention`，先核实原对话未发送后再人工重试。所有测试是 Node 模拟；尚无真实 Chrome 发送成功证据。

## 2026-10-19 · Chrome 0.3.4：自动点击发送按钮

真实用户反馈：审核指令已经自动填入指定 ChatGPT 对话，但仍需手动点击「发送」。先前 V3 代码在编辑器 `insertText` 后**立刻**查询/点击按钮；ChatGPT UI 可能尚未完成异步状态更新，导致已填入草稿而发送控件暂不可用。此为基于源码和现场现象的原因判断，尚非通过浏览器运行时事件追踪确证的唯一根因。

V4 内容脚本加入**最多 2 秒**的明确控件就绪检查，持续验证相同会话 URL、相同审核草稿、唯一可见且启用的发送按钮、无正在生成状态；只执行一次 `send.click()`，并沿用发送后输入框清空的判断。不使用可能变成换行的合成 Enter；发送前控件不就绪、用户有草稿或页面发生变化时保留输入并停止，绝不自动二次点击。安全限定的按钮范围可从编辑器所属 form 找唯一 submit 控件，不匹配其他无关页面按钮。

版本升级至 `0.3.4`，消息协议独立为 `COACH_AUTO_PING_V4` / `COACH_AUTO_DELIVER_V4`，防止旧 V3 标签页内容脚本响应新版消息。增加 6 项相关精准回归（异步发送按钮、同表单提交按钮、按钮未启用、已有草稿、历史手动发送防重等），`npm run test:coach:observer` 总计 45/45 PASS。

为解决先前用户手动提交的历史事件 #18，本地账本中的 `pending` 或 `needs_attention` 可通过**明确的用户确认**标记为「已手动发送」，从而避免升级后重复发送；没有核实消息真实进入对话时不要标记。此操作不伪造 DevSpace 审核 APPROVED，不修改原生审核数据库。

注意：目前所有自动点击测试均为模拟 DOM 回归，不能证明 ChatGPT 当前真实网页已自动接受提交；完成真实浏览器验证才可宣布全流程 PASS。重载已安装的 DevSpace Coach Watch 后应见版本 `0.3.4`；Sidecar 无须重启。优先先标记已经手动发到目标对话的事件，再测试下一条自动发送，避免重复。

## 2026-10-19 · Chrome 0.3.5：真实多行输入校验失败修复

用户在重新加载 0.3.4 后的真实 Chrome 诊断：`pending=4, sent=1, needs_attention=1`，事件 #18 为 `输入内容没有得到确认`，且扩展因版本重载而处于未绑定/暂停。此前 `sent=1` 来自用户人工确认 #10，**不代表本轮自动点击成功**。事件 #99 在 Sidecar 已验证，但该次浏览器因未配对/未绑定而未投递；不应认为 #99 已完成全链路。

源码根因候选：`document.execCommand("insertText",...)` 后立即比较 `editor.innerText.trim() === instruction`，没有等待框架渲染，且 ProseMirror 使用段落表示多行文字时，`innerText` 可能比源指令多换行。`textContent` 又可能缺少段落换行。上述真实错误发生在 `send.click()` **之前**，不能将其归因于发送按钮，也不能称消息已发送。

本轮修复（0.3.5 / `COACH_AUTO_PING_V5` / `COACH_AUTO_DELIVER_V5`）：
- 输入后限时校验最多 16 轮、75ms/轮，并要求连续两次内容匹配；允许识别两种编辑器文本表示的段落换行差异、CRLF、非断行空格，**不忽略正文、标点或不同字词**。只有同时满足会话 URL、原编辑器、无生成中状态才会发送。
- 若检测到不同正文、页面变化或仍无法确认内容，保留草稿、不点击、不重输，并由账本停入 `needs_attention`；返回仅含编辑器文本长度的诊断，不回传聊天正文。
- 仍沿用仅点击一次发送按钮、发送后确认编辑器清空、原会话单标签页绑定及防重账本。旧 V4 内容脚本不处理 V5 投递。
- 增加多段落渲染、延迟更新及正文被改写的专项回归；`npm run test:coach:observer` 48/48 PASS（Node 模拟）。

事件 #18 已在用户提供的当前聊天中人工送达，若仍为 `needs_attention`，可由用户确认消息存在并点击「确认已手动发送」，**勿点重试**。如果 Chrome 编辑框还残留 #18 的重复草稿，只可由用户核对后手动清除；不由扩展自动覆盖。升级后重新配对、绑定、启用自动发送，再对尚未处理的真实事件观察是否自动提交。旧 Sidecar 仍可运行，重载扩展会丢失会话配对/绑定。真实网页自动点击尚未复核，不能宣布 PASS。

## 裁决

`ISOLATED_IMPLEMENTATION_DONE`；`MOCK_E2E_PASS`；`REAL_CHROME_DELIVERY_NOT_RUN`；`PRODUCTION_DEPLOY_NOT_RUN`。
