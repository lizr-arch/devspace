# COACH-REALTIME-001 — 事件驱动的本地 Codex 审核闭环

## 交付目标和真实性

**Codex 完成事件触发本地工作，不依赖 Web GPT 常驻。** DevSpace 的 `CoachReviewEventStore.recordCompletedWithEvidence` 只在 SHA 校验的真实 CLI 完成证据经 SQLite 事务提交之后触发事件；`CoachRealtimeEngine` 在短延迟后接管审核。另有 5 秒本地恢复扫描用于断线、丢失事件和异常状态检测，不再以 ChatGPT 每小时检查作为开发调度器。

这并不意味着审核本身 5 秒完成；独立 Codex 模型可能需 2–10 分钟推理。5 秒左右是**触发/发现延迟目标**。网页版 ChatGPT 不能保证被事件主动唤醒，仍作为任务制定、复杂问题裁决、发布审核。

## 事件驱动流程

1. 由用户或 Web GPT 调用原有 `codex_agent_start`，显式指定受允许模型（`gpt-6-luna` 或 `gpt-6.1-sol`）、推理强度、独立工作区、任务。测试任务应事先在该工作区 `.devspace/tasks.yaml` 中登记并经过 `approve_task_manifest` 授权。
2. 调用新 `coach_realtime_register`，传入 `planId`、`workspaceId`、`initialOperationId`、`reviewerModel`、`reviewerEffort`、`maxReworks`（0–5）和 1–8 个明确的 `stages`（各含 prompt、testTaskId、model、reasoningEffort、sandbox）。登记时冻结批准任务清单的 SHA-256，不允许任意脚本成为自动测试。
3. Native Runner 正常完成，实际 `turn.completed`、退出码 0、合法 thread ID、原始输入/输出指纹、签名证据和 `READY_FOR_GPT_REVIEW` 事件必须一致。失败/取消/中断**不会**进入自动审核。
4. 本地调度器事件驱动唤醒，先比对保存的授权任务清单和签名的源指纹；不同即 BLOCKED，不做任何重放。
5. 调度器在**同一个开发工作区、不同的原生 Reviewer 回合**启动单独的只读 Codex（用户指定的允许模型）。Reviewer 必须检查源码和需求，返回仅含 `decision` / `reason` 的结构化 JSON。无效、异常、中断、超时 -> BLOCKED。Reviewer JSON 不直接写入通用 MCP 状态，也不授予任何执行权限。
6. REWORK：在 Reviewer 签名的开发产物快照下通过原有 `CoachReviewGate.submit` 提交 `REWORK`，再以原本验证的 thread ID 和 `expectedFingerprint` 启动同线程新回合。真实模型错误及其重试仍通过 Runner 审核。最多五轮，达到上限 BLOCKED。
7. APPROVED：**审核模型的认可不足以通过**。必须再运行原来显式批准的无副作用测试任务，且返回 exitCode 0、测试前后源指纹完全一致，才允许原有 `CoachReviewGate.submit(APPROVED)`。还有明确预先登记的下一阶段，则先持久化 DISPATCHING 再启动；全部阶段已通过才 DONE。
8. BLOCKED：人类需要干预或证据失效，停止无人值守。不允许隐式变更任务、降级模型、自动合并 Git、强制删除工作区或访问未授权根目录。

## 数据可靠性和恢复

`<DevSpace stateDir>/coach-realtime.sqlite` 采用 SQLite/WAL，保存每个计划的 `planId`、当前 operation ID、阶段、返工次数、状态、最近错误、批准备案 SHA。`REVIEWING` 或 `DISPATCHING` 在服务重启后若执行结局不明，直接 BLOCKED；不会再次提交可能已经执行过的写操作。所有新操作 ID 可确定性再现，已有 Runner 保持历史 operation ID 不可重放语义。计划仅在用户显式调用登记工具后生效，**默认零计划，不会自动接管别人的 Codex**。

工具：
- `coach_realtime_register` — 显式加入受控任务计划，要求 runner.execute。
- `coach_realtime_status` — 只读状态，不返回任务 prompt、密钥或模型原始文本。
- `coach_realtime_pause` — 暂停将来自动调度，不杀运行中的 Codex。
- `coach_realtime_resume` — 恢复仅已明确暂停的任务。
- 原有 `codex_agent_observe` 和 `codex_agent_evidence` 仍用于原生事件及签名证据。

## 安全边界和未实现的事情

- 这不是一个可以自行挑任意工程、任意脚本、任意权限和任意模型的无约束自主 Agent。用户应提前批准有界的工作区和每阶段测试。
- 本地 Reviewer 只能提供建议；**缺少授权真实测试必定不能批准**。
- Web GPT 不能实时驻留；工作流的即时部分由 DevSpace 本地服务负责，网页版每小时定时检查只负责兜底和用户通知。
- 现有 Sidecar 仍只提供授权的事件观察；这个功能不提升浏览器扩展跨工作树观察权限。
- 阶段全 PASS 也**不代表自动合并代码或真正游戏美术合格**。Git 合并、地图真实画面审美、历史不确定性的最后裁决保持在明确独立验收和用户控制之下。

## 发行和验证

`src/coach-realtime.integration.test.ts` 使用真正子进程、SQLite 和 Native Runner 事件检验三回合（初次 REWORK→修复 APPROVED→下一阶段 APPROVED）、重启无重复、Reviewer 结构化 JSON 白名单、真实测试失败拒绝 APPROVED、任务清单 SHA 篡改拒绝自动执行。还需编译、原有 Coach 专项回归、实际服务部署和重启后工具目录验证。技术 PASS 不可替代真正的模型推理、地图水网和审美验收。
