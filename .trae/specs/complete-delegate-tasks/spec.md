# Complete Delegate Tasks & Real CLI Tests Spec

## Why

Task 6 Contract Audit PASS，但 Task 7-9 仍 PENDING。需要完成：
1. CLI 命令语义修复
2. Timeline 集成测试
3. 用户文档
4. 真实 CLI smoke test
5. 真实文件流转验证
6. no-fabrication 测试

## What Changes

### Task 7: CLI 命令语义修复
- `devspace handoff init` - 只创建空模板
- `devspace handoff import <file>` - 必须导入文件
- `devspace handoff import` 不带文件必须报错
- `devspace brainstorm freeze` - 只能从已有 conversation 冻结

### Task 8: Timeline 集成测试
- 通过真实命令产生 timeline
- 验证 Coach task、User Proxy decision、Local report、Coach review、状态变更

### Task 9: 用户文档
- Browser Web GPT Brainstorm → handoff import → delegate start → delegate run
- 四种模式的真实使用方式
- NEED_USER / SAFETY_STOP / BUDGET_STOP 处理

### 真实 CLI smoke test
- devspace handoff init
- devspace handoff import ./fixture_handoff.md
- devspace handoff validate
- devspace delegate start --mode delegate
- devspace delegate run --mock --max-rounds 2
- devspace timeline

### 真实文件流转验证
- .devspace/state.json
- .devspace/conversation.jsonl
- .devspace/ceo/delegate_contract.md
- .devspace/ceo/stop_conditions.md
- .devspace/runs/run-xxx/local_report.md
- .devspace/runs/run-xxx/coach_review.md

### no-fabrication 测试
- Orchestrator 不能自己生成 next_task
- next_task 必须来自 Coach Review Provider
- Coach Review 缺 verdict 必须失败
- PASS 但没有 next_task 且未 DONE 时必须 BLOCKED 或 NEED_USER

## ADDED Requirements

### Requirement: CLI 命令语义正确性
- `devspace handoff init` 只创建空模板
- `devspace handoff import <file>` 必须导入文件
- `devspace handoff import` 不带文件必须报错

### Requirement: Timeline 集成完整性
- 通过真实命令产生 timeline
- timeline 显示所有关键事件

### Requirement: 用户文档完整性
- 文档覆盖四种模式
- 文档说明停止条件处理

### Requirement: 真实 CLI smoke test
- 所有命令真实执行
- 文件真实生成

### Requirement: no-fabrication 合同
- Orchestrator 不能自己生成 next_task
- next_task 必须来自 Coach Review Provider
