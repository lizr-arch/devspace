# DEVSPACE-COACH-UNATTENDED-002 · Web GPT 驱动无人值守闭环开发报告

日期：2026-10-19
范围：DevSpace + Chrome Coach Watch + Web GPT Coach + Codex CLI 四阶段推进。
**结论：开发与本地完整模拟闭环通过；生产部署、真实 Chrome / ChatGPT 网页验收、连续长时间无人工实战未通过，禁止标记 UNATTENDED_FULL_PASS。**

## 阶段验收矩阵

| 阶段 | 本轮实现与证据 | 生产判定 |
| --- | --- | --- |
| 1. DevSpace / Chrome 收据 | 原有 0.3.6 事件级 DOM 提交回执、独立本地 SQLite、工作区/任务/事件身份、失败只重传回执。Worker UDS 透传查询与 API/Worker 重启恢复补齐 | **DEPLOY_BLOCKED**：当前 Mac DevSpace 服务仍是旧进程；Chrome 0.3.7 未在目标用户会话中重载/实发 |
| 2. Web GPT 裁决自动返工 | CoachRealtimeEngine 新增显式 reviewerMode=webgpt，持久化 bounded feedback，MCP coach_webgpt_submit_review，Web GPT 签发 REWORK 后本地 Codex 同线程自动启动；最多 5 次 | **LOCAL_PASS**；真实网页自主审核待验 |
| 3. APPROVED 下一阶段 | 每个阶段必须预先注册已批准测试任务，Web GPT 独立检查，再调用新工具；APPROVED 运行独立测试并校验指纹，持久化意图后自动派发下一阶段，绝不重用未经授权的提示词 | **LOCAL_PASS** |
| 4. 无人值守恢复 | 断开期间等待 Web GPT、不切换为本地伪审核；拒绝跨工作区；重复审核幂等；服务重启时检查 DISPATCHING 对应的持久化子任务，存在才继续、未知即 BLOCKED；独立测试失败禁止 APPROVED；暂停/恢复；Chrome 崩溃时不重复发送，回执可安全重传 | **FAULT_INJECTION_PASS**；24h/72h 真实值守尚未实测 |

## 新增操作接口

- `coach_webgpt_register`：显式注册针对一个工作区的有界阶段任务计划，**只允许 DevSpace 托管的隔离 Git worktree，不接受直接附着 main 的 checkout**；必须具备预先批准的 task manifest（每阶段测试任务、沙箱、模型及提示词）。已存在的其他运行中计划阻断并发。
- `coach_realtime_status`：只显示有限状态，包含 reviewerMode=webgpt/local，避免混淆两个审核系统。
- `coach_webgpt_submit_review`：必须指定 planId、workspaceId、operationId、eventId、decision、evidenceSha256、**明确具体且长度受限的 reason**。通过身份、工作树指纹、独立测试门禁后提交裁决并唤醒调度。相同裁决重复调用幂等；冲突裁决被拒绝。
- `coach_delivery_receipt`：读取扩展声称已完成 DOM 提交的服务端事件回执。它不等于 ChatGPT 服务端收到、生成答复或审核通过。
- 原有 `coach_realtime_register` 继续使用本地 Codex reviewer，保持向后兼容；新模式不在 Web GPT 离线时自动切换本地 reviewer。

扩展版本：**0.3.7**。自动通知在适配 Web GPT 计划时指示调用新接口写回裁决；原有独立事件继续用原 `codex_agent_submit_review`。

## 已实际执行的测试

