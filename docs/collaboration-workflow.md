# Collaboration Workflow

DevSpace 支持"Web GPT 作为 CEO/审核官，本地模型作为执行者"的异步协作模式。

## 概述

### 什么是异步协作工作流？

异步协作工作流是一种让 AI 助手（如 ChatGPT）和本地大模型（如 Ollama）协同工作的模式：

- **Web GPT（CEO）**: 负责任务制定、审核、裁决
- **本地模型（工程师）**: 负责代码执行、测试、报告
- **用户（董事长）**: 最终决策者

### 为什么需要这个功能？

1. **审计型协作 > 聊天室型协作**: 结构化的任务和报告比实时对话更有价值
2. **任务清晰 > 实时对话**: 每个任务都有明确的目标和边界
3. **可追溯性**: 所有决策和执行都有记录

## 核心概念

### 角色定义

| 角色 | 比喻 | 职责 | 不应该做 |
|------|------|------|----------|
| 用户 | 董事长 | 最终拍板、方向把控 | 陷入细节 |
| Web GPT | CEO | 任务制定、审核、裁决 | 亲自写代码 |
| 本地模型 | 工程师 | 执行、测试、报告 | 越权决策 |
| DevSpace | 办公系统 | 提供工具和协作平台 | 参与决策 |

### 协作原则

1. **审计型协作 > 聊天室型协作**
2. **任务清晰 > 实时对话**
3. **Web GPT 负责制**: 所有任务必须经过 Web GPT 审核
4. **边界明确**: 每个任务必须明确允许和禁止修改的范围
5. **可追溯性**: 所有决策和执行都有记录

### 文件结构

```
.devspace/
├── context.md              # 项目背景（只读）
├── current_task.md         # 当前任务（Web GPT 写）
├── execution_report.md     # 执行报告（本地模型写）
├── review.md               # 审核意见（Web GPT 写）
├── decision.md             # 最终裁决（Web GPT 写）
├── next_task.md            # 下一轮任务（Web GPT 写）
├── events.jsonl            # 事件流（自动记录）
├── state.json              # 状态文件（自动更新）
└── task_history/           # 任务归档目录
```

## 快速开始

### 步骤 1: 初始化工作区

```bash
devspace collab init
```

这会创建 `.devspace/` 目录结构和所有模板文件。

### 步骤 2: 启动 Worker

```bash
devspace worker start
```

这会启动本地 Worker，自动检测待执行任务。

### 步骤 3: 创建第一个任务

通过 Web GPT 或手动编辑 `.devspace/current_task.md`：

```markdown
# 任务：添加用户认证功能

## 状态
待执行

## 任务ID
`task-2024-01-15-001`

## 目标
实现 JWT 用户认证功能

## 允许修改范围
- src/services/auth/*
- src/middleware/*
- tests/auth/*

## 禁止修改范围
- src/config/*
- package.json

## 验收标准
- [ ] 所有现有测试通过
- [ ] 新增 AuthService 单元测试
- [ ] 无 TypeScript 类型错误

## 必须运行的测试
```bash
npm test
npm run typecheck
```
```

### 步骤 4: 查看执行报告

Worker 执行完成后，查看 `.devspace/execution_report.md`：

```markdown
# 执行报告

## 状态
已完成

## 任务ID
task-2024-01-15-001

## 修改文件列表
```bash
 src/services/auth.ts       | 45 +++
 src/services/auth.test.ts  | 30 ++
 2 files changed, 75 insertions(+)
```

## 测试结果
```bash
Test Suites: 2 passed, 2 total
Tests:       10 passed, 10 total
```
```

### 步骤 5: 审核并继续

Web GPT 审核后写入 `.devspace/review.md`，然后创建下一个任务。

## 详细使用指南

### 任务格式说明

每个任务必须包含以下字段：

