# Tasks

## Phase 1: 共享工作区协议

- [x] Task 1: 创建 `.devspace/` 目录结构
  - [x] SubTask 1.1: 创建目录初始化脚本 `scripts/init-collab.sh`
  - [x] SubTask 1.2: 定义标准目录结构（context.md, current_task.md, execution_report.md, review.md, decision.md, next_task.md）
  - [x] SubTask 1.3: 添加 `.gitkeep` 文件确保空目录被提交

- [x] Task 2: 定义任务模板格式
  - [x] SubTask 2.1: 创建任务模板 `templates/task_template.md`
  - [x] SubTask 2.2: 定义必填字段（任务ID、目标、允许修改范围、禁止修改范围、验收标准、测试命令、报告格式、失败处理）
  - [x] SubTask 2.3: 创建任务解析器 `src/collaboration/task_parser.ts`

- [x] Task 3: 定义执行报告模板
  - [x] SubTask 3.1: 创建报告模板 `templates/execution_report_template.md`
  - [x] SubTask 3.2: 定义必填字段（修改文件列表、测试结果、git diff、遇到的问题、未完成部分）
  - [x] SubTask 3.3: 创建报告生成器 `src/collaboration/report_generator.ts`

- [x] Task 4: 定义审核模板
  - [x] SubTask 4.1: 创建审核模板 `templates/review_template.md`
  - [x] SubTask 4.2: 定义审核结果类型（通过/有条件通过/不通过）
  - [x] SubTask 4.3: 创建审核解析器 `src/collaboration/review_parser.ts`

- [x] Task 5: 创建示例任务文件
  - [x] SubTask 5.1: 创建示例 `.devspace/current_task.md`
  - [x] SubTask 5.2: 创建示例 `.devspace/execution_report.md`
  - [x] SubTask 5.3: 创建示例 `.devspace/review.md`

## Phase 2: 本地 Orchestrator

- [x] Task 6: 创建 `devspace_worker.py` 主脚本
  - [x] SubTask 6.1: 实现任务发现逻辑（检查 current_task.md 状态）
  - [x] SubTask 6.2: 实现 Ollama API 调用（curl http://localhost:11434/api/generate）
  - [x] SubTask 6.3: 实现代码修改应用（git apply 或直接写入）
  - [x] SubTask 6.4: 实现测试运行器（执行任务中指定的测试命令）
  - [x] SubTask 6.5: 实现执行报告生成（写入 execution_report.md）
  - [x] SubTask 6.6: 实现状态更新（更新 current_task.md 状态）

- [x] Task 7: 实现边界检查机制
  - [x] SubTask 7.1: 解析任务中的"允许修改范围"和"禁止修改范围"
  - [x] SubTask 7.2: 在代码修改前检查文件是否在允许范围内
  - [x] SubTask 7.3: 越权时拒绝修改并记录错误

- [x] Task 8: 实现超时和失败处理
  - [x] SubTask 8.1: 设置单任务最大执行时间（30分钟）
  - [x] SubTask 8.2: 测试失败时自动重试1次
  - [x] SubTask 8.3: 重试仍失败时标记为"需要人工介入"

- [x] Task 9: 创建配置文件
  - [x] SubTask 9.1: 创建 `devspace_worker_config.yaml`
  - [x] SubTask 9.2: 定义配置项（Ollama URL、模型名称、轮询间隔、超时时间）

## Phase 3: C-lite 队列

- [x] Task 10: 实现 JSONL 事件流
  - [x] SubTask 10.1: 定义事件类型（TASK_CREATED, LOCAL_STARTED, TEST_PASSED, REPORT_READY, REVIEW_APPROVED 等）
  - [x] SubTask 10.2: 实现事件记录器（在 devspace_worker.py 中的 EventLogger 类）
  - [x] SubTask 10.3: 在关键节点自动记录事件

- [x] Task 11: 实现状态文件管理
  - [x] SubTask 11.1: 创建 `state.json` 结构定义
  - [x] SubTask 11.2: 实现状态读写工具（在 devspace_worker.py 中的 DevSpaceWorker 类）
  - [x] SubTask 11.3: 实现任务队列（active_tasks, completed_tasks, blocked_tasks）

- [x] Task 12: 实现任务历史归档
  - [x] SubTask 12.1: 创建 `task_history/` 目录
  - [x] SubTask 12.2: 已完成任务自动归档到 `task_history/YYYY-MM-DD_task-id.md`
  - [x] SubTask 12.3: 保留最近10个任务在主目录

## 集成和测试

- [x] Task 13: 集成到 DevSpace CLI
  - [x] SubTask 13.1: 修改 `src/cli.ts` 添加 `collab` 子命令
    - 添加 `collab` 命令到 Command 类型定义
    - 在 normalizeCommand 函数中添加 collab 识别
    - 在 main 函数的 switch 中添加 collab case
  - [x] SubTask 13.2: 实现 `devspace collab init` 命令
    - 调用 scripts/init-collab.sh 脚本
    - 或直接在 TypeScript 中实现初始化逻辑
    - 创建 .devspace/ 目录结构
    - 从 templates/ 复制模板文件
  - [x] SubTask 13.3: 实现 `devspace collab status` 命令
    - 读取 .devspace/state.json
    - 读取 .devspace/current_task.md 的状态
    - 显示当前任务状态、活跃任务、已完成任务
    - 显示事件流的最近记录
  - [x] SubTask 13.4: 实现 `devspace worker start` 命令
    - 检查 Python 环境是否可用
    - 检查 devspace_worker.py 是否存在
    - 启动 Python 子进程运行 worker
    - 支持 --config 参数指定配置文件
    - 支持 Ctrl+C 优雅停止

