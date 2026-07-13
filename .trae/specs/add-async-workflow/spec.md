# Async Collaboration Workflow Spec

## Why
DevSpace 需要支持"Web GPT 作为 CEO/审核官，本地模型作为执行者"的异步协作模式。当前 DevSpace 只提供文件和命令工具，没有协作协议层。需要添加共享工作区协议，让两个 Agent 通过结构化文件进行异步协作。

## What Changes
- 添加 `.devspace/` 协作目录结构
- 定义任务、报告、审核的标准模板格式
- 创建本地 Orchestrator 脚本（devspace_worker.py）
- 添加任务状态管理和事件追踪系统
- **BREAKING**: 无破坏性变更，纯新增功能

## Impact
- Affected specs: 无（新增功能）
- Affected code: 
  - 新增 `scripts/devspace_worker.py`（本地 Orchestrator）
  - 新增 `.devspace/` 目录结构和模板文件
  - 新增 `src/collaboration/` 模块（任务解析、状态管理）

## ADDED Requirements

### Requirement: 共享工作区协议
系统 SHALL 提供标准化的协作文件结构，让 Web GPT 和本地模型通过文件进行异步通信。

#### Scenario: 创建协作目录
- **WHEN** 用户运行 `devspace init` 或手动创建 `.devspace/` 目录
- **THEN** 系统创建标准化的文件结构（context.md, current_task.md, execution_report.md 等）

#### Scenario: Web GPT 创建任务
- **WHEN** Web GPT 通过 MCP 工具写入 `.devspace/current_task.md`
- **THEN** 文件必须包含：任务ID、目标、允许修改范围、禁止修改范围、验收标准、必须运行的测试、报告格式要求

#### Scenario: 本地模型执行任务
- **WHEN** 本地模型读取 `.devspace/current_task.md` 并执行
- **THEN** 必须将执行结果写入 `.devspace/execution_report.md`，包含：修改文件列表、测试结果、遇到的问题

#### Scenario: Web GPT 审核报告
- **WHEN** Web GPT 读取 `.devspace/execution_report.md` 并审核
- **THEN** 必须将审核意见写入 `.devspace/review.md`，并决定：通过/有条件通过/不通过

### Requirement: 本地 Orchestrator
系统 SHALL 提供本地守护脚本，自动发现待执行任务、调用本地模型、运行测试、生成报告。

#### Scenario: 自动发现任务
- **WHEN** `devspace_worker.py` 运行时检测到 `.devspace/current_task.md` 状态为"待执行"
- **THEN** 自动开始执行任务流程

#### Scenario: 调用本地模型
- **WHEN** Orchestrator 需要执行编码任务
- **THEN** 通过 Ollama API 调用本地大模型，并传入任务上下文

#### Scenario: 运行测试验证
- **WHEN** 本地模型完成代码修改
- **THEN** Orchestrator 自动运行任务中指定的测试命令，并记录结果

#### Scenario: 生成执行报告
- **WHEN** 任务执行完成（成功或失败）
- **THEN** 自动生成 `.devspace/execution_report.md`，包含完整的执行信息

### Requirement: 任务状态管理
系统 SHALL 提供任务状态追踪机制，支持待执行、执行中、待审核、已完成、已拒绝等状态。

#### Scenario: 状态流转
- **WHEN** 任务从创建到完成
- **THEN** 状态依次为：待执行 → 执行中 → 待审核 → 已完成/已拒绝

#### Scenario: 边界检查
- **WHEN** 本地模型修改代码时
- **THEN** 系统检查修改的文件是否在"允许修改范围"内，不在范围内则拒绝

### Requirement: 事件流追踪（Phase 3）
系统 SHALL 提供 JSONL 格式的事件流，记录所有任务相关的事件。

#### Scenario: 记录事件
- **WHEN** 任何任务状态变更或重要操作发生
- **THEN** 系统在 `.devspace/events.jsonl` 中追加一条事件记录

## MODIFIED Requirements
无（纯新增功能）

## REMOVED Requirements
无（纯新增功能）

## 协作原则

### 角色定义
- **用户（董事长）**: 最终决策者，确认方向和重大决策
- **Web GPT（CEO）**: 任务制定者、审核官、裁决者
- **本地模型（工程师）**: 代码执行者、测试者、报告生成者
- **DevSpace（办公系统）**: 提供工具和协作平台

### 核心原则
1. **审计型协作 > 聊天室型协作**
2. **任务清晰 > 实时对话**
3. **Web GPT 负责制**: 所有任务必须经过 Web GPT 审核
4. **边界明确**: 每个任务必须明确允许和禁止修改的范围
5. **可追溯性**: 所有决策和执行都有记录

### 任务格式要求
每个任务必须包含：
- 任务ID
- 目标（一句话描述）
- 允许修改范围（文件列表）
- 禁止修改范围（文件列表）
- 验收标准（可检查的条件）
- 必须运行的测试（命令列表）
- 报告格式要求
- 失败时如何处理

## 剩余任务实现分析

### Task 13: CLI 集成

