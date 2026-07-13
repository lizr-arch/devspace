# Tasks

## Task 1: 重构命令结构

- [x] Task 1.1: 修改 `devspace init` 命令
  - 创建空的 `.devspace/ceo/` 模板
  - 不需要用户提供 Brainstorm 内容

- [x] Task 1.2: 实现 `devspace handoff import <file>` 命令
  - 从 JSON/MD 文件导入 Brainstorm 结果
  - 自动填充 `.devspace/ceo/` 下的文件

- [x] Task 1.3: 实现 `devspace handoff validate` 命令
  - 检查所有必填文件是否存在
  - 检查必填字段是否完整
  - 输出校验结果

- [x] Task 1.4: 实现 `devspace handoff show` 命令
  - 显示 Handoff Package 内容
  - 格式化输出

- [x] Task 1.5: 删除 `devspace brainstorm freeze` 命令
  - 从 cli.ts 中移除
  - 更新帮助文档

## Task 2: 实现 Provider 抽象

- [x] Task 2.1: 定义 ExecutorProvider 接口
  ```
  interface ExecutorProvider {
    execute(task: string, config: ExecutorConfig): Promise<ExecutionResult>
  }
  ```

- [x] Task 2.2: 实现 MockExecutorProvider
  - 返回预设的执行结果
  - 用于测试

- [x] Task 2.3: 实现 OllamaExecutorProvider
  - 调用 Ollama API
  - 支持配置模型和 URL

- [x] Task 2.4: 定义 CoachReviewProvider 接口
  ```
  interface CoachReviewProvider {
    review(executionResult: ExecutionResult): Promise<CoachReview>
  }
  ```

- [x] Task 2.5: 实现 MockCoachReviewProvider
  - 返回预设的审核结果
  - 用于测试

- [x] Task 2.6: 实现 OllamaCoachReviewProvider
  - 调用 LLM 生成审核意见
  - 支持配置模型

## Task 3: 重构 Local Orchestrator

- [x] Task 3.1: 修改 LocalOrchestrator 使用 ExecutorProvider
  - 注入 ExecutorProvider
  - 不再写死 Ollama 调用

- [x] Task 3.2: 修改 LocalOrchestrator 使用 CoachReviewProvider
  - 注入 CoachReviewProvider
  - 支持自动生成 Coach Review

- [x] Task 3.3: 添加模式行为差异
  - Manual: 每步暂停等待用户
  - Guided: 显示任务等待确认
  - Delegate: User Proxy 自动决策
  - Free: 连续自动执行

- [x] Task 3.4: 添加停止条件检查
  - 检查 DONE 条件
  - 检查 BLOCKED 条件
  - 检查 NEED_USER 条件
  - 检查 SAFETY_STOP 条件
  - 检查 BUDGET_STOP 条件

## Task 4: 实现自动循环

- [x] Task 4.1: 重构 FreeModeRunner
  - 使用 `devspace delegate run` 启动
  - 只执行 current_task.md
  - 不自动执行 task_plan.md

- [x] Task 4.2: 实现循环逻辑
  ```
  while not stopped:
    task = read current_task.md
    result = executor.execute(task)
    report = generate local_report
    review = coach_review_provider.review(result)
    if review.verdict == DONE: break
    if review.verdict == NEED_USER: pause
    next_task = generate next_task
    write next_task to current_task.md
  ```

- [x] Task 4.3: 实现 `devspace delegate run` 命令
  - 启动自动循环
  - 支持 --mock 参数
  - 支持 --provider 参数

- [x] Task 4.4: 删除 `devspace run current` 命令
  - 从 cli.ts 中移除
  - 更新帮助文档

## Task 5: 完善 User Proxy Agent

- [x] Task 5.1: 实现 UserProxy 决策逻辑
  - 读取 delegate_contract
  - 根据风险级别决策
  - 高风险触发 NEED_USER

- [x] Task 5.2: 实现 UserProxy 与 Coach 对话
  - 代表用户回答常规问题
  - 接受任务
  - 提交报告

- [x] Task 5.3: 实现 decision log
  - 记录每个决策
  - 记录决策依据

## Task 6: 测试

- [ ] Task 6.1: 编写 Provider 测试
  - MockExecutorProvider 测试
  - MockCoachReviewProvider 测试

- [ ] Task 6.2: 编写模式行为测试
  - Manual 模式测试
  - Guided 模式测试
  - Delegate 模式测试
  - Free 模式测试

- [ ] Task 6.3: 编写自动循环测试
  - 正常循环测试
  - 停止条件测试
  - NEED_USER 暂停测试

- [ ] Task 6.4: 编写命令测试
  - init 命令测试
  - handoff import 命令测试
  - handoff validate 命令测试
  - delegate run 命令测试

# Task Dependencies

- Task 1 (命令重构) → 无依赖
- Task 2 (Provider 抽象) → 无依赖
- Task 3 (Orchestrator 重构) → 依赖 Task 2
- Task 4 (自动循环) → 依赖 Task 3
- Task 5 (User Proxy) → 依赖 Task 2
- Task 6 (测试) → 依赖 Task 1-5

# Parallelizable Work

- Task 1 和 Task 2 可以并行
- Task 3 和 Task 5 可以并行（都依赖 Task 2）
