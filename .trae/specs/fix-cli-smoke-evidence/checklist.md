# Checklist

## Task 1: 修复 exit code 语义

- [ ] handoff validate 失败时 exit 1
- [ ] delegate start aborted 时 exit 1
- [ ] delegate run 前置状态非法时 exit 1

## Task 2: 修复 handoff init 模板

- [ ] delegate_contract.md 模板格式合法
- [ ] stop_conditions.md 模板格式合法
- [ ] autonomy_policy.md 模板格式合法

## Task 3: 修复 provider smoke 前置状态

- [ ] 测试使用 --mode free
- [ ] 不停留在 manual mode

## Task 4: Mock Provider 真实 CLI E2E

- [ ] mock executor 被调用
- [ ] local_report.md 由 CLI 生成
- [ ] coach_review.md 由 CLI 生成
- [ ] final state 不是 BRAINSTORM

## Task 5: Ollama failure-path 真实 CLI E2E

- [ ] final state = BLOCKED
- [ ] blocked_report.md 生成
- [ ] conversation.jsonl 记录 provider_error

## Task 6: OpenAI-compatible Provider mock HTTP E2E

- [ ] 正常 JSON + PASS + next_task 通过
- [ ] DONE 通过
- [ ] 缺 verdict 通过
- [ ] PASS 但缺 next_task 通过
- [ ] 非法 JSON 通过
- [ ] timeout 通过

## Task 7: Smoke test 断言升级

- [ ] stdout 不包含 Validation Failed
- [ ] stdout 不包含 Delegate start aborted
- [ ] stdout 不包含 Manual mode: waiting
- [ ] final status 不是 BRAINSTORM
- [ ] run 目录下存在 local_report.md 和 coach_review.md

## Task 8: 重新运行测试

- [ ] 完整测试运行
- [ ] 最终报告输出

## 签收条件

- [ ] 所有任务完成
- [ ] 所有测试通过
- [ ] 可以进入 MCP 集成
