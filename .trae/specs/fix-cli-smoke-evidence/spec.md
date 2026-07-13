# Fix CLI Smoke Evidence Spec

## Why

Final CLI Provider Smoke 测试存在多个严重问题：
1. exit code 语义错误
2. handoff init 模板格式不合法
3. provider smoke 前置状态停留在 manual mode
4. Mock Provider 没有真正执行
5. Ollama failure-path 没有真正测试
6. OpenAI-compatible Provider 被跳过

## What Changes

### A. 修复 exit code 语义
- handoff validate 失败必须 exit 1
- delegate start aborted 必须 exit 1
- delegate run 因前置状态非法而无法执行时必须 exit 1

### B. 修复 handoff init 模板
- delegate_contract.md 必须是合法格式
- stop_conditions.md 必须是合法格式
- autonomy_policy.md 必须明确默认模式

### C. 修复 provider smoke 前置状态
- 测试必须进入 delegate 或 free 模式
- 不允许停在 manual mode

### D. Mock Provider 真实 CLI E2E
- mock executor 被调用
- mock coach provider 被调用
- local_report.md 由 CLI 生成
- coach_review.md 由 CLI 生成
- next_task.md 或 final_report.md 由 CLI 生成

### E. Ollama failure-path 必须真正走到 Ollama Provider
- 当 Ollama 服务不可用时 final state = BLOCKED

### F. OpenAI-compatible Provider 必须做 mock HTTP server E2E

### G. Smoke test 断言必须升级
- final status 不能是 BRAINSTORM
- provider_called = true
- run 目录下存在 local_report.md 和 coach_review.md

## ADDED Requirements

### Requirement: Exit Code 语义
- validation failed 必须 exit 1
- start aborted 必须 exit 1
- 只有真正成功执行才 exit 0

### Requirement: Provider 真实执行
- Mock Provider 必须真正执行
- Ollama Provider 必须真正尝试连接
- 不允许因为 manual mode 提前暂停
