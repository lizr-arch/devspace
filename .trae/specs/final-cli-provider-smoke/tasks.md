# Tasks

## Task 1: Mock Provider 真实 CLI E2E

- [ ] Task 1.1: 创建 CLI smoke test 脚本
- [ ] Task 1.2: 运行 devspace handoff init
- [ ] Task 1.3: 运行 devspace handoff import
- [ ] Task 1.4: 运行 devspace handoff validate
- [ ] Task 1.5: 运行 devspace delegate start --mode free
- [ ] Task 1.6: 运行 devspace delegate run --provider mock --max-rounds 2
- [ ] Task 1.7: 运行 devspace timeline
- [ ] Task 1.8: 验证生成文件

## Task 2: Ollama Provider failure-path CLI E2E

- [ ] Task 2.1: 运行 devspace delegate run --provider ollama --max-rounds 2 --timeout 5
- [ ] Task 2.2: 验证 final state = BLOCKED
- [ ] Task 2.3: 验证 blocked_report.md 生成
- [ ] Task 2.4: 验证不能生成 NEEDS_FIX

## Task 3: OpenAI-compatible Provider mock HTTP E2E

- [ ] Task 3.1: 创建 mock HTTP server
- [ ] Task 3.2: 测试 case A: 正常 JSON + PASS + next_task
- [ ] Task 3.3: 测试 case B: DONE
- [ ] Task 3.4: 测试 case C: 缺 verdict
- [ ] Task 3.5: 测试 case D: PASS 但缺 next_task
- [ ] Task 3.6: 测试 case E: 非法 JSON
- [ ] Task 3.7: 测试 case F: timeout

## Task 4: 输出最终 CLI Provider Smoke Report

- [ ] Task 4.1: 收集所有测试证据
- [ ] Task 4.2: 输出最终报告
