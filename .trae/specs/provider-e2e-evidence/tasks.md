# Tasks

## Task 1: 修正 Provider 返回格式校验

- [ ] Task 1.1: 修改 validateCoachReview 缺 verdict 时返回 false
- [ ] Task 1.2: 修改 Provider 缺 verdict 时返回 BLOCKED
- [ ] Task 1.3: 添加 provider_error 状态到 conversation.jsonl

## Task 2: 修正服务不可用行为

- [ ] Task 2.1: 修改 Ollama Provider 服务不可用时返回 BLOCKED
- [ ] Task 2.2: 修改 OpenAI Provider 服务不可用时返回 BLOCKED
- [ ] Task 2.3: Free Mode 必须停止

## Task 3: 真实运行 Mock Provider E2E

- [ ] Task 3.1: 运行 devspace delegate run --provider mock --max-rounds 2
- [ ] Task 3.2: 验证生成文件

## Task 4: 真实运行 Ollama Provider E2E

- [ ] Task 4.1: 运行 Ollama Provider 测试
- [ ] Task 4.2: 验证失败场景

## Task 5: OpenAI-compatible Provider E2E

- [ ] Task 5.1: 创建 mock HTTP server
- [ ] Task 5.2: 测试正常 JSON + next_task
- [ ] Task 5.3: 测试 DONE verdict
- [ ] Task 5.4: 测试缺 verdict
- [ ] Task 5.5: 测试 PASS 但缺 next_task
- [ ] Task 5.6: 测试非法 JSON
- [ ] Task 5.7: 测试 timeout

## Task 6: 强化 next_task 合同

- [ ] Task 6.1: 验证 next_action 不能作为可执行任务
- [ ] Task 6.2: 验证 next_task 必须来自 CoachReviewProvider
- [ ] Task 6.3: 验证 PASS 但没有 next_task 时必须 BLOCKED

## Task 7: 输出 Provider E2E Evidence Report

- [ ] Task 7.1: 收集所有测试证据
- [ ] Task 7.2: 输出最终报告
