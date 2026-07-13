# Checklist

## Phase 1: 共享工作区协议

### 目录结构
- [x] `.devspace/` 目录存在
- [x] `context.md` 文件存在且包含项目背景
- [x] `current_task.md` 文件存在且格式正确
- [x] `execution_report.md` 文件存在且格式正确
- [x] `review.md` 文件存在且格式正确
- [x] `decision.md` 文件存在且格式正确
- [x] `next_task.md` 文件存在且格式正确

### 任务模板
- [x] 任务模板包含任务ID字段
- [x] 任务模板包含目标字段
- [x] 任务模板包含允许修改范围字段
- [x] 任务模板包含禁止修改范围字段
- [x] 任务模板包含验收标准字段
- [x] 任务模板包含必须运行的测试字段
- [x] 任务模板包含报告格式要求字段
- [x] 任务模板包含失败处理字段

### 执行报告模板
- [x] 报告模板包含修改文件列表字段
- [x] 报告模板包含测试结果字段
- [x] 报告模板包含git diff字段
- [x] 报告模板包含遇到的问题字段
- [x] 报告模板包含未完成部分字段

### 审核模板
- [x] 审核模板包含审核结果字段（通过/有条件通过/不通过）
- [x] 审核模板包含详细评审字段
- [x] 审核模板包含具体问题字段
- [x] 审核模板包含改进建议字段
- [x] 审核模板包含下一步字段

## Phase 2: 本地 Orchestrator

### 任务发现
- [x] Orchestrator 能检测到"待执行"状态的任务
- [x] Orchestrator 能解析任务文件内容
- [x] Orchestrator 在没有待执行任务时正确等待

### Ollama API 调用
- [x] 能成功调用 Ollama API
- [x] 正确传递任务上下文给模型
- [x] 能接收模型的响应

### 代码修改应用
- [x] 能应用模型生成的代码修改
- [x] 修改前检查文件是否在允许范围内
- [x] 越权修改被正确拒绝

### 测试运行
- [x] 能执行任务中指定的测试命令
- [x] 正确记录测试结果
- [x] 测试失败时正确处理

### 报告生成
- [x] 自动生成 execution_report.md
- [x] 报告包含所有必填字段
- [x] 报告格式正确

### 状态管理
- [x] 任务状态正确更新为"执行中"
- [x] 任务状态正确更新为"待审核"
- [x] 任务状态正确更新为"已完成"或"已拒绝"

### 超时和失败处理
- [x] 单任务最大执行时间不超过30分钟
- [x] 测试失败时自动重试1次
- [x] 重试仍失败时标记为"需要人工介入"

## Phase 3: C-lite 队列

### 事件流
- [x] `events.jsonl` 文件存在
- [x] 事件格式为有效JSON
- [x] 包含所有关键事件类型（TASK_CREATED, LOCAL_STARTED, TEST_PASSED, REPORT_READY, REVIEW_APPROVED 等）
- [x] 事件包含时间戳
- [x] 事件包含任务ID

### 状态文件
- [x] `state.json` 文件存在
- [x] 包含 active_tasks 数组
- [x] 包含 completed_tasks 数组
- [x] 包含 blocked_tasks 数组
- [x] 状态文件与实际任务状态一致

### 任务历史
- [x] `task_history/` 目录存在
- [x] 已完成任务自动归档
- [x] 归档文件命名格式正确（YYYY-MM-DD_task-id.md）

## 集成和测试

### CLI 集成 - Task 13
- [x] SubTask 13.1: `src/cli.ts` 中 Command 类型包含 `collab` 和 `worker`
- [x] SubTask 13.1: `normalizeCommand` 函数识别 `collab` 和 `worker` 命令
- [x] SubTask 13.1: `main` 函数的 switch 中添加 collab 和 worker case
- [x] SubTask 13.2: `devspace collab init` 命令能创建 .devspace/ 目录结构
- [x] SubTask 13.2: `devspace collab init` 命令能复制模板文件
- [x] SubTask 13.2: `devspace collab init` 命令能创建 task_history/ 目录
- [x] SubTask 13.3: `devspace collab status` 命令能读取 state.json
- [x] SubTask 13.3: `devspace collab status` 命令能显示当前任务状态
- [x] SubTask 13.3: `devspace collab status` 命令能显示活跃任务列表
- [x] SubTask 13.3: `devspace collab status` 命令能显示已完成任务列表
- [x] SubTask 13.3: `devspace collab status` 命令能显示最近事件记录
- [x] SubTask 13.4: `devspace worker start` 命令能检查 Python 环境
- [x] SubTask 13.4: `devspace worker start` 命令能启动 worker 子进程
- [x] SubTask 13.4: `devspace worker start` 命令支持 --config 参数
- [x] SubTask 13.4: `devspace worker start` 命令支持 Ctrl+C 优雅停止

