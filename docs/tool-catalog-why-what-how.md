# DevSpace 工具目录：Why / What / How

本文描述当前 DevSpace Agent Harness 的完整工具能力，以及每项能力存在的原因、实际行为和正确调用方式。

## 先理解数量

- DevSpace 共有 **59 个独立工具能力**。
- 因为短命名和兼容命名并存，共有 **66 个可能出现的工具名**。
- 以下 7 对名称分别指向同一个能力：
  - `read` / `read_file`
  - `write` / `write_file`
  - `edit` / `edit_file`
  - `grep` / `grep_files`
  - `glob` / `find_files`
  - `ls` / `list_directory`
  - `bash` / `run_shell`
- 单个 MCP Connector 不会同时暴露所有名称。实际工具集取决于只读模式、最小工具模式、Widget 模式、Git 远程写策略和工具命名模式。
- `report_workspace_app_error` 只允许嵌入式 Workspace App 调用，不开放给模型。
- `bash` / `run_shell` 虽然有注册和 UI 兼容能力，但当前安全公网配置不向模型开放任意 Shell。

## 1. 服务诊断与运行环境

| Tool                         | Why：为什么需要                                                                       | What：做什么                                                                                      | How：怎么用                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `devspace_info`              | 判断“代码已更新”与“正在运行的服务已更新”是不是同一件事，诊断 Connector 缓存和旧进程。 | 返回版本、boot ID、schema 指纹、启用工具、允许根目录和后台 Job 上限，不返回凭据或环境变量。       | 重启、部署或发现工具数量不对时先调用；对照 boot ID、schema revision 和 tool names。              |
| `houdini_info`               | 在启动昂贵 Houdini 作业前，先区分安装、架构、版本和许可证问题。                       | 只读检查可信 Houdini 可执行文件、产品类型、版本、架构和许可证可用性。不会登录、激活或修改许可证。 | 调用 Houdini Runner 前使用；如果不可用，根据结构化诊断处理安装或许可证，而不是直接反复启动 Job。 |
| `report_workspace_app_error` | 浏览器里的 Workspace App 报错如果只留在 WebGPT 页面，本地服务无法审计和归因。         | 记录经过清洗、限长的 App 运行时诊断；拒绝聊天内容、URL、堆栈、工具参数等敏感载荷。                | 由嵌入式 App 自动调用；模型和用户不应直接调用。错误可在本地 monitor 中查看。                     |

## 2. Workspace 生命周期与上下文

| Tool                       | Why                                                                             | What                                                                                                  | How                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `open_workspace`           | 所有本地操作必须先绑定到一个经过批准的目录，避免工具直接接受任意绝对路径。      | 打开 checkout 或 managed worktree，返回 `workspaceId`、根目录、AGENTS.md、技能和授权状态。            | 每个项目目录或 worktree 只调用一次；后续所有工具复用同一 `workspaceId`。只有切换目录、模式、ID 失效或用户要求重开时才再次调用。 |
| `list_workspaces`          | WebGPT、Connector 或 DevSpace 重连后，模型可能丢失之前的 `workspaceId`。        | 列出仍符合当前根目录策略的最近 Workspace，并标记是否可恢复、路径是否存在、当前分支状态。              | 重连后先调用；找到目标 `workspaceId`，再交给 `resume_workspace`。不要根据历史路径自行重建 worktree。                            |
| `resume_workspace`         | 恢复旧 Workspace 时必须重新验证当前策略、目录和 Git 状态，不能盲信旧快照。      | 使用持久化 `workspaceId` 恢复 checkout/worktree，重新加载指令和技能，并探测实时分支或 detached 状态。 | 使用 `list_workspaces` 返回的 ID；服务重启后如需 additional roots，必须重新显式授权。                                           |
| `project_memory_preflight` | 某些仓库需要在新任务开始前读取外部 Project Memory，但不能让它隐式阻断正常工具。 | 向操作员配置的仓库命令发送当前任务，返回限量上下文和 receipt；当前为 SHADOW 模式。                    | 每个新任务调用一次，后续工具带上 `projectMemoryReceiptId`。把结果视为上下文证据，不把 SHADOW 判定当硬权限。                     |

