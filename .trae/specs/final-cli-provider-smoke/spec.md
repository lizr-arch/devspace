# Final CLI Provider Smoke Test Spec

## Why

需要补一个最终 CLI Provider smoke test，不允许手动创建 run 文件来模拟结果。必须证明文件是 CLI 自动生成。

## What Changes

### 1. Mock Provider 真实 CLI E2E
在 clean temp workspace 中运行：
- devspace handoff init
- devspace handoff import tests/fixtures/fixture_handoff.md
- devspace handoff validate
- devspace delegate start --mode free
- devspace delegate run --provider mock --max-rounds 2
- devspace timeline

必须证明文件是 CLI 自动生成。

### 2. Ollama Provider failure-path CLI E2E
在 Ollama 不可用时运行：
- devspace delegate run --provider ollama --max-rounds 2 --timeout 5
- 预期 final state = BLOCKED
- blocked_report.md 生成
- 不能生成 NEEDS_FIX

### 3. OpenAI-compatible Provider mock HTTP E2E
启动本地 mock HTTP server，模拟各种场景。

### 4. 输出最终 CLI Provider Smoke Report

## ADDED Requirements

### Requirement: 真实 CLI 链路证据
- 文件必须由 CLI 自动生成
- 不允许手动创建 run 文件

### Requirement: Provider failure-path
- Ollama 不可用时必须 BLOCKED
- 不能生成 NEEDS_FIX
