# Provider E2E Evidence Spec

## Why

当前 Provider E2E 只有接口和构建验证，没有真实运行证据。需要修正 Provider 返回格式校验、服务不可用行为，并提供真实 E2E 测试证据。

## What Changes

### 1. 修正 Provider 返回格式校验
- 缺 verdict 必须视为 invalid response
- 不允许默认 NEEDS_FIX
- invalid response 必须进入 BLOCKED 或 NEED_USER

### 2. 修正服务不可用行为
- Ollama / OpenAI endpoint 不可用时不能返回 NEEDS_FIX
- 应返回 PROVIDER_UNAVAILABLE / BLOCKED
- Free Mode 必须停止

### 3. 真实运行 Mock Provider E2E
- 验证 local_report.md、coach_review.md、next_task.md 或 final_report.md

### 4. 真实运行 Ollama Provider E2E
- 如果服务不存在，必须优雅 BLOCKED

### 5. OpenAI-compatible Provider E2E
- 用 mock HTTP server 测试各种场景

### 6. 强化 next_task 合同
- next_action 不能作为可执行任务
- next_task 必须来自 CoachReviewProvider

## ADDED Requirements

### Requirement: Provider 返回格式校验
- 缺 verdict 必须 BLOCKED 或 NEED_USER
- 不允许默认 NEEDS_FIX

### Requirement: 服务不可用行为
- 服务不可用时必须 BLOCKED
- Free Mode 必须停止

### Requirement: next_task 合同
- next_task 必须来自 CoachReviewProvider
- Orchestrator 不能自己编写任务