## 3. 文件读取、搜索与编辑

| Tool                    | Why                                                                     | What                                                                                | How                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `read` / `read_file`    | 给模型一个受 Workspace 边界约束、可审计的文件读取入口。                 | 读取 Workspace 内文件的指定范围；进入新的指令目录时可同时返回尚未加载的 AGENTS.md。 | 先 `open_workspace`；优先用它读文件，不用 Shell 的 `cat`/`sed` 代替。大文件分段读取。                            |
| `grep` / `grep_files`   | 修改前先定位符号和调用点，减少无目标的大范围读取。                      | 在 Workspace 内按文本或正则搜索内容，遵守项目 ignore 规则。                         | 先搜索再读取；使用窄 pattern、路径或扩展名过滤，避免一次返回过多匹配。                                           |
| `glob` / `find_files`   | 在不知道准确文件名时安全地发现候选文件。                                | 按 glob 查找 Workspace 内文件，遵守 ignore 规则。                                   | 用于 `**/*.ts`、`docs/**/*.md` 等文件发现；得到候选后再 `read`。                                                 |
| `ls` / `list_directory` | 在读取或修改前确认目录结构和目标类型。                                  | 列出 Workspace 内一个目录的受限内容。                                               | 用于窄目录检查；不要拿它递归扫描整个大型仓库。                                                                   |
| `write` / `write_file`  | 支持创建新文件，同时防止模型无意覆盖已有内容。                          | 创建完整文本文件；已有文件默认拒绝，只有显式 `overwrite=true` 才能完整重写。        | 主要用于新文件；已有文件优先用 `edit`。完整重写前先读文件并确认确实需要覆盖。                                    |
| `edit` / `edit_file`    | 让代码修改保持小、明确、可验证，而不是整文件重写。                      | 用唯一、非重叠的 `oldText → newText` 精确替换编辑一个文件。                         | 先读取目标上下文；让 `oldText` 足够唯一。一次组织相关替换，失败时重新读取而不是盲目重试。                        |
| `mkdir`                 | 创建工具输出、测试或文档所需目录，而不借助任意 Shell。                  | 在 Workspace 内创建真实嵌套目录；已有真实目录时幂等成功。                           | 传 Workspace 相对路径；不要用它绕过 approved roots。                                                             |
| `copy`                  | 需要复制模板或资产时，保证源和目标都在 Workspace 内且没有危险目录合并。 | 复制普通文件或无 symlink 的目录树；禁止目录合并和替换。                             | 明确提供源、目标；目标存在或树中含不允许的链接时先处理冲突。                                                     |
| `move`                  | 支持安全重命名和目录整理，同时避免跨设备或隐式覆盖。                    | 原子移动普通文件或真实目录；禁止替换目录和跨设备移动。                              | 用于同一 Workspace 内的重命名/迁移；先确认目标不存在。                                                           |
| `move_to_trash`         | 删除是高风险操作，需要可恢复而不是永久清除。                            | 把 Workspace 文件或目录移到 DevSpace 私有隔离区，不永久删除。                       | 用户明确要求移除时使用；记录移动了什么以及是否可恢复。                                                           |
| `show_changes`          | WebGPT 的富 UI 需要把多次文件修改汇总成人可读审查点。                   | 显示从上次 checkpoint 或打开 Workspace 以来的聚合文件变化。                         | 完成一组相关写入/编辑后调用一次；不要每个小修改都调用。仅在相应 Widget 模式下暴露。                              |
| `bash` / `run_shell`    | 某些构建、测试和搜索只能由命令行完成。                                  | 在 Workspace 范围运行受策略控制的命令。                                             | 只用于测试、构建、Git 只读检查和包脚本；当前安全公网 Connector 不开放任意 Shell，优先使用专用工具或 Job Runner。 |

