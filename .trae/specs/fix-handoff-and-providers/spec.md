# Fix Handoff Semantics & Real Provider Integration Spec

## Why

需要修复 handoff init/import 语义，并进入真实 Provider 集成阶段。

## What Changes

### 1. 修复 handoff 命令语义
- `devspace handoff init` - 只创建空模板
- `devspace handoff import <file>` - 只导入 Web GPT handoff 文件
- `import` 不带文件必须报错
- `runHandoffCommand` 必须明确列出 init/import/validate/show

### 2. 加强 no-fabrication 规则
- Orchestrator 不能自己编写 next_task
- next_task 内容必须来自 CoachReviewProvider 的显式输出
- PASS 但 Coach 没有提供 next_task 且未 DONE 时，必须 BLOCKED 或 NEED_USER

### 3. 真实 Provider 集成
- A. Ollama Executor Provider
- B. Ollama Coach Review Provider
- C. OpenAI-compatible Coach Provider
- D. Provider E2E 测试
- E. Provider failure tests

## ADDED Requirements

### Requirement: handoff 命令语义
- `devspace handoff init` 只创建空模板
- `devspace handoff import <file>` 只导入文件
- `import` 不带文件必须报错

### Requirement: no-fabrication 规则
- Orchestrator 不能自己编写 next_task
- next_task 必须来自 CoachReviewProvider
- PASS 但没有 next_task 且未 DONE 时必须 BLOCKED 或 NEED_USER

### Requirement: Provider 集成
- Ollama Executor Provider 可用
- Ollama Coach Review Provider 可用
- OpenAI-compatible Coach Provider 可用
- Provider failure 优雅处理