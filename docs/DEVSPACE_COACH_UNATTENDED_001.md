# DEVSPACE-COACH-UNATTENDED-001 · 无人值守闭环可靠性收口

2026-10-19 · 本轮范围：原生审核状态同步、事件级 Chrome DOM 提交回执、可靠重传。**不得将本轮等同于整个无人值守研发流水线已通过真实验收。**

## 已解决

1. `NativeCodexAgentRunner.status()` 读取与事件哈希匹配的持久化 `coach_review_decisions`，使 Web GPT 提交的 `BLOCKED / REWORK / APPROVED` 不再被内存中的 `READY_FOR_GPT_REVIEW` 覆盖；重启恢复也不伪造未经确认的结果。既有工作区隔离不改变。
2. Chrome 扩展升级至 **v0.3.6**。仅当已绑定 ChatGPT 对话的内容脚本返回 `ok:true,submitted:true`，才持久记 `sent + receiptState:pending + receiptIdentity`；此后异步 POST 到 Sidecar `/delivery-receipt`。HTTP 失败时仅重试**回执**，不重复发送聊天消息；人工点击“确认已手动发送”不会伪造 DOM 回执。
3. 原生 Sidecar 保持原审核事件 SQLite **只读**；使用同一可信 stateDir 下单独的 owner-only `coach-delivery-receipts.sqlite`。只接受已配对 Chrome 扩展 Origin + 当前 bearer token + 精确 workspace / operation / event 三元组。事件必须真实存在于只读原生数据库；幂等 `INSERT OR IGNORE`，不泄漏聊天内容，不将该回执视为审核裁决。
4. MCP 新增只读 `coach_delivery_receipt(workspaceId,eventId)` 查询工具，供 Web GPT Coach 独立读取本地服务器收到的 **DOM 提交声明**；该声明不等于 ChatGPT 服务端投递成功。事件关联的 Web GPT 会话中实际出现消息及审核结果仍需独立验证。
5. 模拟安全回归覆盖来源不匹配、未认证、伪造身份、不完整表单、幂等重复 POST、Sidecar 重启恢复、Chrome HTTP 失败自动重传、防止二次聊天发送、人工确认不伪造回执；以及运行中和重启后审核状态同步。

## 强制运行边界

- **启用需要两端部署**：DevSpace 生产构建并安全重启 MCP/Sidecar（更新本地服务进程），Chrome 在 `chrome://extensions` 重载**同一目录**扩展至 v0.3.6，并重新完成 Sidecar 配对及明确的单对话绑定。只修改仓库源码或 Node 模拟测试，不代表现有运行实例已加载。
- 扩展只能在**绑定的 ChatGPT 标签页存在、浏览器已登录、配对有效、模型不在生成中、网页 DOM 与代码匹配**时投递。浏览器关闭、会话失效、账号状态改变或上下文窗口耗尽，必须 fail closed，不能宣称永远无人值守。
- 所有状态 `in_flight / needs_attention` 维持原安全策略，不能在网络断线后盲目重发；对于不能证明未发送的消息，仍需要人工确认。
- Sidecar 接收到的回执是扩展侧的可信范围受限**自报告**，不能做密码学级“浏览器确实单击且服务端接受”的证明；审核工具不能凭回执自动 APPROVED。
- Web GPT 写回 APPROVED 仍必须通过独立批准的测试凭证；任何 REWORK、下一里程碑启动都必须有有界任务说明、工作树隔离、验证门禁及幂等调度。

## 下一阶段仍需验收

1. **真实 Chrome v0.3.6 投递**：发送新事件时必须在该对话自动出现，`coach_delivery_receipt` 返回匹配的事件身份；缺少任一证据即 BLOCKED。
2. **部署及恢复**：生产端安全重启后，新服务保留 Sidecar 证据和已审核状态；确认无正在运行的 Codex、Guardian、Job 之后才可重启。
3. **完整任务调度**：在隔离工作树、批准测试任务下验证真实 `REWORK → Codex CLI 返工 → Web GPT 复核 → APPROVED → 自动安排下一阶段`；每个动作必须防重放、有限次数、断线后不丢任务。现有 `CoachRealtimeEngine` 使用独立**本地** reviewer，不能把它冒充 Web GPT 后台常驻能力。
4. **场景故障注入**：Chrome 重启、网络超时、同一事件两次、任务完成时 ChatGPT 正生成、上下文到上限、人工草稿、Sidecar 新进程、跨工作区、多里程碑。失败必须可恢复但绝不执行双重 Git 修改。

## 验收结论

此文档写入时，仅声称本轮**开发与本地回归**；正式交付前逐项核对测试退出码、限定 Git 差异及生产服务生效状态。不得在仅有模拟证据时写 `UNATTENDED_E2E_PASS`。