## 4. 文件与图片导入

| Tool                      | Why                                                                                     | What                                                                                                                                   | How                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `import_asset`            | 二进制资产不能安全地通过普通文本写入工具传输。                                          | 从一个公共 HTTPS URL 或标准 Base64 导入 PNG、JPEG、WEBP、GLB、WAV、OGG；验证签名、大小、路径、哈希和覆盖策略，并登记 Artifact Ledger。 | 提供恰好一个来源和 Workspace 相对目标；如需覆盖必须显式声明并满足策略。                               |
| `import_png`              | WebGPT 原生附件不一定有公共 URL，需要专门处理 ChatGPT 文件对象和下载超时。              | 从 ChatGPT 文件附件、公共 HTTPS 结果 URL 或 Base64 导入原始 PNG，并生成可审计 receipt。                                                | WebGPT 附件优先传 `file`；URL/Base64 只选一个。收到 receipt 后再把图片视为已真实落地。                |
| `archive_approved_image`  | “模型生成了图片”不等于“人类批准它用于生产”。批准状态需要不可变证据。                    | 冻结一张已人工批准的 PNG，写入项目 receipt，并更新可重建 SQLite 索引。                                                                 | 人工明确批准后调用；传文件或已有 import receipt 二选一。它只记录批准，不自动运行 Blender/Godot 流程。 |
| `find_approved_assets`    | 后续生产流程需要按项目、任务、角色或来源找到已经批准的资产。                            | 查询批准资产索引，默认返回摘要，不授予历史文件字节访问。                                                                               | 使用尽可能明确的 project/task/role/path/file ID 条件；再对候选调用 `verify_approved_asset`。          |
| `verify_approved_asset`   | 索引记录、receipt 和当前文件可能漂移，进入生产前必须重新核验。                          | 比对 SQLite、不可变 receipt、当前 PNG、SHA-256、尺寸和 supersession 状态。                                                             | 每次进入正式管线前调用；只有 `readyForPipeline=true` 才能作为当前权威资产。                           |
| `recover_approved_asset`  | 已批准的本地 PNG 丢失时，需要从原始 ChatGPT/File Library 文件恢复，但不能覆盖不同内容。 | 在 file ID、SHA-256、尺寸、路径和 receipt 全部一致后恢复缺失文件。                                                                     | 只用于“文件缺失”；如果目标存在但字节不同，先调查，工具会拒绝覆盖。                                    |
| `reindex_approved_assets` | SQLite 是可重建缓存，不能成为批准事实的唯一来源。                                       | 扫描受限目录中的不可变 `*.approved-asset-receipt.json`，重建批准资产索引。                                                             | 索引损坏、迁移或缺记录时使用；项目 receipt 始终是权威来源。                                           |

## 5. Git 本地操作

| Tool                | Why                                                                 | What                                                                                   | How                                                                                   |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `git_status`        | 所有编辑、提交、合并和推送前都需要确认工作区边界和脏状态。          | 在 Workspace 根恰好等于 Git 根时读取本地状态。                                         | 修改前后、合并前、提交前都调用；不要把另一个 worktree 的状态当成当前 Workspace 状态。 |
| `git_diff`          | 提交必须基于可复核的准确补丁，而不是模型记忆。                      | 读取受限 Git patch，并返回完整 patch SHA-256；禁用外部 diff 工具。                     | 提交前审查 staged diff；把返回的 SHA 交给 `git_commit` 做防陈旧校验。                 |
| `git_stage_paths`   | `git add .` 范围太宽，容易夹带用户无关改动。                        | 只把显式、受限的 Workspace 相对路径加入 index。                                        | 列出本次任务确切文件；stage 后重新 `git_diff` 检查。                                  |
| `git_unstage_paths` | 发现误暂存时需要安全撤回 index，而不丢失工作区内容。                | 从 index 撤出显式路径，不删除工作区文件。                                              | 只传需要撤出的路径；之后重新确认 status/diff。                                        |
| `git_commit`        | 防止审查后 staged 内容被改变，并避免 hooks 或签名执行任意本地代码。 | 只有 staged diff SHA 仍匹配时创建一个本地提交；禁用 hooks 和 GPG signing。             | 先 `git_diff` 获取 reviewed SHA，再携带 SHA 和明确 commit message 调用。              |
| `git_branch`        | Agent 工作需要隔离分支，但不应开放任意危险 Git 子命令。             | 列出、创建或切换本地分支；创建可选择是否 checkout。禁止删除、force、merge 和远程操作。 | 默认用 `codex/` 前缀创建任务分支；切换前保持工作区干净。                              |

