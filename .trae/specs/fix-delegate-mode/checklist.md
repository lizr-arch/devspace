# Checklist

## Task 1: 重构命令结构

- [x] `devspace init` 创建空模板
- [x] `devspace handoff import <file>` 从文件导入
- [x] `devspace handoff validate` 校验 Handoff Package
- [x] `devspace handoff show` 显示 Handoff Package
- [x] `devspace brainstorm freeze` 已删除

## Task 2: 实现 Provider 抽象

- [x] ExecutorProvider 接口定义
- [x] MockExecutorProvider 实现
- [x] OllamaExecutorProvider 实现
- [x] CoachReviewProvider 接口定义
- [x] MockCoachReviewProvider 实现
- [x] OllamaCoachReviewProvider 实现

## Task 3: 重构 Local Orchestrator

- [x] 使用 ExecutorProvider 调用本地模型
- [x] 使用 CoachReviewProvider 生成审核
- [x] Manual 模式：每步暂停
- [x] Guided 模式：显示任务等待确认
- [x] Delegate 模式：User Proxy 自动决策
- [x] Free 模式：连续自动执行
- [x] DONE 条件检查
- [x] BLOCKED 条件检查
- [x] NEED_USER 条件检查
- [x] SAFETY_STOP 条件检查
- [x] BUDGET_STOP 条件检查

## Task 4: 实现自动循环

- [x] `devspace delegate run` 命令实现
- [x] 只执行 current_task.md
- [x] 不自动执行 task_plan.md
- [x] 循环逻辑：current_task → local_report → coach_review → next_task
- [x] `devspace run current` 已删除

## Task 5: 完善 User Proxy Agent

- [x] 读取 delegate_contract
- [x] 根据风险级别决策
- [x] 高风险触发 NEED_USER
- [x] 代表用户回答问题
- [x] decision log 记录

## Task 6: 测试

- [ ] MockExecutorProvider 测试通过
- [ ] MockCoachReviewProvider 测试通过
- [ ] Manual 模式测试通过
- [ ] Guided 模式测试通过
- [ ] Delegate 模式测试通过
- [ ] Free 模式测试通过
- [ ] 自动循环测试通过
- [ ] 停止条件测试通过
- [ ] NEED_USER 暂停测试通过
- [ ] init 命令测试通过
- [ ] handoff import 命令测试通过
- [ ] handoff validate 命令测试通过
- [ ] delegate run 命令测试通过

## 命令对照表

| 旧命令 | 新命令 | 说明 |
|--------|--------|------|
| `devspace brainstorm freeze` | `devspace handoff import` | 分离初始化和导入 |
| `devspace run current` | `devspace delegate run` | 单步执行 → 自动循环 |
| - | `devspace handoff validate` | 新增校验命令 |
| - | `devspace handoff show` | 新增显示命令 |

## 模式行为对照表

| 模式 | 行为 |
|------|------|
| Manual | 每步暂停，等待用户确认 |
| Guided | 显示任务，等待用户确认执行 |
| Delegate | User Proxy 自动决策，NEED_USER 时暂停 |
| Free | 连续自动执行，达到停止条件时停止 |

## 停止条件

| 条件 | 触发时机 |
|------|----------|
| DONE | 所有验收标准满足 |
| BLOCKED | 外部条件缺失 |
| NEED_USER | 需要用户决策 |
| SAFETY_STOP | 检测到高风险操作 |
| BUDGET_STOP | 达到预算上限（轮数/失败/时间/文件变更） |