- `npm run typecheck`：最终复核 PASS，退出码 0。
- `npm run test:coach:observer`：50/50 PASS，Chrome 0.3.7 输入、防重复、安全、回执模拟。
- `coach-e2e-qa/npm test`：PASS，真实本地模拟 Codex 子进程 + MCP 工具注册与 REWORK 提交 + 次阶段 APPROVED + 崩溃恢复 + 未知派发阻断 + 重复发送幂等 + 跨工作区 + 返工额度 + 暂停/恢复 + 测试失败拒绝批准 + **非托管 main checkout 不能注册无人值守计划**。
- `coach-e2e-qa/npm run test:realtime`：PASS，原本地 reviewer 模式兼容与负向门禁。
- `coach-e2e-qa/npm run test:sidecar`：PASS，Sidecar origin/token 身份验证、事件同步、重启保留。
- `npm run test:codex-worker`：PASS，真实 Unix Domain Socket Worker、重启恢复、跨 API generation 回执读取。
- `coach-e2e-qa/npm run build`：PASS，隔离 TypeScript 正式产物编译，**不覆盖正在运行的 dist**；临时产物已移入 DevSpace 私有隔离区。
- `npm run test:coach:mac`：**最终 PASS，退出码 0**。最初前置 `devspace-instance-lock.test.ts` 报 `COACH_RELEASE_INSTANCE_WAIT_TIMEOUT`；定位为子进程启动时不必要地加载整套服务，改为只在父进程动态加载 `config/server` 后完整回归通过。

## 严格的生产部署与安全要求

当前服务 `com.liz.devspace` 是 macOS LaunchAgent，来源：仓库 `docs/DEVSPACE_CODEX_RELIABILITY_001_FINAL.md`。MCP 活体进程不能靠提交 Git 自动加载新代码；Chrome 本地扩展也不会自动切换脚本版本。

执行部署之前必须确认：API/Worker/Sidecar 无在途 Codex、Guardian、Job 和玩家工程进程；备份运行中 `dist` 及配置、记录旧 bootId 和 SHA；不可覆盖原工作树 3 个已修改文件 `AGENTS.md`、`package.json`、`src/server/express-routes.ts`，不可清理既有未跟踪数据。需要本机授权的真实命令由 macOS 操作者在空闲闸门合格之后按原有部署手册执行：

```bash
cd /Users/liz/agy/devspace
npm run build
launchctl kickstart -k "gui/$(id -u)/com.liz.devspace"
```

注意：这是**部署说明**而非已执行结果。Cloudflare Tunnel 和独立 Codex Worker 不应无故重启。部署后需比较 `devspace_info` 的 bootId 与 schemaRevision（应含 `coach-webgpt-loop-001+delivery-receipt-001`），再核对 `coach_delivery_receipt` 是否出现在 MCP 工具目录。

Chrome 在 `chrome://extensions` 重载相同目录下的 `DevSpace Coach Watch v0.3.7`，重新配对 8765 Sidecar、重新绑定指定的 ChatGPT 对话，并清空残留草稿。不能隐式授予跨会话自动发送权限。**实际 Chrome 自动提交新的事件，Web GPT 再完成 REVIEW 并自动触发已登记计划，是阶段 1–3 正式上线的硬证据。**

## 尚不能保证的行为

- 不承诺 Chrome、浏览器授权、网络或 ChatGPT 会话关闭/耗尽之后继续无人值守；这需要独立获得授权的长时运行 Agent / API 服务，不能把网页 UI 自动化称为永久后台。
- 不在失败状态下盲目恢复：`needs_attention`、未知浏览器提交、指纹变化、未知 Codex 派发结果、测试失败、超过 5 次返工均安全 BLOCKED。
- 不自动清理旧工作树、合并或 push 到 main；正式游戏项目的提交、合并授权另行规定。
- 暂无 24/72 小时真实稳定性与真实 TriaRegna 里程碑无人参与闭环数据。

## 最终声明

`CODE_AND_SIMULATION_E2E = PASS`，包括 Mac Coach 综合套件、Web GPT MCP 驱动真实子进程测试、Worker IPC 与 TypeScript 编译。
`DEVSPACE_PRODUCTION_DEPLOY = NOT_RUN`。
`CHROME_REAL_CHATGPT_AUTOSEND = NOT_VERIFIED`。
`LONG_SOAK_24H = NOT_RUN`。
`UNATTENDED_FULL_PASS = BLOCKED`。