## 6. Git 远程操作

| Tool        | Why                                                                  | What                                                                                                            | How                                                                                             |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `git_fetch` | 合并/推送判断必须基于最新远端状态，同时不能接受任意 URL 或 refspec。 | 从操作员批准的现有 remote 获取并报告 tracking ref 变化；保证 HEAD、index、worktree 不变。                       | 合并和推送前调用；只提供批准 remote 名，不提供 URL。                                            |
| `git_merge` | 自动合并必须防止陈旧 SHA、恶意 hooks/driver/filter 和冲突残留。      | 在干净、attached Workspace 中执行 `ff_only` 或 `no_ff`；验证 expected SHA，冲突时自动 abort 回原状态。          | fetch 后提供确切来源 commit 和预期 HEAD；根据历史要求选择 fast-forward 或 no-ff。               |
| `git_push`  | 远程写入不可逆且可能覆盖他人工作，需要 compare-and-swap。            | 推送一个确切本地 commit 到批准 remote branch；先 fetch，验证本地/远端 SHA 和 fast-forward，原子推送后再次验证。 | 仅在 `gitRemoteWrite` 开启且用户明确授权时调用；绝不支持 force、删除、tag、URL 或任意 refspec。 |

## 7. 后台 Job 与 Capture

| Tool            | Why                                                                          | What                                                                                                              | How                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `start_job`     | 构建、测试、Blender、Houdini 等长任务不能占住模型回合或接受任意可执行文件。  | 从批准 Runner Registry 选择 runner，以参数数组、无 Shell、受限 cwd 启动持久化 Job；限制时长、输出和并发。         | 选择 `npm`、`pytest`、`blender`、`hython` 等已批准 runner；保存返回的 `jobId` 和 `outputCursor`，然后调用 `wait_job`。 |
| `start_capture` | Godot 证据捕获需要项目自己声明场景、相机和输出契约，而不是让模型拼任意命令。 | 加载 `.devspace/captures/<name>.json`，严格验证 Godot runner、参数、路径、超时和产物根，再进入同一 Job 生命周期。 | 项目先提交 capture profile；调用后使用 `wait_job`，完成后检查 Artifact Ledger。                                        |
| `wait_job`      | 高频 `poll_job` 会让 WebGPT 形成长工具链并增加回复流中断概率。               | 在 DevSpace 本地等待 Job settle，默认 20 秒、最长 30 秒；只返回 cursor 之后最多约 2KB 的增量尾部。                | 正常等待一律使用它；每次复用返回的 `outputCursor`。若仍在运行，再调用一次，而不是几秒一次快速轮询。                    |
| `list_jobs`     | WebGPT 中断后可能忘记 `jobId`，但后台 Job 仍然存在。                         | 按 Workspace 列出最近或仍活跃 Job 的受限元数据。                                                                  | 用户说“继续”或重连后调用；找到目标 Job，再用 `wait_job`，如需最新尾部可省略旧 cursor。                                 |
| `poll_job`      | 调试时仍需要读取指定日志字节范围，也要兼容旧客户端。                         | 立即返回状态和一个受限日志区间，提供下一 byte offset。                                                            | 只用于显式分页读取或兼容旧流程；正常等待不要用它反复轮询。                                                             |
| `cancel_job`    | 长任务必须可受控停止，并确保子进程组不会残留。                               | 请求 graceful termination，必要时强制终止；已完成 Job 幂等返回。                                                  | 用户要求停止、超时或确认任务错误时调用；随后用 `wait_job` 等待最终 `cancelled`/终态。                                  |

