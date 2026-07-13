# Tasks

## Task 1: 修复 exit code 语义

- [ ] Task 1.1: 修改 handoff validate 失败时 exit 1
- [ ] Task 1.2: 修改 delegate start aborted 时 exit 1
- [ ] Task 1.3: 修改 delegate run 前置状态非法时 exit 1

## Task 2: 修复 handoff init 模板

- [ ] Task 2.1: 修复 delegate_contract.md 模板格式
- [ ] Task 2.2: 修复 stop_conditions.md 模板格式
- [ ] Task 2.3: 修复 autonomy_policy.md 模板格式

## Task 3: 修复 provider smoke 前置状态

- [ ] Task 3.1: 修改测试使用 --mode free
- [ ] Task 3.2: 确保不停留在 manual mode

## Task 4: Mock Provider 真实 CLI E2E

- [ ] Task 4.1: 运行 devspace delegate run --provider mock --max-rounds 2
- [ ] Task 4.2: 验证 mock executor 被调用
- [ ] Task 4.3: 验证 local_report.md 由 CLI 生成
- [ ] Task 4.4: 验证 coach_review.md 由 CLI 生成
- [ ] Task 4.5: 验证 final state 不是 BRAINSTORM

## Task 5: Ollama failure-path 真实 CLI E2E

- [ ] Task 5.1: 运行 devspace delegate run --provider ollama --max-rounds 2 --timeout 5
- [ ] Task 5.2: 验证 final state = BLOCKED
- [ ] Task 5.3: 验证 blocked_report.md 生成
- [ ] Task 5.4: 验证 conversation.jsonl 记录 provider_error

## Task 6: OpenAI-compatible Provider mock HTTP E2E

- [ ] Task 6.1: 创建 mock HTTP server
- [ ] Task 6.2: 测试正常 JSON + PASS + next_task
- [ ] Task 6.3: 测试 DONE
- [ ] Task 6.4: 测试缺 verdict
- [ ] Task 6.5: 测试 PASS 但缺 next_task
- [ ] Task 6.6: 测试非法 JSON
- [ ] Task 6.7: 测试 timeout

## Task 7: Smoke test 断言升级

- [ ] Task 7.1: 断言 stdout 不包含 Validation Failed
- [ ] Task 7.2: 断言 stdout 不包含 Delegate start aborted
- [ ] Task 7.3: 断言 stdout 不包含 Manual mode: waiting
- [ ] Task 7.4: 断言 final status 不是 BRAINSTORM
- [ ] Task 7.5: 断言 run 目录下存在 local_report.md 和 coach_review.md

## Task 8: 重新运行 Final CLI Provider Smoke

- [ ] Task 8.1: 运行完整测试
- [ ] Task 8.2: 输出最终报告
