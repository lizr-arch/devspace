# Tasks

## Phase 0: 仓库审计（已完成）

- [x] Task 0.1: 审计现有仓库结构
- [x] Task 0.2: 识别可复用组件
- [x] Task 0.3: 输出审计报告

## Phase 1: 协议与文件结构

- [x] Task 1.1: 创建 `.devspace/ceo/` 目录结构
  - brainstorm_summary.md
  - user_intent.md
  - architecture_decision.md
  - ceo_charter.md
  - delegate_contract.md
  - autonomy_policy.md
  - review_policy.md
  - stop_conditions.md
  - task_plan.md
  - first_task.md

- [x] Task 1.2: 创建 `.devspace/runs/` 目录结构
  - run_state.json
  - task.md
  - local_prompt.md
  - local_report.md
  - coach_review.md
  - next_task.md
  - local_question.md
  - test_report.md
  - diff_summary.md
  - diff.patch
  - final_report.md
  - events.jsonl

- [x] Task 1.3: 定义 state.json schema
  - mode: manual | guided | delegate | free
  - current_run_id
  - status: BRAINSTORM | READY_TO_DELEGATE | DELEGATE_RUNNING | DONE | BLOCKED
  - autonomy_level
  - active_task_id
  - stop_reason

- [x] Task 1.4: 定义 conversation.jsonl schema
  - timestamp
  - run_id
  - role: coach_gpt | user_proxy | local_orchestrator | executor | user
  - type: task | report | review | question | decision | status
  - status
  - title
  - content_file

- [x] Task 1.5: 定义 run_state.json schema
  - run_id
  - task_id
  - status
  - round
  - max_rounds
  - created_at
  - updated_at
  - last_actor
  - next_actor

- [x] Task 1.6: 创建 schema 校验函数
  - validate_state()
  - validate_run_state()
  - validate_conversation_entry()

- [x] Task 1.7: 创建 Handoff Package 模板
  - templates/ceo/ 目录下的所有模板文件

- [ ] Task 1.8: 编写协议文档
  - docs/delegate-protocol.md

## Phase 2: Brainstorm Freeze / Handoff

- [x] Task 2.1: 实现 `devspace brainstorm freeze` 命令
  - 读取用户提供的 brainstorm 内容
  - 生成 ceo/ 目录下的所有文件
  - 验证必填字段

- [x] Task 2.2: 实现 Handoff Package 生成器
  - src/delegate/handoff.ts
  - 生成 brainstorm_summary.md
  - 生成 user_intent.md
  - 生成 architecture_decision.md
  - 生成 ceo_charter.md
  - 生成 delegate_contract.md
  - 生成 autonomy_policy.md
  - 生成 review_policy.md
  - 生成 stop_conditions.md
  - 生成 task_plan.md
  - 生成 first_task.md

- [x] Task 2.3: 实现 Handoff Package 校验器
  - 检查必填文件是否存在
  - 检查必填字段是否完整
  - 缺少 delegate_contract 或 stop_conditions 时不能进入 Delegate Mode

- [ ] Task 2.4: 编写 Brainstorm 冻结测试
  - 测试正常冻结流程
  - 测试缺少必填字段时的错误处理
  - 测试校验器

## Phase 3: Delegate Contract 与权限校验

- [x] Task 3.1: 定义 delegate_contract schema
  - 可以代表用户做什么
  - 不可以代表用户做什么
  - 遇到什么必须触发 NEED_USER
  - 可接受风险级别
  - 自动执行最大范围

- [x] Task 3.2: 实现 autonomy_policy 解析器
  - 支持 manual/guided/delegate/free 四种模式
  - 每个等级的权限必须明确

- [x] Task 3.3: 实现权限校验函数
  - check_permission(action, contract)
  - is_high_risk(action, contract)
  - should_trigger_need_user(action, contract)

- [x] Task 3.4: 实现 NEED_USER 触发规则
  - 需要改变总体架构
  - 需要扩大范围
  - 需要引入新依赖
  - 需要真实 API key、账号、付费服务
  - 需要删除大量代码
  - 需要修改冻结契约
  - 连续两轮失败
  - Coach GPT 提出多个路线且影响长期方向
  - 本地环境缺失关键资源
  - 测试无法运行且原因不明

