# Delegate Mode Contract Audit & Tests Spec

## Why

Task 1-5 暂定 PARTIAL PASS，必须通过测试和契约审计后才能签收。

## What Changes

### 测试覆盖范围

1. 命令语义测试
2. Handoff 校验测试
3. Provider 抽象测试
4. User Proxy 测试
5. 模式行为测试
6. 自动循环测试
7. Coach Review 合同测试
8. Timeline 测试

### 代码修改

- 修复 devspace handoff import 无文件时报错
- 添加 devspace handoff init 命令
- 添加 Provider 类型枚举
- 修复 Coach Review 验证逻辑

## ADDED Requirements

### Requirement: 命令语义正确性
- devspace handoff init - 创建空模板
- devspace handoff import file - 从文件导入（无文件时报错）
- devspace brainstorm freeze - 从已有 conversation 冻结

### Requirement: Handoff 校验完整性
- 缺 delegate_contract.md 不能 start
- 缺 stop_conditions.md 不能 start
- 缺 first_task/current_task 不能 run

### Requirement: Provider 可插拔性
支持类型：manual/mock/ollama/openai_compatible/mcp

### Requirement: User Proxy 决策正确性
- CAN 范围内可代表用户继续
- CANNOT 范围内必须 NEED_USER
- 高风险行为必须 SAFETY_STOP 或 NEED_USER

### Requirement: 模式行为差异
- manual: 不自动执行下一轮
- guided: 执行后等待确认
- delegate: 低风险自动继续，高风险暂停
- free: 自动多轮循环，直到停止条件

### Requirement: Coach Review 合同有效性
- 缺 verdict 时视为 invalid
- next_task 必须来自 Coach Review
