# Checklist

## Phase 0: 仓库审计

- [x] 审计现有仓库结构
- [x] 识别可复用组件
- [x] 输出审计报告

## Phase 1: 协议与文件结构

### 目录结构
- [x] `.devspace/ceo/` 目录存在
- [x] `.devspace/runs/` 目录存在
- [x] 所有 Handoff Package 模板文件存在

### Schema 定义
- [x] state.json schema 定义完成
- [x] conversation.jsonl schema 定义完成
- [x] run_state.json schema 定义完成

### Schema 校验
- [x] validate_state() 函数实现并测试通过
- [x] validate_run_state() 函数实现并测试通过
- [x] validate_conversation_entry() 函数实现并测试通过

### 模板
- [x] brainstorm_summary.md 模板存在
- [x] user_intent.md 模板存在
- [x] architecture_decision.md 模板存在
- [x] ceo_charter.md 模板存在
- [x] delegate_contract.md 模板存在
- [x] autonomy_policy.md 模板存在
- [x] review_policy.md 模板存在
- [x] stop_conditions.md 模板存在
- [x] task_plan.md 模板存在
- [x] first_task.md 模板存在

### 文档
- [ ] docs/delegate-protocol.md 存在且内容完整

## Phase 2: Brainstorm Freeze / Handoff

### CLI 命令
- [ ] `devspace brainstorm freeze` 命令实现
- [ ] 命令能读取用户提供的 brainstorm 内容
- [ ] 命令能生成 ceo/ 目录下的所有文件
- [ ] 命令能验证必填字段

### Handoff Package 生成器
- [ ] src/collaboration/handoff_generator.ts 存在
- [ ] 能生成 brainstorm_summary.md
- [ ] 能生成 user_intent.md
- [ ] 能生成 architecture_decision.md
- [ ] 能生成 ceo_charter.md
- [ ] 能生成 delegate_contract.md
- [ ] 能生成 autonomy_policy.md
- [ ] 能生成 review_policy.md
- [ ] 能生成 stop_conditions.md
- [ ] 能生成 task_plan.md
- [ ] 能生成 first_task.md

### 校验器
- [ ] Handoff Package 校验器实现
- [ ] 能检查必填文件是否存在
- [ ] 能检查必填字段是否完整
- [ ] 缺少 delegate_contract 时返回错误
- [ ] 缺少 stop_conditions 时返回错误

### 测试
- [ ] 正常冻结流程测试通过
- [ ] 缺少必填字段时的错误处理测试通过
- [ ] 校验器测试通过

## Phase 3: Delegate Contract 与权限校验

### Schema
- [ ] delegate_contract schema 定义完成
- [ ] 能定义"可以代表用户做什么"
- [ ] 能定义"不可以代表用户做什么"
- [ ] 能定义"遇到什么必须触发 NEED_USER"
- [ ] 能定义"可接受风险级别"
- [ ] 能定义"自动执行最大范围"

### 解析器
- [ ] autonomy_policy 解析器实现
- [ ] 支持 manual 模式
- [ ] 支持 guided 模式
- [ ] 支持 delegate 模式
- [ ] 支持 free 模式

### 权限校验
- [ ] check_permission() 函数实现
- [ ] is_high_risk() 函数实现
- [ ] should_trigger_need_user() 函数实现

### NEED_USER 触发
- [ ] 需要改变总体架构时触发
- [ ] 需要扩大范围时触发
- [ ] 需要引入新依赖时触发
- [ ] 需要真实 API key 时触发
- [ ] 需要删除大量代码时触发
- [ ] 需要修改冻结契约时触发
- [ ] 连续两轮失败时触发
- [ ] Coach GPT 提出多个路线时触发
- [ ] 本地环境缺失关键资源时触发
- [ ] 测试无法运行且原因不明时触发

### 测试
- [ ] 未授权不能进入 Delegate Mode 测试通过
- [ ] 未授权不能进入 Free Mode 测试通过
- [ ] 高风险行为触发 NEED_USER 测试通过
- [ ] Local Agent 不能修改冻结合同测试通过

## Phase 4: Local Orchestrator MVP

### 增强功能
- [ ] devspace_worker.py 增强为 Local Orchestrator
- [ ] 能读取 delegate_contract 约束
- [ ] 能读取 current_task.md
- [ ] 能读取 first_task.md
- [ ] 能调用本地模型接口
- [ ] 能生成 local_report.md
- [ ] 能记录 conversation.jsonl

