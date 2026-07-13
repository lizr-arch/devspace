# Delegate Mode / Free Mode 架构 Spec

## Why

当前 DevSpace 的协作功能（`add-async-workflow`）只实现了基础的任务-执行-审核循环，缺少：
1. **Brainstorm 阶段**：用户和 Web GPT 的需求讨论没有结构化记录
2. **授权机制**：没有 User Proxy Agent 代表用户继续对话
3. **多模式支持**：只有一种运行模式，缺少 Manual/Guided/Delegate/Free 四种模式
4. **状态机**：缺少完整的状态流转（BRAINSTORM → FREEZE → DELEGATE → DONE）
5. **停止条件**：缺少 NEED_USER、SAFETY_STOP、BUDGET_STOP 等停止机制
6. **可视化**：缺少 conversation.jsonl 驱动的最小可视化

需要将 DevSpace 改造成一个完整的"AI 项目协作系统"，支持用户先和 Coach GPT Brainstorm，然后授权本地代理自动执行。

## What Changes

### 新增模块
- `.devspace/ceo/` - Handoff Package 目录（brainstorm_summary、delegate_contract、stop_conditions 等）
- `.devspace/runs/` - 运行目录（每次执行的独立状态）
- `conversation.jsonl` - 统一对话记录（可视化数据源）
- User Proxy Agent - 本地代理人
- Local Orchestrator - 本地执行调度器（增强版）
- 状态机引擎 - 管理 BRAINSTORM → FREEZE → DELEGATE → DONE 流转

### 修改模块
- `src/cli.ts` - 添加 delegate/brainstorm/timeline 命令
- `scripts/devspace_worker.py` - 增强为 Local Orchestrator
- `src/collaboration/` - 添加新的解析器和生成器

### 新增 CLI 命令
- `devspace brainstorm freeze` - 冻结 Brainstorm 结果
- `devspace delegate start` - 启动 Delegate Mode
- `devspace delegate status` - 查看状态
- `devspace delegate pause/resume/stop` - 控制执行
- `devspace run current` - 执行当前任务
- `devspace timeline` - 查看对话时间线

## Impact

- Affected specs: `add-async-workflow`（需要扩展）
- Affected code:
  - `src/cli.ts` - 添加新命令
  - `scripts/devspace_worker.py` - 增强为 Local Orchestrator
  - `src/collaboration/` - 添加新解析器
  - 新增 `src/delegate/` - Delegate 模块

## ADDED Requirements

### Requirement: Handoff Package
系统 SHALL 在 Brainstorm 结束后生成结构化的 Handoff Package，包含：
- brainstorm_summary.md
- user_intent.md
- architecture_decision.md
- ceo_charter.md
- delegate_contract.md
- autonomy_policy.md
- review_policy.md
- stop_conditions.md
- task_plan.md
- first_task.md

### Requirement: 四种运行模式
系统 SHALL 支持四种运行模式：
- Manual Mode：用户手动控制每一步
- Guided Mode：Coach 布置任务，用户确认每一步
- Delegate Mode：User Proxy 代表用户自动执行
- Free Mode：在授权范围内连续自动执行

### Requirement: 状态机
系统 SHALL 实现完整的状态机：
```
BRAINSTORM → FREEZE_HANDOFF → READY_TO_DELEGATE → DELEGATE_RUNNING → 
LOCAL_EXECUTING → LOCAL_REPORTED → COACH_REVIEWING → 
NEXT_TASK_CREATED / NEED_USER / BLOCKED / DONE / SAFETY_STOP / BUDGET_STOP
```

### Requirement: 停止条件
系统 SHALL 支持以下停止类型：
- DONE：满足所有验收标准
- BLOCKED：外部条件缺失
- NEED_USER：需要用户决策
- SAFETY_STOP：检测到高风险操作
- BUDGET_STOP：达到预算上限（轮数/时间/失败次数/文件变更）

### Requirement: User Proxy Agent
系统 SHALL 提供 User Proxy Agent，能够：
- 读取 delegate_contract 和 user_intent
- 代表用户接受低风险任务
- 在高风险问题上触发 NEED_USER
- 记录决策日志

### Requirement: conversation.jsonl
系统 SHALL 提供统一的对话记录格式，用于本地可视化：
```json
{
  "timestamp": "...",
  "run_id": "...",
  "role": "coach_gpt | user_proxy | local_orchestrator | executor | user",
  "type": "task | report | review | question | decision | status",
  "status": "...",
  "title": "...",
  "content_file": "..."
}
```

### Requirement: 本地最小可视化
系统 SHALL 提供命令行可视化（`devspace timeline`），显示：
- Coach GPT 布置的任务
- 本地 Agent 的执行报告
- Coach 的审核意见
- User Proxy 的提问或回复
- 当前状态和停止原因

## MODIFIED Requirements

### Requirement: Local Orchestrator
现有 Worker SHALL 增强为 Local Orchestrator，支持：
- 读取 delegate_contract 约束
- 检测风险并触发 NEED_USER / SAFETY_STOP
- 记录 conversation.jsonl
- 支持 pause/resume/stop

## REMOVED Requirements
无

## 安全边界

1. 默认不自动进入 Free Mode
2. Free Mode 必须由用户显式开启
3. 本地代理不能擅自扩大授权范围
4. 本地代理不能修改 delegate_contract.md
5. 本地代理不能跳过测试
6. 本地代理不能隐藏失败
7. 如果发生安全冲突，必须触发 SAFETY_STOP
8. 如果信息不足，必须触发 NEED_USER