#### 当前 CLI 结构分析
- **入口文件**: `src/cli.ts`
- **支持命令**: serve, init, doctor, config, help
- **命令类型**: `type Command = "serve" | "init" | "doctor" | "config" | "help"`
- **命令解析**: `normalizeCommand` 函数
- **命令执行**: `main` 函数中的 switch 语句

#### 需要修改的代码位置
1. **Command 类型定义** (第18行)
   ```typescript
   // 当前
   type Command = "serve" | "init" | "doctor" | "config" | "help";
   // 修改为
   type Command = "serve" | "init" | "doctor" | "config" | "help" | "collab" | "worker";
   ```

2. **normalizeCommand 函数** (第48-53行)
   ```typescript
   // 添加
   if (command === "collab" || command === "worker") return command;
   ```

3. **main 函数 switch** (第28-45行)
   ```typescript
   // 添加
   case "collab":
     await runCollabCommand(args);
     return;
   case "worker":
     await runWorkerCommand(args);
     return;
   ```

#### 新增函数实现

**runCollabCommand 函数**:
- 处理子命令: init, status
- `devspace collab init`: 初始化协作工作区
- `devspace collab status`: 显示协作状态

**runWorkerCommand 函数**:
- 处理子命令: start
- `devspace worker start`: 启动本地 Worker
- 支持 --config 参数

### Task 14: 文档结构

#### 文档大纲
1. **概述**
   - 异步协作工作流是什么
   - 为什么需要这个功能
   - 适用场景

2. **核心概念**
   - 角色定义（Web GPT, 本地模型, 用户）
   - 协作原则（审计型协作 > 聊天室型协作）
   - 文件结构（.devspace/ 目录）

3. **快速开始**
   - 步骤1: 初始化工作区
   - 步骤2: 启动 Worker
   - 步骤3: 创建第一个任务
   - 步骤4: 查看执行报告
   - 步骤5: 审核并继续

4. **详细使用指南**
   - 任务格式说明
   - 报告格式说明
   - 审核流程说明
   - 状态管理说明

5. **高级功能**
   - 边界检查机制
   - 事件流追踪
   - 状态文件管理
   - 任务历史归档

6. **故障排除**
   - Ollama 连接失败
   - 任务解析错误
   - 边界检查失败
   - 测试超时
   - 权限问题

7. **API 参考**
   - TypeScript 解析器 API
   - Python Worker API
   - 配置文件格式

### Task 15: 测试策略

#### 测试架构
```
tests/
├── unit/                    # 单元测试
│   ├── test_task_parser.py
│   ├── test_boundary_checker.py
│   └── test_event_logger.py
├── integration/             # 集成测试
│   ├── test_worker_loop.py
│   └── test_state_management.py
├── e2e/                     # 端到端测试
│   ├── test_workflow.py
│   └── test_cli_commands.py
├── fixtures/                # 测试数据
│   ├── task_templates/
│   └── mock_responses/
└── conftest.py              # pytest 配置
```

#### 测试用例设计

**单元测试**:
1. TaskParser 测试
   - 解析完整任务文件
   - 解析缺少字段的任务文件
   - 解析无效格式的任务文件

2. BoundaryChecker 测试
   - 文件在允许范围内
   - 文件在禁止范围内
   - 文件不在任何范围内
   - 使用通配符匹配

3. EventLogger 测试
   - 记录单个事件
   - 记录多个事件
   - 事件格式正确

**集成测试**:
1. Worker 主循环测试
   - 检测待执行任务
   - 调用 mock LLM
   - 应用代码修改
   - 运行测试命令
   - 生成执行报告

2. 状态管理测试
   - 读取状态文件
   - 更新状态文件
   - 状态流转正确

**端到端测试**:
1. 完整工作流测试
   - 创建任务
   - 执行任务
   - 生成报告
   - 审核任务
   - 归档任务

2. 边界检查测试
   - 允许范围内的修改
   - 禁止范围内的修改
   - 边界违规记录

3. 超时和失败处理测试
   - LLM 调用超时
   - 测试失败重试
   - 重试失败处理

#### Mock 策略

**Mock Ollama Server**:
```python
class MockOllamaServer:
    def __init__(self, responses):
        self.responses = responses
    
    def generate(self, prompt, **kwargs):
        return self.responses.get("default", "")
```

**Mock Git Commands**:
```python
def mock_subprocess_run(*args, **kwargs):
    # 返回预设的命令输出
    pass
```

#### 测试覆盖率目标
- 单元测试覆盖率 > 80%
- 集成测试覆盖率 > 60%
- 端到端测试覆盖所有关键路径
- 所有测试用例通过

## 实现优先级

### 优先级 1: Task 13 (CLI 集成)
- 影响用户体验
- 便于后续开发和测试
- 工作量相对较小

### 优先级 2: Task 15 (端到端测试)
- 确保功能正确性
- 发现潜在问题
- 为后续开发提供保障

### 优先级 3: Task 14 (文档)
- 便于用户理解
- 便于后续维护
- 可以在功能稳定后编写

## 依赖关系

```
Task 13 (CLI 集成)
    ↓
Task 15 (端到端测试)
    ↓
Task 14 (文档)
```

Task 13 和 Task 14 可以并行开发，但 Task 15 需要等 Task 13 完成后才能进行完整的端到端测试。
