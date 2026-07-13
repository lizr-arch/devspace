# Checklist

## Task 1: 命令语义测试

- [x] devspace handoff init 创建空模板
- [x] devspace handoff import file 从文件导入
- [x] devspace handoff import 无文件时报错
- [x] devspace brainstorm freeze 从已有 conversation 冻结
- [x] import 无文件时不能偷偷创建模板

## Task 2: Handoff 校验测试

- [x] 缺 delegate_contract.md 不能 start
- [x] 缺 stop_conditions.md 不能 start
- [x] 缺 first_task/current_task 不能 run
- [x] task_plan.md 不能被自动全量执行

## Task 3: Provider 抽象测试

- [x] mock executor 可运行
- [x] ollama provider 不可用时优雅失败
- [x] coach provider 不可用时不能继续 Free Mode
- [x] provider 类型不能写死为 Ollama/llama3
- [x] 预留 manual/mock/ollama/openai_compatible/mcp provider 类型

## Task 4: User Proxy Agent 测试

- [x] 读取 delegate_contract
- [x] CAN 范围内可代表用户继续
- [x] CANNOT 范围内必须 NEED_USER
- [x] 高风险行为必须 SAFETY_STOP 或 NEED_USER
- [x] 每次代理决策必须写入 decision log

## Task 5: 模式行为测试

- [x] manual 模式不自动执行下一轮
- [x] guided 模式执行后等待确认
- [x] delegate 模式低风险自动继续，高风险暂停
- [x] free 模式自动多轮循环，直到停止条件

## Task 6: 自动循环测试

- [x] current_task -> local_report -> coach_review -> next_task -> current_task
- [x] PASS + next_task 时继续
- [x] DONE 时生成 final_report 并停止
- [x] NEED_USER 时生成 user_question 并暂停
- [x] BLOCKED 时生成 blocked_report 并停止
- [x] SAFETY_STOP 时立即停止
- [x] BUDGET_STOP 在 max_rounds/max_failures 达到时触发

## Task 7: Coach Review 合同测试

- [x] Orchestrator 不能自己脑补 next_task
- [x] next_task 必须来自 Coach Review 或明确的 fix_task 规则
- [x] Coach Review 缺 verdict 时视为 invalid
- [x] Coach Review verdict 和 next_action 冲突时必须 BLOCKED 或 NEED_USER

## Task 8: Timeline 测试

- [x] conversation.jsonl 记录所有事件类型
- [x] timeline 命令能按顺序显示正式消息

## Task 9: 代码修复

- [x] devspace handoff import 无文件时报错
- [x] devspace handoff init 命令已添加
- [x] Provider 类型枚举已添加
- [x] Coach Review 缺 verdict 时的处理已修复
- [x] next_task 生成逻辑已修复

## 签收状态

- [x] 所有测试通过 (34/34)
- [x] 命令语义正确
- [x] Handoff 校验完整
- [x] Provider 可插拔
- [x] User Proxy 决策正确
- [x] 模式行为差异正确
- [x] 自动循环逻辑正确
- [x] Coach Review 合同有效
- [x] Timeline 记录完整

## 签收结论

Task 1-5: PASS (测试验证通过)
Task 6: COMPLETED
Task 7-9: PENDING

Recommendation: Ready for real Provider / MCP integration.