### 风险检测
- [ ] 能检测即将删除大量文件
- [ ] 能检测即将修改禁止范围
- [ ] 能检测即将执行危险命令
- [ ] 能检测即将绕过测试或验收

### conversation.jsonl 记录
- [ ] 能记录任务创建
- [ ] 能记录执行开始
- [ ] 能记录执行结果
- [ ] 能记录审核意见

### CLI 命令
- [ ] `devspace run current` 命令实现
- [ ] 命令能读取 current_task.md
- [ ] 命令能调用 Local Orchestrator
- [ ] 命令能生成 local_report.md

### Mock Executor
- [ ] mock executor 创建完成
- [ ] 能模拟本地模型调用
- [ ] 能模拟测试执行
- [ ] 能模拟报告生成

### 测试
- [ ] 正常执行流程测试通过
- [ ] 风险检测测试通过
- [ ] conversation.jsonl 记录测试通过

## Phase 5: Coach Review Loop

### Schema
- [ ] coach_review.md schema 定义完成
- [ ] 支持 Reviewed Task 字段
- [ ] 支持 Verdict 字段（PASS/PASS_WITH_WARNINGS/NEEDS_FIX/BLOCKED/DONE/NEED_USER/SAFETY_STOP/BUDGET_STOP）
- [ ] 支持 Reasoning Summary 字段
- [ ] 支持 Evidence Checked 字段
- [ ] 支持 Issues Found 字段
- [ ] 支持 Decision 字段
- [ ] 支持 Next Action 字段

### 解析器
- [ ] src/collaboration/coach_review_parser.ts 存在
- [ ] 能解析审核意见
- [ ] 能提取 verdict
- [ ] 能提取 next_action

### CLI 命令
- [ ] `submit_coach_review` 命令实现
- [ ] 命令能读取 coach_review.md
- [ ] 命令能更新 run_state.json
- [ ] 命令能根据 verdict 决定下一步
- [ ] 命令能记录 conversation.jsonl

### 状态流转
- [ ] PASS → NEXT_TASK_CREATED 测试通过
- [ ] PASS → DONE 测试通过
- [ ] PASS_WITH_WARNINGS → NEXT_TASK_CREATED 测试通过
- [ ] NEEDS_FIX → LOCAL_EXECUTING 测试通过
- [ ] BLOCKED → BLOCKED 测试通过
- [ ] DONE → DONE 测试通过
- [ ] NEED_USER → NEED_USER 测试通过
- [ ] SAFETY_STOP → SAFETY_STOP 测试通过
- [ ] BUDGET_STOP → BUDGET_STOP 测试通过

### Next Task 生成
- [ ] 能根据 coach_review 生成 next_task.md
- [ ] 能更新 task_plan.md 进度

### 测试
- [ ] verdict 状态流转测试通过
- [ ] next_task 生成测试通过
- [ ] DONE 处理测试通过
- [ ] BLOCKED 处理测试通过
- [ ] NEED_USER 处理测试通过

## Phase 6: Free Mode 自动循环

### CLI 命令
- [ ] `devspace delegate start` 命令实现
- [ ] `devspace delegate status` 命令实现
- [ ] `devspace delegate pause` 命令实现
- [ ] `devspace delegate resume` 命令实现
- [ ] `devspace delegate stop` 命令实现

### delegate start
- [ ] 能检查 Handoff Package 完整性
- [ ] 能检查 delegate_contract 授权
- [ ] 能创建新的 run
- [ ] 能开始自动循环

### 自动循环
- [ ] 能执行 current_task → local_report → coach_review → next_task → current_task
- [ ] 支持 max_rounds 限制
- [ ] 支持 max_failures 限制
- [ ] 支持 max_runtime 限制
- [ ] 支持 max_file_changes 限制

### delegate status
- [ ] 能显示当前模式
- [ ] 能显示当前状态
- [ ] 能显示当前任务
- [ ] 能显示轮数
- [ ] 能显示停止原因

### delegate pause
- [ ] 能暂停自动循环
- [ ] 能保存当前状态
- [ ] 能记录 conversation.jsonl

### delegate resume
- [ ] 能恢复自动循环
- [ ] 能从暂停点继续

### delegate stop
- [ ] 能停止自动循环
- [ ] 能生成 final_report.md
- [ ] 能记录 conversation.jsonl

### BUDGET_STOP
- [ ] 能检测 max_rounds 达到上限
- [ ] 能检测 max_failures 达到上限
- [ ] 能检测 max_runtime 达到上限
- [ ] 能检测 max_file_changes 达到上限

