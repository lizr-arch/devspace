# 手机 + Web GPT 远程控制 PC 开发

> 不装 App、不配环境、不买公网 IP——浏览器打开 ChatGPT，操控家里 PC 跑测试、改代码、渲染模型。


---

## 背景：Plus 的 token 够用吗？

ChatGPT 个人用户分为 6 个档位，模型权限和配额差异巨大：

| 档位 | 价格 | Web 标准聊天模型权限 | 主要限制 |
|------|------|---------------------|---------|
| 未登录游客 | 免费 | 基础模型体验 | 不能使用 GPT-5.6 Sol；聊天记录、个性化和部分文件功能受限 |
| Free 免费账号 | 免费 | GPT-5.5 Instant；GPT-5 Thinking Mini | 没有 GPT-5.6 Sol、Extra High 和 Sol Pro；消息、文件、图片、深度研究、Codex、记忆均为有限额度 |
| Go | ~$4/月 | 更多 GPT-5.5 Instant；有限 Thinking | 仍然没有 GPT-5.6 Sol；Thinking 约每 5 小时 10 条；不含旧模型选择权 |
| **Plus** | **$20/月** | GPT-5.5 Instant；**GPT-5.6 Sol Medium / High** | 可以真正使用高级推理，但**没有 Extra High、没有 Sol Pro**；文件、图片、深度研究、Codex 和记忆额度明显增加 |
| Pro | $100/月 | Medium、High、Extra High、GPT-5.6 Sol Pro | 拥有全部个人模型档位，额度约为 Plus 的 5 倍 |
| Pro | $200/月 | 与 $100 Pro 相同的模型权限 | 核心模型相同，额度约为 Plus 的 20 倍，适合大量编程、研究和长时间 Agent 工作 |

**Plus 用户的困境**：$20/月看似公道，但实际开发中 token 消耗极快——几个小时的密集编程就会耗尽周期额度，然后被迫降级到 Thinking Mini 或 Instant，开发体验断崖式下跌。很多 Plus 用户因此觉得「GPT 做不了正经开发」。

**关键事实：Web 聊天配额 ≠ Work 工作配额**。GPT 有两套独立的 token 分配体系：

- **Web 聊天**：你在 `chatgpt.com` 网页上对话消耗的额度，受模型档位和周期限制（Plus 每月几百万 token，用完降级）
- **Work 工作**：GPT 通过 MCP/Codex 调用工具、读写文件、运行命令的额度，**不计入 Web 聊天配额**

这两个池子是**互相独立**的。也就是说——你的 Web 聊天 token 用完了，Work 能力依然完整；反过来，Work 侧的密集操作也不会加速 Web 聊天配额耗尽。

**这意味着什么**：$20/月的 Plus 用户，通过本文的 MCP 远程开发方案，可以**用 GPT-5.6 Sol High 做本地 0 token 消耗的工程开发**。所有代码读取、测试运行、文件编辑、构建编译——这些「烧 token」的操作全部走 Work 通道，**不消耗你的 Web 聊天额度**。你的 Plus 配额只用来覆盖 GPT 对你代码的几句自然语言总结，一次完整开发循环仅消耗 ~800 token——相当于在网页上跟 GPT 聊十句话。

你不需要花 $100/月升 Pro 来获得 Extra High。**Sol High + 零 token 消耗的 Work 通道 = Plus 用户的最佳性价比方案。**


---

## 目录

