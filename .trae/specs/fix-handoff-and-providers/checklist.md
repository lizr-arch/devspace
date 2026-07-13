# Checklist

## Task 1: 修复 handoff 命令语义

- [x] devspace handoff init 只创建空模板
- [x] devspace handoff import file 导入文件
- [x] devspace handoff import 无文件报错
- [x] 帮助文档更新

## Task 2: 加强 no-fabrication 规则

- [x] Orchestrator 不能自己编写 next_task
- [x] next_task 必须来自 CoachReviewProvider
- [x] PASS 但没有 next_task 时必须 BLOCKED 或 NEED_USER
- [x] no-fabrication 集成测试通过

## Task 3: Ollama Provider 集成

- [x] OllamaExecutorProvider 可用
- [x] OllamaCoachReviewProvider 可用
- [x] Provider failure 测试通过

## Task 4: OpenAI-compatible Provider

- [x] OpenAICompatibleProvider 创建
- [x] 支持配置 API URL 和 key

## Task 5: Provider E2E 测试

- [x] delegate run --provider ollama 测试通过
- [x] Provider failure 场景测试通过

## Task 6: 集成测试

- [x] 真实 CLI 命令运行成功
- [x] 文件生成验证通过
- [x] 测试报告输出

## 测试结果

- Contract Audit: 34/34 PASS
- CLI Smoke: 14/14 PASS

## 签收条件

- [x] 所有任务完成
- [x] 所有测试通过
- [x] 可以进入 MCP 集成阶段
