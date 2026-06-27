#!/bin/bash
set -e

DEVSPACE_DIR=".devspace"
TEMPLATES_DIR="templates"

echo "Initializing DevSpace collaboration workspace..."

mkdir -p "$DEVSPACE_DIR/task_history"

if [ -f "$TEMPLATES_DIR/task_template.md" ]; then
  cp "$TEMPLATES_DIR/task_template.md" "$DEVSPACE_DIR/current_task.md"
else
  cat > "$DEVSPACE_DIR/current_task.md" << 'EOF'
# 当前任务

## 状态
待执行

## 任务ID
`task-YYYY-MM-DD-001`

## 目标
[一句话描述要做什么]

## 背景
[为什么要做这个]

## 允许修改范围
- src/*

## 禁止修改范围
- .devspace/*
- package.json

## 验收标准
- [ ] 所有现有测试通过
- [ ] 无 TypeScript 类型错误

## 必须运行的测试
```bash
npm test
npm run typecheck
```

## 报告格式要求
执行报告必须包含：
1. 修改了哪些文件（git diff --stat）
2. 测试结果
3. 遇到的问题和解决方案
4. 未完成的部分及原因

## 失败时如何处理
如果无法完成，必须说明：
1. 卡在哪里
2. 尝试了什么
3. 需要什么帮助

## 优先级
P1
EOF
fi

cat > "$DEVSPACE_DIR/context.md" << 'EOF'
# 项目背景

## 项目名称
[项目名称]

## 项目简介
[项目是做什么的]

## 技术栈
[使用的技术]

## 当前阶段
[正在做什么]

## 重要约束
[有什么限制]
EOF

cat > "$DEVSPACE_DIR/execution_report.md" << 'EOF'
# 执行报告

## 状态
待执行

## 任务ID
[对应的任务ID]

## 执行时间
[开始时间] - [结束时间]

## 修改文件列表
```bash
git diff --stat
```

## 测试结果
[测试输出]

## git diff
```diff
[diff 内容]
```

## 遇到的问题
[问题描述]

## 未完成部分
[未完成的内容及原因]

## 建议下一步
[建议]
EOF

cat > "$DEVSPACE_DIR/review.md" << 'EOF'
# 审核意见

## 任务ID
[对应的任务ID]

## 审核结果
待审核

## 详细评审

### 代码质量
- [ ] 代码风格符合规范
- [ ] 无明显性能问题
- [ ] 错误处理完善

### 测试覆盖
- [ ] 单元测试充分
- [ ] 边界情况覆盖
- [ ] 集成测试通过

### 边界遵守
- [ ] 未修改禁止范围的文件
- [ ] 未引入新的依赖（除非任务允许）

## 具体问题
1. [问题1描述]

## 改进建议
1. [建议1]

## 下一步
- [ ] 继续当前任务
- [ ] 创建修复任务
- [ ] 进入下一阶段
EOF

cat > "$DEVSPACE_DIR/decision.md" << 'EOF'
# 最终裁决

## 任务ID
[对应的任务ID]

## 裁决结果
待裁决

## 裁决理由
[为什么做出这个决定]

## 后续行动
[下一步做什么]

## 裁决人
Web GPT / 用户

## 裁决时间
[时间]
EOF

cat > "$DEVSPACE_DIR/next_task.md" << 'EOF'
# 下一轮任务

## 状态
待创建

## 基于
[基于哪个任务的结果]

## 目标
[下一轮要做什么]

## 优先级
[P0/P1/P2]
EOF

cat > "$DEVSPACE_DIR/events.jsonl" << 'EOF'
EOF

cat > "$DEVSPACE_DIR/state.json" << 'EOF'
{
  "current_phase": "idle",
  "active_tasks": [],
  "completed_tasks": [],
  "blocked_tasks": []
}
EOF

echo "DevSpace collaboration workspace initialized!"
echo ""
echo "Directory structure:"
echo "  $DEVSPACE_DIR/"
echo "  ├── context.md           # Project background"
echo "  ├── current_task.md      # Current task"
echo "  ├── execution_report.md  # Execution report"
echo "  ├── review.md            # Review feedback"
echo "  ├── decision.md          # Final decision"
echo "  ├── next_task.md         # Next task"
echo "  ├── events.jsonl         # Event stream"
echo "  ├── state.json           # State file"
echo "  └── task_history/        # Task archive"