## 8. Artifact Ledger、预览与检查器

| Tool                   | Why                                                              | What                                                                                                  | How                                                                         |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `list_artifacts`       | 文件存在不等于它属于哪次 Job、哪个版本或是否完整。               | 列出 declared artifact roots 中发现的版本化产物，含 SHA、producer、完成状态、Git 状态和当前是否存在。 | Job 完成后按 `jobId`、路径前缀或类型过滤；选择准确 artifact 继续检查。      |
| `inspect_artifact`     | 打开二进制或容器文件前需要安全、非执行式元数据检查。             | 按 `artifactId` 或路径检查 Workspace 产物，返回 SHA 快照和受限容器元数据。                            | 优先使用 `artifactId` 锁定版本；不要把检查结果误当成人工视觉/听觉批准。     |
| `preview_artifact`     | 临时查看工作中图片或音频不一定需要把它纳入正式 Artifact Ledger。 | 为 PNG/JPEG/WEBP/WAV/OGG 创建十分钟、绑定哈希的临时预览。                                             | 用于快速迭代；路径内容变化后旧 URL 自动失去权威性。                         |
| `publish_artifact`     | WebGPT 需要访问本地证据，但不能获得永久或宽范围公开链接。        | 对已注册 artifact 重新核验路径、类型、大小和 SHA，生成高熵、短时 URL；重启后失效。                    | 正式评审优先按 `artifactId` 发布准确版本；只发布需要评审的单个产物。        |
| `inspect_glb`          | GLB 基础结构检查不应执行 Blender 或外部代码。                    | 直接用 TypeScript 解析 GLB v2 header 和 JSON chunk。                                                  | 用于验证版本、scene、mesh/material 等结构；视觉质量仍需渲染后人工判断。     |
| `inspect_blend`        | BLEND 检查需要 Blender，但必须禁用文件中的自动执行能力。         | 使用固定、离线、禁用 auto-execution 的 Blender inspector 打开源文件，不保存原文件。                   | 用于读取 scene、object、material 等结构；不要把检查过程当作生产编辑。       |
| `inspect_audio`        | 音频是否削波、峰值多高不能只靠文件扩展名判断。                   | 读取 WAV/OGG 元数据，并用固定 ffmpeg float-PCM 解码计算 peak/clipping 指标。                          | 用于技术质量门禁；最终音乐和听感仍需要人工试听。                            |
| `render_model_preview` | BLEND/GLB 需要一致的相机、灯光和背景才能做可比较技术预览。       | 用固定渲染配置生成受限尺寸的私有预览证据。                                                            | 先 inspect，再 render；用它做可重复技术比较，不替代最终美术镜头和人工批准。 |

## 9. Godot 游戏运行时 Session