- [ ] Task 3.5: 编写权限校验测试
  - 测试未授权不能进入 Delegate/Free Mode
  - 测试高风险行为触发 NEED_USER
  - 测试 Local Agent 不能修改冻结合同

## Phase 4: Local Orchestrator MVP

- [x] Task 4.1: 增强 devspace_worker.py 为 Local Orchestrator
  - 读取 delegate_contract 约束
  - 读取 current_task.md 或 first_task.md
  - 调用本地模型接口
  - 生成 local_report.md
  - 记录 conversation.jsonl

- [x] Task 4.2: 实现风险检测
  - 检测即将删除大量文件
  - 检测即将修改禁止范围
  - 检测即将执行危险命令
  - 检测即将绕过测试或验收

- [x] Task 4.3: 实现 conversation.jsonl 记录
  - 记录任务创建
  - 记录执行开始
  - 记录执行结果
  - 记录审核意见

- [x] Task 4.4: 实现 `devspace run current` 命令
  - 读取 current_task.md
  - 调用 Local Orchestrator
  - 生成 local_report.md

- [x] Task 4.5: 创建 mock executor 用于测试
  - 模拟本地模型调用
  - 模拟测试执行
  - 模拟报告生成

- [ ] Task 4.6: 编写 Local Orchestrator 测试
  - 测试正常执行流程
  - 测试风险检测
  - 测试 conversation.jsonl 记录

## Phase 5: Coach Review Loop

- [x] Task 5.1: 定义 coach_review.md schema
  - Reviewed Task
  - Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_FIX | BLOCKED | DONE | NEED_USER | SAFETY_STOP | BUDGET_STOP
  - Reasoning Summary
  - Evidence Checked
  - Issues Found
  - Decision
  - Next Action

- [x] Task 5.2: 实现 coach_review 解析器
  - src/delegate/coach_review.ts
  - 解析审核意见
  - 提取 verdict
  - 提取 next_action

- [x] Task 5.3: 实现 `submit_coach_review` 命令
  - 读取 coach_review.md
  - 更新 run_state.json
  - 根据 verdict 决定下一步
  - 记录 conversation.jsonl

- [x] Task 5.4: 实现状态流转
  - PASS → NEXT_TASK_CREATED / DONE
  - PASS_WITH_WARNINGS → NEXT_TASK_CREATED
  - NEEDS_FIX → LOCAL_EXECUTING
  - BLOCKED → BLOCKED
  - DONE → DONE
  - NEED_USER → NEED_USER
  - SAFETY_STOP → SAFETY_STOP
  - BUDGET_STOP → BUDGET_STOP

- [x] Task 5.5: 实现 next_task 生成
  - 根据 coach_review 生成 next_task.md
  - 更新 task_plan.md 进度

- [ ] Task 5.6: 编写 Coach Review 测试
  - 测试 verdict 状态流转
  - 测试 next_task 生成
  - 测试 DONE/BLOCKED/NEED_USER 处理

## Phase 6: Free Mode 自动循环

- [x] Task 6.1: 实现 `devspace delegate start` 命令
  - 检查 Handoff Package 完整性
  - 检查 delegate_contract 授权
  - 创建新的 run
  - 开始自动循环

- [x] Task 6.2: 实现自动循环逻辑
  - current_task → local_report → coach_review → next_task → current_task
  - 支持 max_rounds
  - 支持 max_failures
  - 支持 max_runtime
  - 支持 max_file_changes

- [x] Task 6.3: 实现 `devspace delegate status` 命令
  - 显示当前模式
  - 显示当前状态
  - 显示当前任务
  - 显示轮数
  - 显示停止原因

- [x] Task 6.4: 实现 `devspace delegate pause` 命令
  - 暂停自动循环
  - 保存当前状态
  - 记录 conversation.jsonl

- [x] Task 6.5: 实现 `devspace delegate resume` 命令
  - 恢复自动循环
  - 从暂停点继续