- [x] Task 14: 编写文档
  - [x] SubTask 14.1: 创建 `docs/collaboration-workflow.md`
    - 介绍异步协作工作流的概念
    - 角色定义（Web GPT = CEO，本地模型 = 工程师，用户 = 董事长）
    - 核心原则（审计型协作 > 聊天室型协作）
    - 协作流程图
  - [x] SubTask 14.2: 添加使用示例
    - 示例1：Web GPT 创建任务
    - 示例2：本地模型执行任务
    - 示例3：Web GPT 审核报告
    - 示例4：完整的工作流循环
  - [x] SubTask 14.3: 添加故障排除指南
    - Ollama 连接失败
    - 任务解析错误
    - 边界检查失败
    - 测试超时
    - 权限问题

- [x] Task 15: 端到端测试
  - [x] SubTask 15.1: 测试完整的任务创建→执行→审核循环
    - 创建测试任务文件
    - 启动 worker（使用 mock LLM）
    - 验证任务状态从"待执行"变为"待审核"
    - 验证 execution_report.md 生成正确
    - 验证 events.jsonl 记录正确
  - [x] SubTask 15.2: 测试边界检查机制
    - 创建任务设置允许/禁止修改范围
    - 模拟修改允许范围内的文件（应通过）
    - 模拟修改禁止范围内的文件（应拒绝）
    - 验证边界违规被正确记录
  - [x] SubTask 15.3: 测试超时和失败处理
    - 模拟 LLM 调用超时
    - 验证超时后任务状态正确更新
    - 模拟测试失败
    - 验证自动重试机制
    - 验证重试失败后的处理
  - [x] SubTask 15.4: 测试 CLI 命令集成
    - 测试 `devspace collab init` 命令
    - 测试 `devspace collab status` 命令
    - 测试 `devspace worker start` 命令
    - 验证命令输出正确
  - [x] SubTask 15.5: 创建测试 fixtures 和辅助函数
    - 创建测试用的任务模板
    - 创建 mock Ollama 服务器
    - 创建测试用的项目结构
    - 创建断言辅助函数

# Task Dependencies

- Task 1 (目录结构) 无依赖，可立即开始
- Task 2-5 (模板定义) 依赖 Task 1
- Task 6 (Orchestrator) 依赖 Task 2-5
- Task 7-9 (边界检查、超时、配置) 依赖 Task 6
- Task 10-12 (事件流、状态管理) 依赖 Task 6
- Task 13 (CLI集成) 依赖 Task 6-12
- Task 14 (文档) 依赖 Task 1-12
- Task 15 (测试) 依赖 Task 1-14

# Parallelizable Work

- Task 13 和 Task 14 可以并行（CLI集成和文档编写）
- Task 15 的各个 SubTask 可以按顺序执行

# 实现细节分析

## Task 13: CLI 集成分析

### 当前 CLI 结构
- 入口文件：`src/cli.ts`
- 支持的命令：serve, init, doctor, config, help
- 命令解析：normalizeCommand 函数
- 命令执行：main 函数中的 switch 语句

### 需要修改的文件
1. `src/cli.ts` - 添加 collab 和 worker 命令
2. `package.json` - 添加 Python 依赖检查脚本（可选）

### 实现方案
```typescript
// 在 Command 类型中添加
type Command = "serve" | "init" | "doctor" | "config" | "help" | "collab" | "worker";

// 在 normalizeCommand 中添加
if (command === "collab" || command === "worker") return command;

// 在 main 函数中添加
case "collab":
  await runCollabCommand(args);
  return;
case "worker":
  await runWorkerCommand(args);
  return;
```

## Task 14: 文档结构分析

### 文档大纲
1. 概述
2. 核心概念
   - 角色定义
   - 协作原则
   - 文件结构
3. 快速开始
   - 初始化工作区
   - 启动 Worker
   - 创建第一个任务
4. 详细使用指南
   - 任务格式说明
   - 报告格式说明
   - 审核流程说明
5. 高级功能
   - 边界检查
   - 事件流
   - 状态管理
6. 故障排除
7. API 参考

## Task 15: 测试策略分析

### 测试类型
1. **单元测试**：测试各个组件的独立功能
   - TaskParser 测试
   - BoundaryChecker 测试
   - EventLogger 测试

2. **集成测试**：测试组件之间的交互
   - Worker 主循环测试
   - 状态管理测试
   - 文件读写测试

3. **端到端测试**：测试完整的业务流程
   - 任务创建→执行→审核循环
   - 边界检查机制
   - 超时和失败处理

### 测试工具
- Python: pytest（用于 devspace_worker.py 测试）
- TypeScript: vitest 或 jest（用于 CLI 测试）
- Mock: unittest.mock（Python）或 vitest mocking

### 测试覆盖率目标
- 单元测试覆盖率 > 80%
- 集成测试覆盖率 > 60%
- 端到端测试覆盖所有关键路径

# Task Dependencies

- Task 1 (目录结构) 无依赖，可立即开始
- Task 2-5 (模板定义) 依赖 Task 1
- Task 6 (Orchestrator) 依赖 Task 2-5
- Task 7-9 (边界检查、超时、配置) 依赖 Task 6
- Task 10-12 (事件流、状态管理) 依赖 Task 6
- Task 13 (CLI集成) 依赖 Task 6-12
- Task 14 (文档) 依赖 Task 1-12
- Task 15 (测试) 依赖 Task 1-14

# Parallelizable Work

- Task 13 和 Task 14 可以并行（CLI集成和文档编写）
- Task 15 的各个 SubTask 可以按顺序执行
