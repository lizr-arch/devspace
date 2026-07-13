# Checklist

## Task 1: Mock Provider 真实 CLI E2E

- [ ] CLI smoke test 脚本创建
- [ ] devspace handoff init 运行成功
- [ ] devspace handoff import 运行成功
- [ ] devspace handoff validate 运行成功
- [ ] devspace delegate start 运行成功
- [ ] devspace delegate run 运行成功
- [ ] devspace timeline 运行成功
- [ ] 生成文件验证通过

## Task 2: Ollama Provider failure-path CLI E2E

- [ ] Ollama Provider 运行
- [ ] final state = BLOCKED
- [ ] blocked_report.md 生成
- [ ] 不能生成 NEEDS_FIX

## Task 3: OpenAI-compatible Provider mock HTTP E2E

- [ ] mock HTTP server 创建
- [ ] case A: 正常 JSON + PASS + next_task 通过
- [ ] case B: DONE 通过
- [ ] case C: 缺 verdict 通过
- [ ] case D: PASS 但缺 next_task 通过
- [ ] case E: 非法 JSON 通过
- [ ] case F: timeout 通过

## Task 4: 输出报告

- [ ] 所有测试证据收集
- [ ] 最终报告输出

## 签收条件

- [ ] 所有任务完成
- [ ] 所有测试通过
- [ ] 可以进入 MCP 集成
