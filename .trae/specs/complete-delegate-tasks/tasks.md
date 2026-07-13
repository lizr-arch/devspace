# Tasks

## Task 7: CLI 命令语义修复

- [x] Task 7.1: 修复 devspace handoff init 命令
- [x] Task 7.2: 修复 devspace handoff import file 命令
- [x] Task 7.3: 修复 devspace brainstorm freeze 命令

## Task 8: Timeline 集成测试

- [x] Task 8.1: 创建真实 CLI smoke test 脚本
- [x] Task 8.2: 验证 timeline 显示

## Task 9: 用户文档

- [x] Task 9.1: 创建 docs/delegate-workflow.md

## Task 10: 真实 CLI smoke test

- [x] Task 10.1: 执行 devspace handoff init
- [x] Task 10.2: 执行 devspace handoff import
- [x] Task 10.3: 执行 devspace handoff validate
- [x] Task 10.4: 执行 devspace delegate start
- [x] Task 10.5: 执行 devspace delegate run --mock
- [x] Task 10.6: 执行 devspace timeline

## Task 11: 真实文件流转验证

- [x] Task 11.1: 验证 .devspace/state.json 生成
- [x] Task 11.2: 验证 .devspace/conversation.jsonl 生成
- [x] Task 11.3: 验证 .devspace/ceo/delegate_contract.md 生成
- [x] Task 11.4: 验证 .devspace/ceo/stop_conditions.md 生成
- [x] Task 11.5: 验证 .devspace/runs/ 目录生成

## Task 12: no-fabrication 测试

- [x] Task 12.1: 测试 Orchestrator 不能自己生成 next_task
- [x] Task 12.2: 测试 next_task 必须来自 Coach Review Provider
- [x] Task 12.3: 测试 Coach Review 缺 verdict 必须失败
- [x] Task 12.4: 测试 PASS 但没有 next_task 时必须 BLOCKED 或 NEED_USER
