# Delegate Workflow Guide

## 概述

Delegate Mode 是 DevSpace 的核心功能，允许 Web GPT (Coach) 和本地模型 (Executor) 进行异步协作。

## 工作流程

### 1. Browser Web GPT Brainstorm

用户在浏览器中与 Web GPT 进行 Brainstorm，讨论项目需求、架构设计等。

### 2. Handoff Import

将 Brainstorm 结果导入到本地：

```bash
# 从文件导入
devspace handoff import ./brainstorm_result.md

# 或初始化空模板
devspace handoff init

# 验证 Handoff Package
devspace handoff validate
```

### 3. Delegate Start

启动 Delegate Mode：

```bash
# 使用 delegate 模式
devspace delegate start --mode delegate

# 使用 free 模式
devspace delegate start --mode free
```

### 4. Delegate Run

运行自动循环：

```bash
# 使用 mock provider 测试
devspace delegate run --mock --max-rounds 2

# 使用真实 Ollama provider
devspace delegate run --provider ollama
```

### 5. 查看 Timeline

```bash
devspace timeline
```

## 四种模式

### Manual Mode

每一步都需要用户确认：

```bash
devspace delegate start --mode manual
```

- 不自动执行下一轮
- 每个决策都需要用户确认

### Guided Mode

执行后等待确认：

```bash
devspace delegate start --mode guided
```

- 自动执行任务
- 执行后等待用户确认
- 确认后继续下一轮

### Delegate Mode

低风险自动继续，高风险暂停：

```bash
devspace delegate start --mode delegate
```

- User Proxy Agent 自动决策
- 低风险任务自动继续
- 高风险任务触发 NEED_USER

### Free Mode

自动多轮循环，直到停止条件：

```bash
devspace delegate start --mode free
```

- 完全自动执行
- 达到停止条件时停止

## 停止条件处理

### NEED_USER

当遇到需要用户决策的情况时，系统会暂停并等待用户输入：

- 架构变更
- 范围扩展
- 新依赖引入
- 连续失败两次

**恢复方式**：
```bash
# 用户做出决策后
devspace delegate resume
```

### SAFETY_STOP

当检测到高风险操作时，系统会立即停止：

- 删除大量文件
- 修改禁止范围
- 执行危险命令

**处理方式**：
1. 检查 `.devspace/conversation.jsonl` 了解原因
2. 修复问题
3. 重新启动

### BUDGET_STOP

当达到预算上限时停止：

| 预算类型 | 默认限制 |
|---------|---------|
| 最大轮数 | 10 |
| 最大连续失败 | 3 |
| 最大运行时间 | 3600 秒 |
| 最大文件变更 | 50 |

**处理方式**：
1. 检查当前进度
2. 调整预算限制
3. 重新启动

## 文件结构

```
.devspace/
├── state.json                    # 全局状态
├── conversation.jsonl            # 对话记录
├── ceo/                          # Handoff Package
│   ├── delegate_contract.md      # 委托合同
│   ├── stop_conditions.md        # 停止条件
│   └── ...
└── runs/                         # 运行记录
    └── run-xxx/
        ├── run_state.json        # 运行状态
        ├── local_report.md       # 本地报告
        ├── coach_review.md       # Coach 审核
        └── ...
```

## 常见问题

### Q: 如何查看当前状态？

```bash
devspace delegate status
```

### Q: 如何暂停自动循环？

```bash
devspace delegate pause
```

### Q: 如何恢复自动循环？

```bash
devspace delegate resume
```

### Q: 如何停止 Delegate Mode？

```bash
devspace delegate stop
```

### Q: 如何查看执行历史？

```bash
devspace timeline
```

## 最佳实践

1. **先用 mock 测试**：使用 `--mock` 参数测试流程
2. **设置合理的预算**：根据项目规模设置 max_rounds
3. **定期检查 timeline**：了解执行进度
4. **保留 conversation.jsonl**：用于审计和调试