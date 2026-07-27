# DevSpace 三项核心升级 — 开发计划

> 版本: v1  
> 日期: 2026-07-27  
> 状态: 设计阶段  
> 范围: git branch 语义修复 + project_task + additionalRoots

---

## 零、原则

```
DevSpace 负责：安全地运行已声明的项目任务
项目负责：    声明要运行什么
```

- 不做项目专用 Runner（Project Memory / Documentation / Worldwright CLI / UE Build）。
- 不替换已有成熟工具（pre-commit / nox / ruff）。
- 安全边界：声明与授权分离，仓库不能自我扩权。

---

## 一、P0-A：Git 分支语义修复

**状态：✅ 已完成**

### 1.1 问题

`git_branch(action=create)` 只创建 ref（`git branch <name> HEAD`），不 checkout。worktree 保持 detached，后续 commit 可能丢失。

### 1.2 方案

| 场景 | 执行命令 | branchCreated | checkedOut |
|------|----------|:---:|:---:|
| `create(checkout=true, 分支不存在)` | `git switch -c <name> <startPoint>` | true | true |
| `create(checkout=true, 分支已存在)` | `git switch <name>` | false | true |
| `create(checkout=false, 分支不存在)` | `git branch <name> <startPoint>` | true | false |
| `create(checkout=false, 分支已存在)` | 报错 `GIT_BRANCH_EXISTS` | — | — |
| `switch` | 不变 | — | — |

新增参数：`checkout`（默认 true）、`startPoint`（默认 HEAD）。

### 1.3 返回结构

```json
{
  "currentBranch": "feat/example",  // null if detached
  "detached": false,
  "branchCreated": true,
  "checkedOut": true,
  "branches": [...],
  "action": "create"
}
```

### 1.4 改动文件

| 文件 | 行号 | 改动 |
|------|------|------|
| `src/git-tools.ts` | 232-338 | 重写 `manageGitBranch` create 逻辑 |
| `src/server.ts` | 2573-2644 | schema 增加 `checkout`/`startPoint`，输出增加 | `detached`/`currentBranch`

### 1.5 验证

- [x] typecheck 通过
- [x] build 通过
- [x] healthz 确认服务器加载新代码
- [ ] ChatGPT 端到端测试：`git_branch create` → 确认 currentBranch 非空

---

## 二、P0-B：声明式 `project_task`

### 2.1 设计

两个执行模式：`run`（短任务，等退出）和 `session`（长任务，返回句柄）。

### 2.2 任务声明文件

项目仓库中放置 `.devspace/tasks.yaml`：

```yaml
version: 1

tasks:
  # --- 短任务（run mode） ---

  project-memory-compose:
    mode: run
    command: ["python", "scripts/manage_project_memory.py", "compose", "--write"]
    runtime: workspace-python
    timeout_seconds: 300

  project-memory-validate:
    mode: run
    command: ["python", "scripts/manage_project_memory.py", "validate"]
    runtime: workspace-python
    timeout_seconds: 300

  documentation-write:
    mode: run
    command: ["python", "docs/manage_documentation_system.py", "write"]
    runtime: workspace-python
    timeout_seconds: 300

  documentation-check:
    mode: run
    command: ["python", "docs/manage_documentation_system.py", "check"]
    runtime: workspace-python
    timeout_seconds: 300

  final-gate:
    mode: run
    command: ["nox", "-s", "final-gate"]
    runtime: workspace-python
    timeout_seconds: 1800

  pre-commit-all:
    mode: run
    command: ["pre-commit", "run", "--all-files"]
    runtime: workspace-python
    timeout_seconds: 600

  gameplay-r5-run:
    mode: run
    command:
      - python
      - -m
      - agent_core.worldwright_agent.cli
      - execute-gameplay-prototype-slice
      - --run-root
      - ${run_root}
    runtime: workspace-python
    timeout_seconds: 3600
    parameters:
      run_root:
        type: path
        required: true

  ue-editor-build:
    mode: run
    command:
      - ${ubt}
      - WorldwrightSmokeEditor
      - Win64
      - Development
      - -Project=${uproject}
      - -WaitMutex
      - -FromMsBuild
    runtime: system
    timeout_seconds: 7200
    parameters:
      ubt:
        type: path
        required: true
      uproject:
        type: path
        required: true

  # --- 长任务（session mode） ---

  ue-gameplay-session:
    mode: session
    command:
      - ${unreal_editor}
      - ${uproject}
      - ${target_map}
      - -game
      - -WorldwrightGameplayPrototypePlan=${plan}
      - -WorldwrightGameplayPrototypeReport=${report}
      - -WorldwrightGameplayPrototypeAttemptId=${attempt_id}
      - -log
    runtime: system
    timeout_seconds: 1800
    parameters:
      unreal_editor:
        type: path
        required: true
      uproject:
        type: path
        required: true
      target_map:
        type: string
        required: true
      plan:
        type: path
        required: true
      report:
        type: path
        required: true
      attempt_id:
        type: string
        required: true
```