- [x] Task 6.6: 实现 `devspace delegate stop` 命令
  - 停止自动循环
  - 生成 final_report.md
  - 记录 conversation.jsonl

- [x] Task 6.7: 实现 BUDGET_STOP 检测
  - 检查 max_rounds
  - 检查 max_failures
  - 检查 max_runtime
  - 检查 max_file_changes

- [ ] Task 6.8: 编写 Free Mode 测试
  - 测试自动循环
  - 测试暂停/恢复
  - 测试停止条件
  - 测试预算限制

## Phase 7: User Proxy Agent

- [x] Task 7.1: 设计 User Proxy prompt/template
  - 读取 delegate_contract
  - 读取 user_intent
  - 理解授权范围

- [x] Task 7.2: 实现 User Proxy 决策逻辑
  - 低风险任务：直接接受
  - 中风险任务：根据 contract 判断
  - 高风险任务：触发 NEED_USER

- [x] Task 7.3: 实现 User Proxy 与 Coach GPT 对话
  - 代表用户回答常规问题
  - 接受任务
  - 提交报告
  - 触发 NEED_USER

- [x] Task 7.4: 实现 decision log
  - 记录每个决策
  - 记录决策依据
  - 记录风险评估

- [ ] Task 7.5: 编写 User Proxy 测试
  - 测试低风险决策
  - 测试高风险 NEED_USER 触发
  - 测试决策日志

## Phase 8: 本地最小可视化

- [x] Task 8.1: 实现 `devspace timeline` 命令
  - 读取 conversation.jsonl
  - 格式化输出
  - 显示角色、类型、状态、标题

- [x] Task 8.2: 实现 timeline 渲染
  - [Coach GPT] Task created
  - [User Proxy] Accepted under delegate contract
  - [Local Orchestrator] Local execution started
  - [Executor] Report: PASS
  - [Coach GPT] Review: NEEDS_FIX
  - [Local Orchestrator] Fix task started
  - [Coach GPT] Review: DONE

- [x] Task 8.3: 实现状态摘要
  - 显示当前模式
  - 显示当前状态
  - 显示当前任务
  - 显示轮数
  - 显示停止原因

- [ ] Task 8.4: 编写 timeline 测试
  - 测试 conversation.jsonl 读取
  - 测试格式化输出
  - 测试状态摘要

## Phase 9: 真实集成与回归测试

- [x] Task 9.1: 替换 mock executor 为真实本地模型调用
  - 支持 Ollama
  - 支持配置化选择

- [x] Task 9.2: 与现有 DevSpace MCP 集成
  - 注册新的 MCP 工具
  - 支持远程调用

- [x] Task 9.3: 实现端到端 smoke 测试
  - Brainstorm handoff → Delegate start → local execution → coach review → next task → done

- [x] Task 9.4: 编写使用文档
  - 如何从浏览器 Web GPT 启动一个 Delegate Run
  - 如何配置停止条件
  - 如何查看 timeline

- [x] Task 9.5: 生成最终报告
  - 功能完整性
  - 测试覆盖率
  - 安全边界验证

# Task Dependencies

- Phase 0 (审计) → 已完成
- Phase 1 (协议) → 无依赖，可立即开始
- Phase 2 (Brainstorm Freeze) → 依赖 Phase 1
- Phase 3 (权限校验) → 依赖 Phase 1
- Phase 4 (Local Orchestrator) → 依赖 Phase 1, 3
- Phase 5 (Coach Review) → 依赖 Phase 4
- Phase 6 (Free Mode) → 依赖 Phase 4, 5
- Phase 7 (User Proxy) → 依赖 Phase 3, 6
- Phase 8 (可视化) → 依赖 Phase 4, 5
- Phase 9 (集成) → 依赖 Phase 1-8

# Parallelizable Work

- Phase 2 和 Phase 3 可以并行（都依赖 Phase 1）
- Phase 4 和 Phase 5 的部分工作可以并行
- Phase 7 和 Phase 8 可以并行（都依赖 Phase 4, 5, 6）