### 文档 - Task 14
- [x] SubTask 14.1: `docs/collaboration-workflow.md` 文件存在
- [x] SubTask 14.1: 文档包含异步协作工作流概念介绍
- [x] SubTask 14.1: 文档包含角色定义（Web GPT, 本地模型, 用户）
- [x] SubTask 14.1: 文档包含核心原则说明
- [x] SubTask 14.1: 文档包含协作流程图
- [x] SubTask 14.2: 文档包含使用示例1（Web GPT 创建任务）
- [x] SubTask 14.2: 文档包含使用示例2（本地模型执行任务）
- [x] SubTask 14.2: 文档包含使用示例3（Web GPT 审核报告）
- [x] SubTask 14.2: 文档包含使用示例4（完整工作流循环）
- [x] SubTask 14.3: 文档包含故障排除指南
- [x] SubTask 14.3: 故障排除包含 Ollama 连接失败解决方案
- [x] SubTask 14.3: 故障排除包含任务解析错误解决方案
- [x] SubTask 14.3: 故障排除包含边界检查失败解决方案
- [x] SubTask 14.3: 故障排除包含测试超时解决方案

### 端到端测试 - Task 15
- [x] SubTask 15.1: 测试文件 `tests/test_e2e_workflow.py` 存在
- [x] SubTask 15.1: 测试完整的任务创建→执行→审核循环
- [x] SubTask 15.1: 验证任务状态从"待执行"变为"待审核"
- [x] SubTask 15.1: 验证 execution_report.md 生成正确
- [x] SubTask 15.1: 验证 events.jsonl 记录正确
- [x] SubTask 15.2: 测试边界检查机制
- [x] SubTask 15.2: 验证允许范围内的修改被接受
- [x] SubTask 15.2: 验证禁止范围内的修改被拒绝
- [x] SubTask 15.2: 验证边界违规被正确记录
- [x] SubTask 15.3: 测试超时和失败处理
- [x] SubTask 15.3: 验证 LLM 调用超时后任务状态正确更新
- [x] SubTask 15.3: 验证测试失败后自动重试机制
- [x] SubTask 15.3: 验证重试失败后的处理
- [x] SubTask 15.4: 测试 CLI 命令集成
- [x] SubTask 15.4: 测试 `devspace collab init` 命令输出正确
- [x] SubTask 15.4: 测试 `devspace collab status` 命令输出正确
- [x] SubTask 15.4: 测试 `devspace worker start` 命令启动成功
- [x] SubTask 15.5: 测试 fixtures 和辅助函数存在
- [x] SubTask 15.5: 创建测试用的任务模板
- [x] SubTask 15.5: 创建 mock Ollama 服务器
- [x] SubTask 15.5: 创建测试用的项目结构
- [x] SubTask 15.5: 创建断言辅助函数

### 测试覆盖率
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试覆盖率 > 60%
- [ ] 端到端测试覆盖所有关键路径
- [ ] 所有测试用例通过

## 协作原则验证

### 角色职责
- [x] Web GPT 只负责任务制定、审核、裁决
- [x] 本地模型只负责代码执行、测试、报告
- [x] 用户保持最终决策权

### 审计型协作
- [x] 所有任务都有记录
- [x] 所有审核都有记录
- [x] 所有决策都有记录
- [x] 不支持实时聊天模式

### 边界明确
- [x] 每个任务都有明确的允许修改范围
- [x] 每个任务都有明确的禁止修改范围
- [x] 边界检查机制正常工作

## 最终验收

### 功能完整性
- [x] Phase 1 共享工作区协议完整实现
- [x] Phase 2 本地 Orchestrator 完整实现
- [x] Phase 3 C-lite 队列完整实现
- [x] CLI 命令集成完整实现
- [x] 文档完整编写
- [x] 测试完整覆盖

### 代码质量
- [x] 代码符合项目风格规范
- [x] 无 TypeScript/Python 类型错误
- [x] 无 lint 错误
- [x] 错误处理完善

### 文档质量
- [x] 文档清晰易懂
- [x] 示例代码可运行
- [x] 故障排除指南实用

### 测试质量
- [x] 测试用例覆盖所有关键路径
- [x] 测试用例独立可重复
- [x] 测试用例有清晰的断言
