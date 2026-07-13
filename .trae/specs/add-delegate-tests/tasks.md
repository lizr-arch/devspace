# Tasks

## Task 1: 命令语义测试

- [x] Task 1.1: 测试 devspace handoff init
- [x] Task 1.2: 测试 devspace handoff import file
- [x] Task 1.3: 测试 devspace brainstorm freeze
- [x] Task 1.4: 测试 import 无文件时的行为

## Task 2: Handoff 校验测试

- [x] Task 2.1: 测试缺 delegate_contract.md 不能 start
- [x] Task 2.2: 测试缺 stop_conditions.md 不能 start
- [x] Task 2.3: 测试缺 first_task/current_task 不能 run
- [x] Task 2.4: 测试 task_plan.md 不能被自动全量执行

## Task 3: Provider 抽象测试

- [x] Task 3.1: 测试 mock executor 可运行
- [x] Task 3.2: 测试 ollama provider 不可用时优雅失败
- [x] Task 3.3: 测试 coach provider 不可用时不能继续 Free Mode
- [x] Task 3.4: 测试 provider 类型不能写死为 Ollama/llama3
- [x] Task 3.5: 预留 manual/mock/ollama/openai_compatible/mcp provider 类型

## Task 4: User Proxy Agent 测试

- [x] Task 4.1: 测试读取 delegate_contract
- [x] Task 4.2: 测试 CAN 范围内可代表用户继续
- [x] Task 4.3: 测试 CANNOT 范围内必须 NEED_USER
- [x] Task 4.4: 测试高风险行为必须 SAFETY_STOP 或 NEED_USER
- [x] Task 4.5: 测试每次代理决策必须写入 decision log

## Task 5: 模式行为测试

- [x] Task 5.1: 测试 manual 模式不自动执行下一轮
- [x] Task 5.2: 测试 guided 模式执行后等待确认
- [x] Task 5.3: 测试 delegate 模式低风险自动继续，高风险暂停
- [x] Task 5.4: 测试 free 模式自动多轮循环，直到停止条件

## Task 6: 自动循环测试

- [x] Task 6.1: 测试 current_task -> local_report -> coach_review -> next_task
- [x] Task 6.2: 测试 PASS + next_task 时继续
- [x] Task 6.3: 测试 DONE 时生成 final_report 并停止
- [x] Task 6.4: 测试 NEED_USER 时生成 user_question 并暂停
- [x] Task 6.5: 测试 BLOCKED 时生成 blocked_report 并停止
- [x] Task 6.6: 测试 SAFETY_STOP 时立即停止
- [x] Task 6.7: 测试 BUDGET_STOP 在 max_rounds/max_failures 达到时触发

## Task 7: Coach Review 合同测试

- [x] Task 7.1: 测试 Orchestrator 不能自己脑补 next_task
- [x] Task 7.2: 测试 next_task 必须来自 Coach Review
- [x] Task 7.3: 测试 Coach Review 缺 verdict 时视为 invalid
- [x] Task 7.4: 测试 Coach Review verdict 和 next_action 冲突时必须 BLOCKED 或 NEED_USER

## Task 8: Timeline 测试

- [x] Task 8.1: 测试 conversation.jsonl 记录所有事件类型
- [x] Task 8.2: 测试 timeline 命令能按顺序显示正式消息

## Task 9: 代码修复

- [x] Task 9.1: 修复 devspace handoff import 无文件时报错
- [x] Task 9.2: 添加 devspace handoff init 命令
- [x] Task 9.3: 添加 Provider 类型枚举
- [x] Task 9.4: 修复 Coach Review 缺 verdict 时的处理
- [x] Task 9.5: 修复 next_task 生成逻辑
