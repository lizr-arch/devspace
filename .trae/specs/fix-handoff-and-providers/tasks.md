# Tasks

## Task 1: 修复 handoff 命令语义

- [x] Task 1.1: 修改 runHandoffCommand 添加 init 子命令
- [x] Task 1.2: 实现 runHandoffInit 只创建空模板
- [x] Task 1.3: 修改 runHandoffImport 无文件时报错
- [x] Task 1.4: 更新帮助文档

## Task 2: 加强 no-fabrication 规则

- [x] Task 2.1: 修改 orchestrator_v2.ts 的 next_task 生成逻辑
- [x] Task 2.2: next_task 必须来自 CoachReviewProvider
- [x] Task 2.3: PASS 但没有 next_task 时必须 BLOCKED 或 NEED_USER
- [x] Task 2.4: 添加 no-fabrication 集成测试

## Task 3: Ollama Provider 集成

- [x] Task 3.1: 完善 OllamaExecutorProvider
- [x] Task 3.2: 完善 OllamaCoachReviewProvider
- [x] Task 3.3: 添加 Provider failure 测试

## Task 4: OpenAI-compatible Provider

- [x] Task 4.1: 创建 OpenAICompatibleProvider
- [x] Task 4.2: 支持配置 API URL 和 key

## Task 5: Provider E2E 测试

- [x] Task 5.1: 测试 delegate run --provider ollama
- [x] Task 5.2: 测试 Provider failure 场景
- [x] Task 5.3: 测试服务不可用、返回非法 JSON、超时、缺 verdict、缺 next_task

## Task 6: 集成测试

- [x] Task 6.1: 运行真实 CLI 命令
- [x] Task 6.2: 验证文件生成
- [x] Task 6.3: 输出测试报告