### 2.3 安全模型：声明与授权分离

```
仓库声明任务 (.devspace/tasks.yaml)
        +
Workspace 授权 (manifest SHA + approved task list)
```

**关键约束**：Agent 不能修改 `.devspace/tasks.yaml` 后立即执行新命令。授权流程：

```
打开 workspace 时：
  1. 扫描 .devspace/tasks.yaml
  2. 计算 manifest SHA-256
  3. 对比上次审批的 SHA
  4. 若 SHA 变更 → 旧授权失效 → 需要重新审批
  5. 审批通过 → 记录新的 manifest SHA + approved task IDs
  6. 调用时：验证 task ID 在 approved 列表中
```

### 2.4 MCP 工具设计

#### `project_task` (run mode)

```json
{
  "workspaceId": "...",
  "task": "project-memory-compose",
  "params": {}
}
```

返回：

```json
{
  "task": "project-memory-compose",
  "mode": "run",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "durationMs": 12345,
  "runtime": {
    "interpreter": "F:/Code/GIT/worldwright/.venv/Scripts/python.exe",
    "pythonVersion": "3.11.9",
    "environmentSource": ".venv"
  },
  "changedFiles": [
    ".project-memory/feature-index.yaml",
    ".project-memory/contract-index.yaml"
  ]
}
```

#### `project_task` (session mode)

```json
{
  "workspaceId": "...",
  "task": "ue-gameplay-session",
  "params": {
    "unreal_editor": "D:/UE_5.6/Engine/Binaries/Win64/UnrealEditor.exe",
    "uproject": "D:/UEProjects/WorldwrightSmoke/WorldwrightSmoke.uproject",
    "target_map": "/Game/Worldwright/Generated/TargetLevel",
    "plan": "...",
    "report": "...",
    "attempt_id": "..."
  }
}
```

返回：

```json
{
  "task": "ue-gameplay-session",
  "mode": "session",
  "taskSessionId": "task_a1b2c3d4",
  "status": "running",
  "pid": 12345
}
```

#### 通用 session 操作

| 工具 | 说明 |
|------|------|
| `poll_task` | 轮询 session 状态 + 新日志 |
| `read_task_log` | 读取日志 |
| `wait_task` | 阻塞等待完成 |
| `stop_task` | 终止进程树 |
| `collect_task_artifacts` | 收集生成文件 |

### 2.5 Runtime 解析

```
task.runtime 声明 → 优先级：
  1. workspace 绑定的 Python 环境
  2. 项目 .venv（复用现有 resolveWorkspacePytestInvocation 路径检测）
  3. 系统 PATH 中的受信任解释器
```

返回中必须明确：

```json
{
  "interpreter": "...",
  "environmentSource": ".venv | workspace | system",
  "environmentHash": "..."
}
```

### 2.6 参数类型

| type | 校验 |
|------|------|
| `string` | 任意字符串 |
| `path` | 必须在 allowedRoots 或 additionalRoots 内 |
| `sha256` | `^[0-9a-f]{64}$` |
| `int` | 整数，可设 min/max |

**禁止**：自由 `extraArgs` 追加。所有参数必须声明。

### 2.7 与现有 start_job 的关系

