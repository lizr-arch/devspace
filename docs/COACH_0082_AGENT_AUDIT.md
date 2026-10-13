# COACH-008.2 — Agent 开发效率审计（完整设计与验收）

日期：2026-10-13。状态：隔离工作树功能开发完成；自动化验收待最终签收与发布。此前 R1 独立复审曾裁决 NO-GO，详情见 `docs/review/COACH_0082_INDEPENDENT_R1.md`；R1 的误关联、缺失重复输入检测、审计持久化校验、面板覆盖问题已经专项修复并添加针对性反例。

## 1. 目标及非目标

系统对 **DevSpace 启动的原生 Codex CLI 任务** 进行**结束后离线审计**，回答“发生了什么、工具调用的证据是什么、哪些可疑模式值得人工或 WebGPT 复核”。它不是思维阅读器，不将大模型自述当作事实，不运行第二个模型自动制造理由。

非目标：读取 Thinking / ChatGPT 页面；截获独立终端启动的任意 Codex；自动接管开发 Agent；根据一段事件流宣布某项调用浪费；精确预测“可以节约多少分钟”；自行向 WebGPT 自动发新消息。任务级工具快照生成不会触发额外付费模型调用。

## 2. 最短数据链

```text
本地 Codex CLI --json stdout
  -> src/codex-agent-runner.ts（已有上限/进程/指纹/证据校验）
  -> src/agent-observer.ts（可信类别白名单 + 完整输入临时哈希）
  -> src/agent-efficiency-audit.ts（保守规则 + 证据编号 + 覆盖缺口）
  -> stateDir/coach-review-events.sqlite（私有 0600，SQLite WAL）
       ├─ DevSpace MCP get_agent_efficiency_audit (授权 workspace + operation)
       │    -> WebGPT 人工触发深度分析
       └─ 127.0.0.1:8765 /agent/audit（原 COACH sidecar）
            -> Chrome 扩展后台持有 Bearer，校验 JSON
            -> 点击面板任务 → 审计详情与证据，持续显示
```

- 现有实时 `/agent/events` 仍负责实时执行流水；新的 `/agent/audit` 只提供**完成任务**的持久化脱敏快照，面板按需点击查询，没有每 1.5 秒调用审计接口。
- `get_agent_efficiency_audit(workspaceId, operationId)` 是只读 MCP 工具，先使用 `ctx.workspaces.getWorkspace` 执行会话/工作区授权，再使用带两字段键的参数化 SQLite 查询。
- Chrome 扩展不注入 ChatGPT 页面、没有内容脚本和自动发送功能；凭据保存在浏览器 session，不向 WebGPT 泄露。全局查看其他 DevSpace 工作树需要在启用 sidecar 时**显式**赋予 `adminObserverScope=all_native_worktrees`；旧 COACH 配对不会隐式升级。

## 3. 审计数据契约

每个任务快照有固定 `version=1`：
- `identity`：工作区 ID、操作 ID。
- `status`：经过 runner 自身最终验收的 COMPLETED/FAILED/STOPPED/INTERRUPTED；注意 **COMPLETED 不等于 Git 已合并、专项测试通过或玩家验收完成**。
- `start/finish/elapsedMs`：可核对的执行耗时。
- `countsByEventKind`：仅计数已接受的脱敏事件类别；不是“Tool 精确数量”。
- `confirmedToolStarts/Completions`：仅有合法原生 `item.id` 的工具项，按 `actionId` 关联；不同事件 `cursor` 是不同证据位置，**不拿 cursor 做工具身份**。
- `tokenUsage`：仅合法非负整数 input/cached/output/reasoning 字段；无值时必须说明缺失。
- `sourceChange`：运行前后工作区**指纹**有无变化，不等于“已成功修复功能”；它包含被纳入指纹的工作区文件，不能直接替代 Git 审核。
- `observations`：受控规则发现，每项有 id/category/severity/confidence/evidenceLevel/evidenceEventIds/claim/recommendation。所有可疑重复调用都标记 low confidence，不叫“无效操作”。
- `evidenceTimeline`：最多 120 条受限元数据事件（ID、类别、时间、阶段、可信工具类型），供 WebGPT/面板依据 ID 复核；不含原始命令、文件路径、参数或 stdout。
- `dataCoverage`：明确标记时间线是否截断、事件数与不可用证据。当前本质上是损失型采集，`agent_intent_unavailable`、`tool_results_redacted`、`external_side_effects_unobserved` 常态存在，`complete` **不会伪装成语义完整**。

隐私：工具输入临时 SHA256 仅在当前 native-runner 内存用于判断两次**输入相同**；任务快照和 Chrome 实时事件**不存或展示该哈希**，不会保存原文，也不会保存隐藏 Thinking。只支持已观察到的 file_change 边界。Shell 命令可在没有 file_change 事件时产生副作用，因此重复输入只能提示“疑似”，不能自动计算节省时间。

