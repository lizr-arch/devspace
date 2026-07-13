# Checklist

## Task 1: 修正 Provider 返回格式校验

- [ ] 缺 verdict 时返回 BLOCKED 或 NEED_USER
- [ ] 不允许默认 NEEDS_FIX
- [ ] provider_error 记录到 conversation.jsonl

## Task 2: 修正服务不可用行为

- [ ] Ollama 服务不可用时返回 BLOCKED
- [ ] OpenAI 服务不可用时返回 BLOCKED
- [ ] Free Mode 停止

## Task 3: 真实运行 Mock Provider E2E

- [ ] devspace delegate run --provider mock --max-rounds 2 运行成功
- [ ] local_report.md 生成
- [ ] coach_review.md 生成
- [ ] next_task.md 或 final_report.md 生成

## Task 4: 真实运行 Ollama Provider E2E

- [ ] Ollama Provider 测试运行
- [ ] 失败场景验证

## Task 5: OpenAI-compatible Provider E2E

- [ ] mock HTTP server 创建
- [ ] 正常 JSON + next_task 测试通过
- [ ] DONE verdict 测试通过
- [ ] 缺 verdict 测试通过
- [ ] PASS 但缺 next_task 测试通过
- [ ] 非法 JSON 测试通过
- [ ] timeout 测试通过

## Task 6: 强化 next_task 合同

- [ ] next_action 不能作为可执行任务
- [ ] next_task 必须来自 CoachReviewProvider
- [ ] PASS 但没有 next_task 时必须 BLOCKED

## Task 7: 输出报告

- [ ] 所有测试证据收集
- [ ] 最终报告输出

## 签收条件

- [ ] 所有任务完成
- [ ] 所有测试通过
- [ ] 可以进入 MCP 集成