复用 `background-jobs.ts` 的进程管理 + artifact 收集 + venv 检测，`project_task` 作为更高层的声明式包装。不重新实现进程生命周期。

### 2.8 实现清单

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1 | `src/task-manifest.ts` (新) | 解析 `.devspace/tasks.yaml`，SHA-256 计算，审批状态管理 |
| 2 | `src/task-manifest.test.ts` (新) | manifest 解析、SHA 变更检测、审批流程测试 |
| 3 | `src/task-runner.ts` (新) | run/session 执行，参数解析，runtime 检测，进程管理 |
| 4 | `src/server.ts` | 注册 `project_task`、`poll_task`、`stop_task` 等工具 |
| 5 | `src/workspaces.ts` | workspace 存储 approved manifest SHA + task IDs |
| 6 | 集成测试 | Worldwright 真实 tasks.yaml + 端到端测试 |

---

## 三、P0-C：`additionalRoots`

### 3.1 设计

workspace 级额外根目录授权，根级 `read_only` / `read_write`，不做子路径 ACL。

### 3.2 配置

打开/恢复 workspace 时声明：

```json
{
  "path": "F:\\Code\\GIT\\worldwright",
  "additionalRoots": [
    {
      "path": "D:\\UEProjects\\WorldwrightSmoke",
      "access": "read_write"
    },
    {
      "path": "D:\\ReferenceAssets",
      "access": "read_only"
    }
  ]
}
```

### 3.3 安全约束

| 规则 | 说明 |
|------|------|
| workspace 级授权 | 不由仓库配置控制，`open_workspace`/`resume_workspace` 时指定 |
| junction/symlink 解析 | 解析真实路径后重新检查是否在 allowed root 内 |
| 父目录不可逃逸 | 允许 `D:\UEProjects\WorldwrightSmoke` 不意味着允许 `D:\` |
| 不可自行扩权 | 仓库内 `.devspace/tasks.yaml` 不能声明额外的 root |

### 3.4 实现清单

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1 | `src/config.ts` | `additionalRoots` 类型定义 |
| 2 | `src/workspaces.ts` | workspace 结构增加 `additionalRoots` 字段 |
| 3 | `src/security.ts` | `isPathAllowed(root, additionalRoots)` — 跨 root 路径检查，junction 解析 |
| 4 | `src/server.ts` | `open_workspace`/`resume_workspace` schema 增加 `additionalRoots` 参数 |
| 5 | 测试 | junction 解析、逃逸检测、只读拒绝写入 |

---

## 四、实施顺序

```
Phase 1: P0-A (✅ 已完成)
Phase 2: P0-C additionalRoots         ← 安全底座，比 task 更基础
Phase 3: P0-B project_task (run 模式)
Phase 4: P0-B project_task (session 模式)
```

理由：`project_task` 需要 additionalRoots 来做跨盘路径校验，所以先做 P0-C。

---

## 五、不做清单

以下**不会**实现在 DevSpace 中：

- Project Memory Runner
- Documentation System Runner
- Ruff Runner
- Worldwright CLI Runner
- UE Project Build Runner
- UE Game Session Runner（UE 专用）
- `git_diff_check` 专用工具
- 通用 Python 环境管理工具链（单独 MCP 工具）
- 子目录 ACL（`Content: read, Saved: read_write`）
- Repository Gate 聚合工具

以上全部由 `project_task` + 项目声明（`.devspace/tasks.yaml`）+ 项目工具链（nox/pre-commit）覆盖。

---

## 六、验收标准

完成定义**不是**「工具出现在列表里」，而是真实通过端到端验收：

```text
恢复 Worldwright workspace
→ git_branch create + checkout → 确认 currentBranch 非 detached
→ project_task: project-memory-compose → exit 0
→ project_task: project-memory-validate → exit 0
→ project_task: documentation-write → exit 0
→ project_task: final-gate → exit 0
→ git stage explicit paths
→ git commit
→ 安全 merge master（master 干净前提下）
→ D 盘 fresh Run（通过 additionalRoots + project_task: gameplay-r5-run）
→ UE build（通过 additionalRoots + project_task: ue-editor-build）
```