### 测试
- [ ] 自动循环测试通过
- [ ] 暂停/恢复测试通过
- [ ] 停止条件测试通过
- [ ] 预算限制测试通过

## Phase 7: User Proxy Agent

### Prompt/Template
- [ ] User Proxy prompt 设计完成
- [ ] 能读取 delegate_contract
- [ ] 能读取 user_intent
- [ ] 能理解授权范围

### 决策逻辑
- [ ] 低风险任务直接接受测试通过
- [ ] 中风险任务根据 contract 判断测试通过
- [ ] 高风险任务触发 NEED_USER 测试通过

### 对话
- [ ] 能代表用户回答常规问题
- [ ] 能接受任务
- [ ] 能提交报告
- [ ] 能触发 NEED_USER

### Decision Log
- [ ] 能记录每个决策
- [ ] 能记录决策依据
- [ ] 能记录风险评估

### 测试
- [ ] 低风险决策测试通过
- [ ] 高风险 NEED_USER 触发测试通过
- [ ] 决策日志测试通过

## Phase 8: 本地最小可视化

### CLI 命令
- [ ] `devspace timeline` 命令实现
- [ ] 命令能读取 conversation.jsonl
- [ ] 命令能格式化输出
- [ ] 命令能显示角色、类型、状态、标题

### Timeline 渲染
- [ ] 能显示 [Coach GPT] Task created
- [ ] 能显示 [User Proxy] Accepted under delegate contract
- [ ] 能显示 [Local Orchestrator] Local execution started
- [ ] 能显示 [Executor] Report: PASS
- [ ] 能显示 [Coach GPT] Review: NEEDS_FIX
- [ ] 能显示 [Local Orchestrator] Fix task started
- [ ] 能显示 [Coach GPT] Review: DONE

### 状态摘要
- [ ] 能显示当前模式
- [ ] 能显示当前状态
- [ ] 能显示当前任务
- [ ] 能显示轮数
- [ ] 能显示停止原因

### 测试
- [ ] conversation.jsonl 读取测试通过
- [ ] 格式化输出测试通过
- [ ] 状态摘要测试通过

## Phase 9: 真实集成与回归测试

### 真实集成
- [ ] mock executor 替换为真实本地模型调用
- [ ] 支持 Ollama
- [ ] 支持配置化选择

### MCP 集成
- [ ] 新的 MCP 工具注册完成
- [ ] 支持远程调用

### 端到端测试
- [ ] Brainstorm handoff 测试通过
- [ ] Delegate start 测试通过
- [ ] Local execution 测试通过
- [ ] Coach review 测试通过
- [ ] Next task 测试通过
- [ ] Done 测试通过

### 文档
- [ ] 如何从浏览器 Web GPT 启动 Delegate Run 文档存在
- [ ] 如何配置停止条件文档存在
- [ ] 如何查看 timeline 文档存在

### 最终报告
- [ ] 功能完整性报告生成
- [ ] 测试覆盖率报告生成
- [ ] 安全边界验证报告生成

## 安全边界验证

- [ ] 默认不自动进入 Free Mode
- [ ] Free Mode 必须由用户显式开启
- [ ] 本地代理不能擅自扩大授权范围
- [ ] 本地代理不能修改 delegate_contract.md
- [ ] 本地代理不能跳过测试
- [ ] 本地代理不能隐藏失败
- [ ] 如果发生安全冲突，必须触发 SAFETY_STOP
- [ ] 如果信息不足，必须触发 NEED_USER

## 测试覆盖率

- [ ] state schema valid/invalid 测试通过
- [ ] delegate_contract 权限边界测试通过
- [ ] 未授权不能进入 Free Mode 测试通过
- [ ] current_task 缺失时不能执行测试通过
- [ ] task_plan 不会被自动全量执行测试通过
- [ ] local_report 格式校验测试通过
- [ ] coach_review verdict 状态流转测试通过
- [ ] NEED_USER 触发测试通过
- [ ] SAFETY_STOP 触发测试通过
- [ ] BUDGET_STOP 触发测试通过
- [ ] conversation.jsonl append/read 测试通过
- [ ] timeline 渲染测试通过
- [ ] pause/resume/stop 测试通过
- [ ] 连续两轮 NEEDS_FIX 后按策略停止测试通过
- [ ] DONE 生成 final_report.md 测试通过