| Tool                   | Why                                                                          | What                                                                                | How                                                                           |
| ---------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `start_game_session`   | 游戏交互测试需要一个持续运行、身份固定的 Godot 实例，而不是每步重新启动。    | 通过 loopback Runtime Bridge 启动一个 Workspace 场景；DevSpace 选择引擎并构造参数。 | 提供 Workspace 和批准场景/profile；保存 `sessionId`，后续所有游戏工具复用它。 |
| `inspect_game_session` | Agent 需要知道进程是否还是原来的实例、场景是否存活，而不能读取无限场景数据。 | 返回 session 身份、固定源码快照、heartbeat、退出状态和受限 scene tree。             | 输入或截图前调用；确认 session、source snapshot 和目标节点仍一致。            |
| `send_game_input`      | 自动化需要操作游戏，但不能生成全局桌面键鼠事件。                             | 向 DevSpace 自己的 Godot Session 注入一个 InputMap action 或 viewport 内鼠标点击。  | 每次只发一个明确动作；坐标必须基于当前 viewport，不能控制其他桌面 App。       |
| `capture_game_frame`   | 运行态视觉证据需要与具体 Session 和源码快照绑定。                            | 把当前 viewport 捕获为私有 PNG，并返回受限图像内容。                                | 在稳定帧和明确状态下调用；保存它用于评审，但仍需人工视觉判断。                |
| `read_game_logs`       | 运行期错误和 Bridge 事件需要增量读取，避免反复重传完整日志。                 | 按 byte offset 读取 stdout、stderr、Godot diagnostics 和 Bridge 生命周期事件。      | 复用返回 offset；优先定位最近错误，不要每次从 0 开始。                        |
| `stop_game_session`    | 运行时必须可回收，且不能留下孤儿 Godot 进程。                                | 先请求 Bridge 优雅退出，必要时终止经过验证的 DevSpace 进程组；重复调用幂等。        | 测试完成或状态异常时调用；随后确认 session 已进入终态。                       |

## 10. 声明式 Project Task

| Tool                    | Why                                                                            | What                                                                                                | How                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `approve_task_manifest` | 项目预声明命令仍可能被修改，运行前需要把批准绑定到 manifest SHA。              | 批准 `.devspace/tasks.yaml` 当前版本；任何内容变化都会使批准失效。                                  | 人工审查 manifest 后调用；修改 manifest 后必须重新批准。                              |
| `project_task`          | 有些项目操作需要比 Runner 更具体的固定命令和参数契约，但仍不能开放任意 Shell。 | 执行 `.devspace/tasks.yaml` 中命名、预批准的任务，使用固定 executable/args 和受 schema 约束的参数。 | 先批准 manifest，再按 task ID 和声明参数调用；不能覆盖 executable、环境或未声明参数。 |
| `poll_task`             | Project Task session 可能持续运行，需要读取状态和最近输出。                    | 返回运行中任务 session 的状态和受限近期输出。                                                       | 使用 `project_task` 返回的 session/run ID；控制轮询频率并复用会话身份。               |
| `stop_task`             | 声明式任务也必须允许人工中止。                                                 | 终止一个正在运行的 Task session。                                                                   | 用户要求停止或任务明显异常时调用；之后用 `poll_task` 确认终态。                       |

## 推荐的 Harness 工作流

### 普通代码任务

```text
list_workspaces/resume_workspace 或 open_workspace
→ project_memory_preflight（配置仓库）
→ grep/glob/ls
→ read
→ edit/write
→ 测试
→ show_changes 或 git_diff
→ git_stage_paths
→ git_diff（staged SHA）
→ git_commit
```

### 长时间构建、DCC 或捕获任务

```text
start_job/start_capture
→ wait_job
→ （中断后 list_jobs → wait_job）
→ list_artifacts
→ inspect_artifact/专用 inspector
→ preview_artifact 或 publish_artifact
→ 人工评审
```

### 安全合并与推送

```text
git_status
→ git_fetch
→ 校验 expected local/remote SHA
→ git_merge
→ 测试
→ git_push
→ 再次 fetch/核验远端 SHA
```

## 最重要的边界

DevSpace 工具解决的是：

- 本地执行是否被批准；
- 输入是否受限；
- 任务是否持久、可恢复；
- 输出是否有边界；
- 修改和产物是否可审计；
- Git 远程写入是否满足精确前置条件。

DevSpace 不替外部模型决定“下一步应该做什么”，也不把技术检查自动升级为人工美术、视觉或听觉批准。外部 Agent 负责推理和规划，DevSpace 负责提供安全、持久、可恢复、可审计的执行 Harness。