## 4. 数据规模、耐久性和安全

- 单个审计快照不超过 48 KiB；总审计快照最多保存最近 512 条（删除仅针对二级审计表，不删除原有 COACH 审核证据）。
- 单次分析最多使用 512 条正规化轨迹事件；超过则显式 `trace_truncated`，数量只代表**观测前缀**，不代表全任务。Codex 原始 JSONL 上限由原 runner 单独控制。
- SQLite 位于私有 stateDir，目录 0700、DB 0600，WAL；审计行包含 SHA-256 校验和，MCP 和 sidecar 都要验证，能检测意外改动（**不是能防御有写权限恶意攻击者的 MAC**）。
- 重启后已存审计仍可通过同一工作区 ID/任务 ID 查询。浏览器面板的**实时历史**仍是内存限长窗口，不能把它误当作完整永久归档。
- sidecar 只绑定 127.0.0.1，严格 Host、来源、配对 Bearer、GET 方法、参数名/数量；浏览器后台控制 JSON MIME、64 KiB 最大响应文本、v1 类型/数量/身份；DOM 只用 textContent 等安全 API。
- 审计数据库读写故障不能导致成功的原生 Codex 任务被错误判断为开发失败；审计不可用时返回错误/不可用，不伪造快照。

## 5. WebGPT 人工复核工作流

1. 用户在 Chrome 观察面板点击最近任务的 **「查看审计」**，见到离线快照、可疑模式和证据编号。
2. 用户要求 WebGPT 复审指定 `workspaceId` + `operationId`；WebGPT 通过 DevSpace MCP 调用 `get_agent_efficiency_audit`。
3. WebGPT 对每条观察分别说明：*被记录的事实*、*合理的多种解释*、*尚缺的证据*、*可能的更短工作流*。
4. 需要源码/测试/命令结果时，再使用既有受权限限制的读取及 Git 工具，禁止凭脱敏摘要臆测源码或开发意图。
5. 得到足够多条任务证据以后，才能针对性更新 AGENTS.md 或 COACH 提示词，并复测是否真正提升**交付质量、端到端时长、总 Token 和返工次数**。

这版不自动让 WebGPT 在用户离线时运行。自动深度语义分析属于后续单独调度与成本管理功能；本版已提供可靠的 MCP 接口与面板展示所需的数据层。

## 6. 测试矩阵与证据

- `npm run test:coach:audit`：纯分析器反例（native item.id 匹配、真实中断、重复输入/文件变化、截断、脱敏），**真实 Node 子进程发 Codex JSONL** → runner → SQLite 重开读取 → MCP 注册/工作区授权 → sidecar HTTP 正反例 → Chrome 后台脚本校验 → 面板 VM 点击/刷新保持。未模拟真实 Chrome UI。
- `npm run typecheck`：全 TypeScript 静态检查。
- `npm run test:coach:observer`：原观察面板/sidecar 白名单和浏览器兼容回归。
- `npm run test:coach:mac`：COACH 核心原有事件、安全、恢复、五周期审核回归。
- 真实 Chrome 验收（仍待用户侧实际页面）：刷新扩展后以授权令牌配对，启动一个新 DevSpace Codex 任务，点击该任务 **查看审计**，对照 MCP 同任务快照；确认刷新仍保留分析结果，退出/重启后同任务快照可由 MCP 查询。
- 注意既有任务不会自动“补全工具输入证据”，旧版历史只存 eventTypes/用量，不能将本次新审计结果追溯编造到旧任务。

## 7. 发布与回退

1. 代码在隔离分支测试并复审，不覆盖生产未提交改动；生产合并前检查 main HEAD 和工作树干净，并保留备份 ref。
2. 快进合并到 main 后只执行 `npm run build` 和必要聚焦回归，重启 `launchd` 服务，再次通过 `devspace_info` 验证新 Boot ID。
3. 由于重启销毁 COACH sidecar 的内存 token，需要在恢复后重新启动 8765，按明示管理员观察权限配对；Chrome 扩展目录必须重新加载。
4. 紧急回退通过预留 Git ref、重建旧版本并重启服务，不清空既有 COACH SQLite 数据。
5. 未验证真实 Chrome 前不声称 UI 发布完全验收。

## 8. 已知边界与未来优化

当前实现只使用局部确定性规则，**没有**构建可证明“最短路径”的完整因果图，也没有自动发现代码相关性、命令真实意图或增量测试最优集合。若这些信息在现有脱敏事件中缺失，应当增加最小必要的安全元数据和审计复核证据，而不是增加大量要求开发模型解释自己的提示词。重点继续研究 **代理工具调用是否获得新信息** 与 **相同质量下的最低开发成本**。