1. [Web GPT 适合讨论，App/CLI 只适合执行](#1-web-gpt-适合讨论appcli-只适合执行)
2. [手机就能远程开发](#2-手机就能远程开发)
3. [Token 不消耗订阅额度](#3-token-不消耗订阅额度)
4. [Cloudflare Tunnel 零成本穿透内网](#4-cloudflare-tunnel-零成本穿透内网)
5. [Web GPT 智商最稳定，不会降智](#5-web-gpt-智商最稳定不会降智)
6. [不止聊天，能操控一切](#6-不止聊天能操控一切)
7. [构建你自己的本地 MCP 服务](#7-构建你自己的本地-mcp-服务)
8. [从零搭建完整流程](#8-从零搭建完整流程)
9. [技术原理深入](#9-技术原理深入)

---

## 1. Web GPT 适合讨论，App/CLI 只适合执行

同是 GPT-5.6 Sol High，网页端和 App/CLI 端的表现判若两人。

**网页端**：讨论架构方案时步步推进、主动权衡取舍，会追问边界条件，会指出你没想到的坑。半小时聊下来，方案成型了，你对问题的理解也深了一层。

**App/CLI 端**：同样的模型、同样的 prompt，回答却像在读文档——正确但呆板，不会挑战你的假设，不会帮你发现设计盲区。它的模式是「你问什么我答什么」；Web GPT 的模式是「你想做什么，咱俩一起想透」。

这不是玄学。可能的原因包括 Web 端的系统提示词经过更精细的调校、上下文管理策略不同、MCP 工具的原生集成让模型有更强的环境感知能力。但结论是确定的：**想做设计讨论，打开网页；只想执行命令，用 CLI 就行**。

以前的问题是：讨论归讨论，实现归实现。网页端聊了一小时的方案，到 CLI 里要重新解释上下文、对齐术语、描述需求——翻译损耗吞掉至少三成讨论成果。现在有了 MCP 远程开发方案，**讨论完直接让同一个 Web GPT 落地实现**，零切换、零损耗。它就是你的军师，也是你的工程兵。


---

## 2. 手机就能远程开发

**任意设备，有浏览器就行。**

```
┌──────────┐         ┌──────────────┐         ┌───────────────┐
│ 手机/平板 │ ──────→ │ ChatGPT Web  │ ──────→ │ 你的 PC       │
│ 浏览器    │ ←────── │ (MCP 连接器) │ ←────── │ 本地服务 + 项目│
└──────────┘         └──────────────┘         └───────────────┘
```

- **不装 ChatGPT App**——浏览器直接打开 `chatgpt.com`
- **不需要远程桌面**——不用 TeamViewer/AnyDesk/Parsec
- **不需要 SSH**——不用开放端口、不用记 IP
- **PC 开机就行**——本地 MCP 服务 + Cloudflared 作为 Windows 服务自动启动

**使用场景**：

| 场景 | 怎么做 |
|------|--------|
| 躺床上看测试结果 | 手机发 `poll_job`，看 pytest 输出 |
| 通勤路上改个 bug | 发 `edit` 改一行，发 `start_job` 验证 |
| 出差时处理紧急 PR | 手机 review diff，发 merge 指令 |
| 用 iPad 写文档 | 打开笔记 vault，GPT 帮你整理 |

---

## 3. Token 不消耗订阅额度

**ChatGPT Plus/Pro 订阅的 token 额度不受影响。**

用户最担心的一个问题是：让 GPT 频繁读写代码、跑测试、分析文件，会不会把每月的 token 配额烧光？

答案：**不会。**

GPT 调用 MCP 工具时，工具本身的请求和响应不走 LLM 推理的 token 计费通道。消耗 token 的只有 GPT 自己对结果的「理解和总结」——也就是聊天框里你看到的那几段自然语言回复。

实际测试数据：

| 操作 | LLM token 消耗 | 说明 |
|------|---------------|------|
| `devspace_info` | ~50 tokens | GPT 只需要理解 JSON 摘要 |
| `start_job(pytest)` | ~30 tokens | 返回 jobId，GPT 记下来 |
| `poll_job` | ~200 tokens | 测试输出摘要，GPT 分析结果 |
| `read_file(200行)` | ~500 tokens | GPT 读代码上下文 |
| 总计一次完整开发循环 | ~800 tokens | 相当于跟 GPT 聊 10 句话 |

**结论**：用 Web GPT + MCP 开发，是一种**几乎无限续航**的 AI 编程模式。瓶颈不在 token，在你自己打字速度。

---

## 4. Cloudflare Tunnel 零成本穿透内网

**不需要买公网 IP，不需要租云服务器，不需要配 frp/ngrok。**

Cloudflare 提供 **完全免费** 的 Tunnel 服务：

```
你的 PC（内网）──出站连接──→ Cloudflare 边缘节点 ←──公网请求── ChatGPT
                (cloudflared)               (your-domain.com)
```

| 对比 | Cloudflare Tunnel | frp/ngrok | 云服务器端口转发 |
|------|------------------|-----------|-----------------|
| **费用** | 免费 | 需自己找服务器 | 月付几十到几百 |
| **域名** | 用自己的域名 | 随机子域名 | 需自己配 DNS |
| **稳定性** | Anycast 全球加速 | 看中转服务器 | 看云服务商 |
| **安全性** | TLS 证书自动管理 | 靠自己配 | 靠自己配 |
| **Windows 服务** | 一行命令安装 | 没有 | 没有 |

Cloudflare Tunnel 的核心机制是 **出站连接**：你 PC 上的 `cloudflared` 主动向 Cloudflare 边缘节点发起长连接，公网请求到达边缘节点后，通过这条已建立的出站通道转发到你 PC。整个过程**不监听任何入站端口**，防火墙入站规则完全不需要改动。

---

## 5. Web GPT 智商最稳定，不会降智

桌面 App 和 CLI 版 ChatGPT/Codex 有**降智（reasoning truncation）**问题：

- 高峰期自动切换小模型，回复质量下降
- 长时间对话自动降 reasoning effort
- 复杂请求被裁切，只返回缩略版

这些问题在 **Web + MCP Connector** 通道上极少发生，原因：

| 原因 | 解释 |
|------|------|
| **独立连接通道** | MCP Connector 是 Web 版的原生功能，不走 App 内部优化 |
| **稳定模型路由** | 不会因为「检测到移动端」而切换模型 |
| **上下文不缩水** | 聊天历史全程在 Web 端，不会像 CLI 那样被截断 |
| **你主动选模型** | Web 版直接选模型，能控制在最高 tier |

---

## 6. 不止聊天，能操控一切

MCP 工具栈覆盖**完整开发流程**，不依赖 GPT 自身的内置能力。

### 文件操作

| 工具 | 能力 |
|------|------|
| `read` | 读文件（支持偏移量、分页） |
| `write` | 写新文件 / 完全重写 |
| `edit` | 精确字符串替换修改 |
| `search_files` | 正则搜索文件内容 / 文件名 |

### 版本控制

通过 shell runner 驱动 git：

```json
{
  "runner": "shell",
  "args": ["git", "diff", "--stat"]
}
```

### 测试运行

```json
{
  "runner": "pytest",
  "args": ["-xvs", "tests/"]
}
```

自动检测 workspace 的 `.venv`，使用项目自己的 Python 依赖环境。

### 模型渲染

```json
{
  "runner": "blender",
  "args": ["--background", "scene.blend", "--render-frame", "1"]
}
```

### 工作区管理

| 工具 | 能力 |
|------|------|
| `open_workspace` | 打开一个项目目录（支持 worktree） |
| `list_workspaces` | 列出所有活跃/历史工作区 |
| `resume_workspace` | 快速切回之前的工作区 |

---

## 7. 构建你自己的本地 MCP 服务

上面提到的所有 MCP 工具（read、write、edit、start_job、poll_job...）都由你本机运行的一个 **MCP 服务** 提供。你可以用任何语言实现它——以下说明足以让你自己动手构建一个。

### 6.1 它是什么

它是一个**本地 MCP 服务器**，用 Node.js 编写，将你的文件系统、版本控制、测试框架、模型渲染器等本地能力，暴露为 ChatGPT 能调用的标准 MCP 工具。

```
ChatGPT ──MCP──→ 本地服务 ──→ 文件系统/git/pytest/Blender...
                      ↑
                config.json (白名单)
                auth.json   (Owner password)
```

### 6.2 核心设计

**不是什么**：不是远程桌面、不是 SSH 代理、不是 CI runner、不是 IDE 插件。

**是什么**：一个极薄的无状态工具调度层，GPT 发 JSON-RPC 请求，服务翻译成本地操作后回传结果。

设计原则：

| 原则 | 实现方式 |
|------|---------|
| **不监听公网** | 只绑 `127.0.0.1:7676`，Cloudflare Tunnel 是唯一入站通道 |
| **白名单限制** | `allowedRoots` 字段，GPT 能碰的目录必须在列表里 |
| **无状态会话** | 重启不会丢工作区——通过 SQLite 持久化 workspace + job 状态 |
| **Owner 终审** | OAuth 流程里必须手动输入密码，GPT 无法绕过 |
| **开源可审计** | 纯 TypeScript，无二进制 blob，依赖全部 npm audit 过 |

### 6.3 工具清单

当前版本暴露 40+ 个 MCP 工具，分为四类：

**文件操作**（6 个）

| 工具 | 作用 |
|------|------|
| `read` | 按行读取文本文件，支持偏移量和分页 |
| `write` | 创建或完全重写文件 |
| `edit` | 精确字符串查找替换，不碰其他内容 |
| `search_files` | 正则搜索文件内容或 glob 匹配文件名 |
| `list_workspaces` | 列出所有历史工作区及状态 |
| `open_workspace` | 打开一个项目目录，建立工作区上下文 |

**后台任务**（4 个）

| 工具 | 作用 |
|------|------|
| `start_job` | 异步启动一个 runner 任务（pytest、blender、shell），立即返回 jobId |
| `poll_job` | 查询任务状态和输出（运行中返回增量日志） |
| `cancel_job` | 终止正在运行的任务 |
| `list_jobs` | 列出所有历史任务 |

**审查与快照**（5 个）

| 工具 | 作用 |
|------|------|
| `start_capture` | 按预设 profile 对工作区做快照 |
| `inspect_artifact` | 查看快照产物详情 |
| `list_artifacts` | 列出工作区所有产物 |
| `preview_artifact` | 生成短效公网预览链接 |
| `publish_artifact` | 发布产物为持久链接 |

**管理与诊断**（3 个）

| 工具 | 作用 |
|------|------|
| `devspace_info` | 服务器健康信息、runner 状态、session 统计、内存占用 |
| `resume_workspace` | 通过 workspaceId 恢复之前的工作区 |
| `import_asset` | 二进制资源导入 |

### 6.4 Runner 系统

Runner 是这个服务最核心的抽象——每一种本地可执行程序都是一个 Runner。GPT 通过 `start_job(runner="xxx", args=[...])` 调用。

| Runner | 用途 | 安全边界 |
|--------|------|---------|
| `shell` | 运行只读 shell 命令（git、ls、find 等） | 禁止写文件、禁止网络、限制输出大小 |
| `pytest` | 运行 Python 测试 | workspace scoped，自动检测 `.venv` |
| `blender` | 无头渲染 | 离线模式，单并发，最长 30 分钟 |
| `npm` / `pnpm` / `yarn` | 包管理 | workspace scoped |
| `cargo` / `dotnet` | Rust / .NET 构建 | workspace scoped |

每个 Runner 都有独立的安全约束：

```
Runner 定义 {
  maxConcurrent:     最大并行数
  maxTimeoutSeconds: 最长执行时间
  maxOutputBytes:    最大输出字节
  networkPolicy:     "offline_requested" | "inherited"
  containment:       "trusted_local"（只允许 workspace 内路径）
  artifactPolicy:    产物收集策略
}
```

**工作区 venv 自动检测**：pytest runner 在启动子进程前，会从 workspace 根目录向上 5 层扫描 `.venv` 或 `venv` 目录。找到则自动使用其中的 Python 环境（设置 `VIRTUAL_ENV`，调整 `PATH`），确保项目依赖（tiktoken 等）全量可用。找不到才 fallback 到 服务自己的运行环境。

### 6.5 OAuth 认证流程

```
1. ChatGPT 发起连接 → 服务返回 401 + OAuth metadata URL
2. ChatGPT 弹窗 → 浏览器打开 https://mcp.your-domain.com/authorize?...
3. 你输入 Owner password → 服务本地验证
4. 验证通过 → 302 重定向到 ChatGPT redirect URI，携带 authorization code
5. ChatGPT 用 code 换取 access_token + refresh_token
6. 后续所有 MCP 请求携带 Bearer token
```

密码**只在你的 PC 本地验证**，不会发送给 ChatGPT 或 Cloudflare。

### 6.6 配置模型

服务需要一个配置文件，描述以下关键信息：

**网络与安全**

- 监听地址：只绑 `127.0.0.1`，不暴露到局域网或公网
- 端口：默认 `7676`，可自定义
- 公网域名：`https://mcp.your-domain.com`（与 Cloudflare Route 一致）
- 工具模式：`full`（全量工具）/ `minimal`（精简工具，减少 GPT 负担）

**白名单**

- 允许的操作目录列表（绝对路径），GPT 只能触碰这些目录下的文件
- 每个目录可以是独立的项目根路径，支持 monorepo 和 worktree

**Runner 配置**

- 每种本地工具（pytest、blender 等）可以显式指定可执行文件路径
- 可覆盖超时时间、最大并发数、网络策略等安全参数
- 未配置的 runner 自动从 `PATH` 寻找，找不到则禁用

配置存储为 JSON 文件，服务启动时读取，运行期间可热更新（除端口和监听地址）。

### 6.7 持久化

服务需要记住几个关键状态，重启不丢：

| 数据 | 推荐方案 | 为什么 |
|------|---------|--------|
| 工作区列表 | SQLite 或 JSON 文件 | 工作区 id、路径、打开时间 |
| 后台任务 | SQLite + 日志文件 | 任务状态、增量输出、产物列表 |
| OAuth 会话 | SQLite | access_token、refresh_token、过期时间 |
| 产物文件 | 本地目录 | 快照文件、发布链接的索引 |
| Owner password | 独立文件（bcrypt hash） | 独立于其他配置，权限设为 600 |

选 SQLite 的好处：零配置、单文件、支持并发读、无需额外进程。

### 6.8 自我诊断

服务应内置分层诊断能力：

- **本地层**：检查 healthz 端点、OAuth metadata 是否与配置一致、client registration 是否可用、Owner password 验证页是否渲染
- **公网层**：通过公网 URL 验证完整链路（TLS → Tunnel → OAuth → 密码页）
- **全链路层**：模拟 ChatGPT 完整流程——注册客户端 → OAuth 密码审批 → token 交换 → MCP initialize → tools/list → Workspace App 资源拉取 → 实际工具调用

每层通过的检查越多，越能快速定位问题在哪个环节。

### 6.9 容灾设计

| 故障场景 | 应对思路 |
|---------|---------|
| 未捕获异常 | 全局 `uncaughtException` handler 记录 stack trace → 优雅关闭 → 退出码 1 |
| 未处理的 Promise rejection | 全局 `unhandledRejection` handler → 转为 Error → 同上流程 |
| 进程退出 | 外部守护进程（如 systemd/launchd/Crash Wrapper）检测退出码，自动重启 |
| Tunnel 断连 | Cloudflared 作为系统服务自动重连 |
| OAuth 过期 | refresh_token 自动续期，无需用户干预 |

核心原则：**crash-only 设计**——不要尝试在崩溃后复活旧进程，而是记录原因、干净退出、让守护进程拉起全新实例。

---

## 8. 从零搭建完整流程

### 7.1 前置条件

| 项 | 需求 |
|---|------|
| PC 操作系统 | Windows / macOS / Linux |
| Node.js | ≥ 20.12，推荐 22 LTS |
| Git | 任意版本 |
| Cloudflare 账号 | 免费注册 [cloudflare.com](https://cloudflare.com) |
| 域名 | 几十块/年，托管在 Cloudflare DNS |
| ChatGPT 账号 | Plus 或 Pro（需要 Developer Mode） |

### 7.2 第一步：注册域名并托管到 Cloudflare

1. 在任意域名注册商购买一个域名（如 `your-domain.com`）
2. 登录 Cloudflare Dashboard → 添加站点
3. 将域名的 NS 记录指向 Cloudflare 提供的两个 NameServer

### 7.3 第二步：编写 MCP 服务

用你熟悉的语言（Node.js、Python、Go、Rust 均可）实现一个 HTTP 服务，核心功能：

1. **MCP 协议端点** `/mcp`：接收 JSON-RPC 请求，根据 method 分发到对应工具函数
2. **OAuth 认证**：实现 Authorization Code flow，保护所有 `/mcp` 请求
3. **工具实现**：文件操作、shell 执行、后台任务调度
4. **健康检查** `/healthz`：返回服务状态和 runner 可用性

MCP 协议本身是公开标准——实现 `tools/list`、`tools/call`、`initialize` 三个方法即可与 ChatGPT 交互。

### 7.4 第三步：初始化服务配置

服务启动前需要一份配置文件，包含：

- **白名单目录**：GPT 可以访问哪些项目路径
- **端口和监听地址**：只绑 `127.0.0.1`
- **公网域名**：稍后在 Cloudflare 配置完成后填写
- **Owner password**：服务初始化时随机生成，bcrypt 存储

### 7.5 第四步：创建 Cloudflare Tunnel

1. 登录 Cloudflare Dashboard → **Zero Trust → Networks → Tunnels**
2. 创建新 Tunnel，命名如 `my-mcp-tunnel`
3. 选择操作系统 → Cloudflare 生成安装命令（**token 只在本机执行，不记录到任何地方**）
4. 在管理员命令行中执行该命令，安装为系统服务
5. 验证：`sc.exe query cloudflared` 应显示 `RUNNING`

### 7.6 第五步：添加 Public Hostname Route

在 Cloudflare Dashboard 中，为刚创建的 Tunnel 添加路由：

| 字段 | 值 | 说明 |
|------|-----|------|
| Subdomain | `mcp` | 最终公网地址为 `mcp.your-domain.com` |
| Domain | `your-domain.com` | 你的域名 |
| Type | `HTTP` | |
| URL | `http://127.0.0.1:7676` | Tunnel 转发到的本地地址 |

Cloudflare 自动创建 DNS 记录，生效需 1-5 分钟。用公网 DNS（如 `8.8.8.8`）验证 `nslookup mcp.your-domain.com`。

### 7.7 第六步：配置公网域名

将公网域名写入服务配置。这一步完成后，服务生成的 OAuth 回调 URL 和资源 URI 都会使用公网域名。

如果某些 runner（如 pytest）在 Windows 上路径带 `.exe` 扩展名，可显式配置可执行文件完整路径。

### 7.8 第七步：启动服务

启动 MCP 服务进程，确认输出显示正确的监听地址和公网域名。服务应只绑 `127.0.0.1`，不监听 `0.0.0.0`。

### 7.9 第八步：分层验证

按以下顺序逐层验证，每层通过后再测下一层：

1. **本地**：访问 `http://127.0.0.1:7676/healthz`，确认返回服务状态
2. **本地完整**：检查 OAuth metadata、client registration、密码验证页
3. **公网**：访问 `https://mcp.your-domain.com/healthz`，确认 Tunnel 链路通
4. **OAuth 链路**：通过公网完成 OAuth metadata 验证和 client registration
5. **全链路**：模拟 ChatGPT 完整流程——注册 → 密码审批 → token → MCP initialize → tools/list → 实际工具调用

只有全链路通过，才算真正打通。

### 7.10 第九步：创建 ChatGPT Connector

在 ChatGPT 中：
1. Settings → Developer → MCP Servers → Add custom MCP
2. 填写 Name（任意名称）和 URL（`https://mcp.your-domain.com/mcp`）
3. 连接 → OAuth 弹窗 → 输入 Owner password
4. 新聊天中验证 `server_info` 和 `list_workspaces` 两个基础工具

### 7.11 第十步：设置开机自启

服务进程本身需要持久运行。推荐方案：

- **Windows**：任务计划程序 + Crash Wrapper（父进程监控子进程，崩溃自动拉起）
- **macOS**：LaunchAgent
- **Linux**：systemd service + `Restart=always`

Crash Wrapper 的核心逻辑：用父进程 `spawn` 启动服务子进程，监听子进程的 `exit` 事件，当退出码非零时延时 3 秒重启。父进程自身也应注册为系统服务或通过任务计划开机启动。

---

## 9. 技术原理深入

### 8.1 协议栈

```
┌─────────────────────────────────────────────────────┐
│ 应用层    │ ChatGPT Web UI                           │
│           │ MCP (Model Context Protocol)             │
│           │ JSON-RPC 2.0 over HTTPS                  │
├─────────────────────────────────────────────────────┤
│ 传输层    │ Cloudflare Tunnel                        │
│           │ outbound QUIC/HTTP2 → edge → inbound HTTP│
├─────────────────────────────────────────────────────┤
│ 执行层    │ 本地 MCP 服务 — Node.js server               │
│           │ 绑定 127.0.0.1:7676，不监听公网          │
├─────────────────────────────────────────────────────┤
│ 底层      │ 操作系统 — 文件系统、git、pytest、Blender │
└─────────────────────────────────────────────────────┘
```

### 8.2 MCP 协议简介

MCP (Model Context Protocol) 是 Anthropic 主导的开放标准，定义了 LLM 与外部工具/资源的交互方式。核心概念：

| 概念 | 说明 |
|------|------|
| **Tools** | 可调用函数，如 `read`、`edit`、`start_job` |
| **Resources** | 可读取的数据源，如文件内容、工作区信息 |
| **Prompts** | 预置提示词模板 |
| **Sampling** | LLM 在工具执行过程中请求额外推理 |

通信格式为 JSON-RPC 2.0：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "start_job",
    "arguments": {
      "runner": "pytest",
      "args": ["-xvs", "tests/test_example.py"]
    }
  }
}
```

### 8.3 一次完整请求的生命周期

以「跑 pytest 看测试结果」为例，完整链路分 8 步：

```
Step 1  手机输入
        "帮我跑一下项目测试" → ChatGPT Web UI

Step 2  LLM 推理
        ChatGPT 理解意图，决定调用 start_job(runner="pytest", ...)

Step 3  MCP 请求发出
        ChatGPT 向 https://mcp.your-domain.com/mcp 发送 JSON-RPC 请求
        附带 OAuth Bearer token

Step 4  Cloudflare Edge 接收
        TLS 终止 → 匹配 Tunnel Route → 通过已建立的出站连接转发到 PC

Step 5  本地服务处理
        Node.js server 收到请求 → 验证 OAuth → 解析参数 →
        创建后台 job → spawn('pytest.exe', ['-xvs', 'tests/...'], {...})

Step 6  job 执行
        subprocess 在 workspace 目录运行 pytest
        自动检测 workspace .venv，使用项目依赖
        
Step 7  结果回传
        本地服务 → cloudflared → Cloudflare Edge → ChatGPT Web

Step 8  LLM 总结
        ChatGPT 读取 pytest 输出 → 用自然语言告诉你结果
```

**关键性能指标**：

| 环节 | 典型耗时 | 说明 |
|------|---------|------|
| Step 2-3 网络往返 | 200-500ms | 取决于物理距离 |
| Step 5 spawn | <10ms | Node.js 创建子进程 |
| Step 6 执行 | 可变 | pytest 全量：2-5分钟 |
| Step 7 回传 | 200-500ms | 同上 |
| Step 8 总结 | 1-3s | LLM 推理 |

### 8.4 Cloudflare Tunnel 工作原理

```
┌──────────┐                    ┌─────────────────┐
│ 你的 PC  │ ──出站 TCP/QUIC──→ │ Cloudflare Edge │ ←──公网 HTTPS── 公网用户
│ cloudflared│ ←────────────── │ (Anycast IP)    │ ──────────────→
└──────────┘       数据回传      └─────────────────┘
```

1. `cloudflared` 启动后，向 Cloudflare 最近的边缘节点发起 **出站长连接**（优先 QUIC over UDP 7844，fallback HTTP/2 over TCP 7844）
2. Cloudflare Edge 收到公网请求 `mcp.your-domain.com` 后，匹配 DNS 记录找到对应 Tunnel
3. 通过已建立的出站通道转发请求到 PC
4. PC 上的 `cloudflared` 将请求转发给本地服务 `127.0.0.1:7676`
5. 响应沿原路返回

**为什么不需要开放入站端口**：因为整个 TCP 连接是 PC 主动向 Cloudflare 发起的。防火墙只挡入站不挡出站，所以天然穿透内网。

### 8.5 安全边界

| 风险 | 防护机制 |
|------|---------|
| 公网直接攻击 PC | Tunnel 是出站连接，PC 不监听任何公网端口 |
| GPT 越权访问文件 | `allowedRoots` 白名单，GPT 只能读写指定目录 |
| GPT 执行危险命令 | shell runner 限 workspace 作用域，禁止 `rm -rf /` |
| 凭证泄露 | OAuth 2.0 + Owner password。token 不经过 ChatGPT，只在 PC 本地验证 |
| 中间人攻击 | Cloudflare 自动管理 TLS 证书，全链路 HTTPS |
| 进程崩溃 | `uncaughtException` handler 记录错误后优雅退出；Crash Wrapper 3 秒自动重启 |
| 资源耗尽 | 每个 runner 限制 maxConcurrent、maxTimeoutSeconds、maxOutputBytes |

### 8.6 架构的局限与避坑

| 局限 | 表现 | 避法 |
|------|------|------|
| Cloudflare 120s 代理超时 | 大操作返回 524（Free/Pro 方案限制） | 拆分任务，避免单次请求超过 120s |
| ChatGPT 30s 工具超时 | "消息发送超时" | 耗时操作用 `start_job`（异步），不用同步等待 |
| `open_workspace` 扫描大目录 | 152 个子目录扫几分钟 | 按具体子目录 open，不要 open 根目录 |
| DNS 传播延迟 | 新域名初期不可达 | 创建 Route 后等 5 分钟。如仍未生效可加 hosts 临时绕过 |
| Windows .exe 扩展名 | runner registry 搜 `pytest` 找不到文件 | 配置 `runners` 字段显式指定 `.exe` 完整路径 |
| 网络波动 | 偶尔 502 / "Failed to fetch template" | 重试即可。Workspace App 模板错误不影响工具调用 |

---

## 附录：常见问题

**Q: PC 需要一直开机吗？**
A: 需要。可以设 Windows 电源选项「永不睡眠」。

**Q: 能用多个 Connector 吗？**
A: 可以。每台 PC 一个独立 Tunnel + 子域名，互不影响。

**Q: 安全性如何？**
A: 所有流量 TLS 加密。PC 不开放任何入站端口。GPT 只能访问 `allowedRoots` 里的目录。OAuth 密码不经过 ChatGPT 服务器。

**Q: 需要付费吗？**
A: Cloudflare Tunnel 免费。域名几十块/年。ChatGPT Plus/Pro 订阅费用照常，但 MCP 工具调用不额外消耗 token。

**Q: 如果 Cloudflare Tunnel 断了怎么办？**
A: `cloudflared` 服务会自动重连。短暂断连（< 1 分钟）ChatGPT 侧会看到 502，重试即可。长时间断连需要在 PC 上检查网络和服务状态。

**Q: 有啥缺点吗？**
A: 速度比本地开发慢，但是web gpt精度相当不错。

---

## 参考链接

- [Cloudflare Tunnel 官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [MCP 协议规范](https://modelcontextprotocol.io/)
- [Cloudflare Tunnel 下载](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