| 字段 | 说明 | 示例 |
|------|------|------|
| 状态 | 任务当前状态 | 待执行、执行中、待审核、已完成 |
| 任务ID | 唯一标识符 | task-2024-01-15-001 |
| 目标 | 一句话描述 | 实现 JWT 认证 |
| 允许修改范围 | 可以修改的文件 | src/services/* |
| 禁止修改范围 | 不能修改的文件 | package.json |
| 验收标准 | 可检查的条件 | 测试通过、无类型错误 |
| 必须运行的测试 | 测试命令 | npm test |
| 报告格式要求 | 报告必须包含的内容 | git diff --stat |
| 失败时如何处理 | 失败后的处理方式 | 说明卡在哪里 |

### 报告格式说明

执行报告必须包含：

1. **状态**: 已完成、部分完成、失败
2. **任务ID**: 对应的任务ID
3. **执行时间**: 开始和结束时间
4. **修改文件列表**: `git diff --stat` 输出
5. **测试结果**: 测试命令输出
6. **git diff**: 完整的代码差异
7. **遇到的问题**: 问题描述和解决方案
8. **未完成部分**: 未完成的内容及原因

### 审核流程说明

Web GPT 审核报告后，写入 `.devspace/review.md`：

1. **审核结果**: ✅ 通过、⚠️ 有条件通过、❌ 不通过
2. **详细评审**: 代码质量、测试覆盖、边界遵守
3. **具体问题**: 问题描述、位置、严重程度
4. **改进建议**: 具体的改进建议
5. **下一步**: 继续、修复、进入下一阶段

### 状态管理说明

任务状态流转：

```
待执行 → 执行中 → 待审核 → 已完成/已拒绝
```

- **待执行**: Worker 检测到后自动开始执行
- **执行中**: Worker 正在调用 LLM、修改代码、运行测试
- **待审核**: 执行完成，等待 Web GPT 审核
- **已完成**: 审核通过
- **已拒绝**: 审核不通过，需要重新执行

## 高级功能

### 边界检查机制

Worker 会自动检查代码修改是否在允许范围内：

1. 解析任务中的"允许修改范围"和"禁止修改范围"
2. 执行 `git diff --name-only` 获取修改的文件列表
3. 检查每个文件是否在允许范围内
4. 如果有越权修改，拒绝执行并记录错误

### 事件流追踪

所有关键事件都会记录到 `.devspace/events.jsonl`：

```jsonl
{"event":"TASK_CREATED","task_id":"task-001","ts":"2024-01-15T10:00:00Z"}
{"event":"LOCAL_STARTED","task_id":"task-001","ts":"2024-01-15T10:00:15Z"}
{"event":"TEST_PASSED","task_id":"task-001","ts":"2024-01-15T10:05:00Z"}
{"event":"REPORT_READY","task_id":"task-001","ts":"2024-01-15T10:05:30Z"}
```

### 状态文件管理

`.devspace/state.json` 记录当前状态：

```json
{
  "current_phase": "idle",
  "active_tasks": [],
  "completed_tasks": ["task-001"],
  "blocked_tasks": []
}
```

### 任务历史归档

已完成的任务会自动归档到 `.devspace/task_history/`：

```
task_history/
├── 2024-01-15_task-001.md
├── 2024-01-16_task-002.md
└── ...
```

## 故障排除

### Ollama 连接失败

**问题**: Worker 无法连接到 Ollama API

**解决方案**:
1. 确保 Ollama 正在运行: `ollama serve`
2. 检查 Ollama URL 配置: `devspace_worker_config.yaml`
3. 测试连接: `curl http://localhost:11434/api/tags`

### 任务解析错误

**问题**: Worker 无法解析任务文件

**解决方案**:
1. 检查任务文件格式是否正确
2. 确保"状态"字段存在且值正确
3. 确保必填字段都已填写

### 边界检查失败

**问题**: 代码修改被拒绝

**解决方案**:
1. 检查任务中的"允许修改范围"是否正确
2. 确保修改的文件在允许范围内
3. 如果需要修改更多文件，更新任务的允许范围

### 测试超时

**问题**: 测试命令执行超时

**解决方案**:
1. 检查测试命令是否正确
2. 增加超时时间配置: `devspace_worker_config.yaml`
3. 检查是否有死循环或阻塞操作

### 权限问题

**问题**: Worker 无法读写文件

**解决方案**:
1. 确保 Worker 有权限读写项目目录
2. 检查 `.devspace/` 目录权限
3. 在 Windows 上，确保没有文件被锁定

## 配置参考

### devspace_worker_config.yaml

```yaml
# Ollama API URL
ollama_url: http://localhost:11434

# 使用的模型
model: llama3

# 轮询间隔（秒）
poll_interval: 10

# 最大执行时间（秒）
max_execution_time: 1800

# 失败重试次数
max_retries: 1
```

## API 参考

### TypeScript 解析器

```typescript
import { parseTask, isTaskPending } from "./src/collaboration/task_parser";
import { parseReport, generateReport } from "./src/collaboration/report_generator";
import { parseReview, isReviewApproved } from "./src/collaboration/review_parser";
```

### Python Worker

```python
from scripts.devspace_worker import DevSpaceWorker, TaskParser, BoundaryChecker

# 解析任务
task = TaskParser.parse(content)

# 检查边界
is_allowed, violations = BoundaryChecker.check_git_diff(task)

# 创建 Worker
worker = DevSpaceWorker(config, project_root)
worker.run()
```
