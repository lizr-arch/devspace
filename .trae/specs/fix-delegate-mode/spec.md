# Fix Delegate Mode Spec

## Why

当前 Delegate Mode 实现存在以下问题：
1. `brainstorm freeze` 创建空模板，应该区分 init / import / freeze
2. 缺少 handoff import / validate / show 命令
3. Coach Review 只能手写，缺少 Provider 抽象
4. User Proxy Agent 不完整
5. delegate/free 自动循环未实现
6. `run current` 只是单步执行，不是真正的 Free Mode
7. 写死了 Ollama/llama3，缺少 executor provider 抽象
8. 四种模式没有不同行为
9. task_plan.md 可能被自动全量执行
10. 停止条件检查不完整

## What Changes

### 命令重构
- `devspace init` - 初始化空模板
- `devspace handoff import <file>` - 从文件导入 Brainstorm 结果
- `devspace handoff validate` - 校验 Handoff Package
- `devspace handoff show` - 显示 Handoff Package 内容
- `devspace delegate run` - 启动自动循环（替代 `run current`）

### Provider 抽象
- ExecutorProvider - 本地模型调用抽象
- CoachReviewProvider - Coach Review 生成抽象
- 支持 Ollama、OpenAI、Mock 等多种实现

### 模式行为差异
- Manual: 每一步都需要用户确认
- Guided: Coach 布置任务，用户确认执行
- Delegate: User Proxy 自动执行，NEED_USER 时暂停
- Free: 连续自动执行，达到停止条件时停止

### 自动循环
- `devspace delegate run` 启动真正的自动循环
- current_task → local_report → coach_review → next_task → current_task
- 只执行 current_task.md，不自动执行 task_plan.md

### 停止条件
- DONE: 所有验收标准满足
- BLOCKED: 外部条件缺失
- NEED_USER: 需要用户决策
- SAFETY_STOP: 检测到高风险操作
- BUDGET_STOP: 达到预算上限

## Impact

- Affected code:
  - `src/cli.ts` - 命令重构
  - `src/delegate/orchestrator.ts` - Provider 抽象
  - `src/delegate/free_mode.ts` - 自动循环
  - `src/delegate/permissions.ts` - 模式行为差异
  - 新增 `src/delegate/providers/` - Provider 实现

## ADDED Requirements

### Requirement: 命令分离
系统 SHALL 提供分离的命令：
- `devspace init` - 创建空模板
- `devspace handoff import <file>` - 从文件导入
- `devspace handoff validate` - 校验
- `devspace handoff show` - 显示

### Requirement: Provider 抽象
系统 SHALL 支持多种 Executor 和 Coach Review Provider：
- MockProvider - 用于测试
- OllamaProvider - 调用本地 Ollama
- OpenAIProvider - 调用 OpenAI API

### Requirement: 模式行为差异
系统 SHALL 根据模式执行不同行为：
- Manual: 每步暂停等待用户
- Guided: 显示任务等待确认
- Delegate: User Proxy 自动决策
- Free: 连续自动执行

### Requirement: 自动循环
系统 SHALL 通过 `devspace delegate run` 启动自动循环：
- 只执行 current_task.md
- 执行后生成 local_report
- Coach Review 后生成 next_task
- 循环直到停止条件

### Requirement: 停止条件检查
系统 SHALL 在每个循环检查停止条件：
- 检查 DONE 条件
- 检查 BLOCKED 条件
- 检查 NEED_USER 条件
- 检查 SAFETY_STOP 条件
- 检查 BUDGET_STOP 条件

## MODIFIED Requirements

### Requirement: Local Orchestrator
Local Orchestrator SHALL 使用 Provider 抽象调用本地模型，不再写死 Ollama。

### Requirement: Free Mode
Free Mode SHALL 通过 `devspace delegate run` 启动真正的自动循环。

## REMOVED Requirements

### Requirement: brainstorm freeze
**Reason**: 命令语义不清晰
**Migration**: 使用 `devspace init` + `devspace handoff import`

### Requirement: devspace run current
**Reason**: 只是单步执行，不是真正的 Delegate Mode
**Migration**: 使用 `devspace delegate run`
