# Gemini Spark × DevSpace 接入与使用教学

> 面向对象：已经用 ChatGPT Web（GPT-5 系）通过 DevSpace 管理
> `F:\Code\messiah-profiling-suite` 等仓库的人。
> 目标：讲清楚 **为什么能接、门槛是什么、怎么接、接完之后怎么用**，
> 以及 **Gemini 网页版和 ChatGPT Web 接同一个 DevSpace 有什么本质区别**。
> 本文是教程；完整排障实录（4 层故障根因）见 `docs/gemini-spark-integration.md`。

---

## 1. 先说结论（TL;DR）

- Gemini 网页版（gemini.google.com）**能**接你已有的 DevSpace，协议与 ChatGPT 相同
  （Streamable HTTP + OAuth），但不是"加个 URL 就能用"——Google 给自定义 MCP
  连接器套了 **账号/地区/订阅/界面** 四道门槛。
- DevSpace 侧需要 **4 个前提**（trustProxy、stateful 传输、三域回调白名单、
  tools/list 兼容层），前三个是配置，最后一个是本地补丁。补丁只影响 Gemini，
  ChatGPT 拿到的工具目录**字节级不变**。
- 接上后只能在 **Gemini Spark 任务**里用（普通 Gemini 对话调不到 custom app），
  用法是 `@选中 app` + 自然语言。
- Gemini 的 Spark 用的是 **Google AI 订阅的网页额度**，和 ChatGPT 的 agent/
  connector 额度是两套完全不同的计费逻辑（§5）。

---

## 2. 为什么要在 Gemini 上接 DevSpace

你已经能用 ChatGPT Web 操作本地仓库，为什么还要折腾 Gemini？

1. **多一个强模型入口**：Gemini（Spark 背后的模型）对代码/长上下文的处理与
   GPT 系有差异，某些任务（结构分析、改写、总结大仓库）可以交叉验证——同一个
   DevSpace 工具面，两个模型各自跑一遍，结论互相校验。
2. **Spark 是后台 agent**：Spark 任务可以断点续跑、后台执行，不要求你一直开着
   页面（上限 15 个并发任务）。ChatGPT 的会话更偏"一问一答"。
3. **额度互补**：OpenAI 的 agent 配额和 Google AI Pro 的网页额度互相独立，
   一边吃紧时另一边还能干活（详见 §5）。
4. **成本已付**：如果你已经订阅 Google AI Pro，Spark 不额外收钱；DevSpace 也
   已经跑在本机——接入的边际成本是零。

> 反过来说：如果 Gemini 只是偶尔用，**不要**为此专门开 Ultra 或换区。
> 接入本身免费，但资格门槛（§3）不满足时一切白搭。

---

## 3. 门槛清单：Google 给了自定义 MCP 四道门

官方文档（Custom apps for Spark）原文条件是：

| 门槛 | 含义 | 你的现状 |
|---|---|---|
| 个人 Google 账号 | Workspace/学校账号不行 | 个人账号 ✓ |
| **美国 IP + 账号地区美国** | VPN 只解决 IP；账号 billing region 也要对 | 迁移过地区 |
| **Google AI Pro / Ultra** | 免费档无此入口；Spark 自 2026-07 向美国 AI Pro 开放 | AI Pro ✓ |
| **18+ 且 Keep Activity 开启** | 关着整个"Custom apps"区块不可见 | 需开启 |
| 仅英文界面 | 界面语言要切英文 | 切英文 |

**验证入口**：`gemini.google.com` → Settings & help → Connected Apps →
（若找不到先点 Personal Intelligence）→ **Custom apps for Spark** →
Add a custom app。

看不到 "Custom apps for Spark" 区块 = 门槛没过（多半是地区/账号/Keep Activity），
不是 DevSpace 的问题。

---

## 4. 接入步骤（在你已有 DevSpace 的前提下）

DevSpace 已经跑在 `http://127.0.0.1:7676`、有 Cloudflare 公网域名
`https://mcp-windows.workspaceport.com`、且 ChatGPT 已能用——**这些都复用**，
Gemini 不需要第二套隧道或第二个 DevSpace 实例。

### 4.1 DevSpace 侧 4 个前提（一次性）

1. **trustProxy**：`~/.devspace/config.json` 需含 `"trustProxy": true`
   （Cloudflare 转发带 X-Forwarded-For，否则 express-rate-limit 抛错杀掉进程）。
2. **stateful 传输**：`"mcpTransportMode": "stateful"`。ChatGPT 容忍 stateless，
   Gemini **不容忍**——它必须拿到 `Mcp-Session-Id` 和 SSE 通道才认为连接健康。
3. **OAuth 回调三域白名单**：Google 的 DCR 一次注册 **三个**回调域，漏一个整单
   400。看门狗脚本 `~/.devspace/watchdog.ps1` 里的环境变量必须是：
   ```
   DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS = chatgpt.com,gemini.google.com,
     oauth-redirect.googleusercontent.com,oauth-redirect-sandbox.googleusercontent.com,
     oauth-redirect-test.googleusercontent.com
   ```
4. **tools/list 兼容层（本地补丁）**：Gemini 收到全量 59 工具/129KB 目录会判
   "零个可用工具"然后断开。补丁按连接器签名 `clientInfo {name:"mcp",version:"0.1.0"}`
   识别 Gemini，只对它返回 18 个核心工具的干净目录。**其他客户端不受影响**
   （实测 ChatGPT 模拟签名仍收到 59 工具、字节级一致）。

> 以上都改完后，用 `node dist/cli.js doctor --public --full-loop` 做权威体检，
> 全绿再进下一步。它会完整走 DCR→OAuth→initialize→工具调用。

### 4.2 Gemini 侧（每 30 天左右一次）

1. 挂美国 VPN，浏览器打开 gemini.google.com，界面切英文。
2. Settings & help → Connected Apps → Custom apps for Spark → **Add a custom app**。
3. MCP URL 填：`https://mcp-windows.workspaceport.com/mcp` → Next。
4. 正常情况下走自动注册（DCR）→ 浏览器弹出 DevSpace 的 Owner Password 授权页：
   输入 `~/.devspace/auth.json` 里的 `ownerToken`（就是 ChatGPT 那次用的同一个）。
5. 完成后列表里出现该 custom app。

**不要做的事**：看到 "Automatic registration failed" 时先别手填 Client ID/Secret——
那会走进 Gemini 的降级路径（授权回跳对不上）。先检查 DevSpace 侧白名单是否含
全部三个 googleusercontent 域，再重试。手填凭据约 30 天过期；自动注册的凭据
持久化在 SQLite，重启不丢。

### 4.3 使用（普通对话不行，必须在 Spark 任务里）

1. 新建/进入一个 **Spark 任务**。
2. 输入 `@`，从列表选中你的 DevSpace custom app。
3. 用自然语言下指令。例如：

   > @devspace Call devspace_info and tell me the bootId and how many tools
   > you can see. Then read AGENTS.md from the workspace root and summarize
   > the build commands in 5 bullets.

4. 它会翻译成工具调用。写操作（edit/write/git）Gemini 会先要求你确认。

---

## 5. Gemini Web 的"额度"和 agent/API 是两套体系

这是最容易搞混的地方。**gemini.google.com（含 Spark）不吃 API 额度**，它消耗的
是 Google AI 订阅里的 **Gemini Apps 网页用量**（compute-based，约每 5 小时刷新、
有每周上限，随模型/任务复杂度浮动）。也就是说：

| | Gemini 网页版（Spark custom app） | Gemini CLI / Antigravity / API |
|---|---|---|
| 走哪套额度 | Google AI Pro/Ultra 的 **Apps 网页额度** | API credits / 开发者额度（另一套） |
| 入口 | gemini.google.com 网页 | 命令行 / IDE / Cloud |
| 自定义 MCP | Spark 任务内可用（本次主题） | 走各自配置，无网页那套门槛 |
| 门槛 | 美国区 + 订阅 + Keep Activity + 英文 | 无 Spark 那套地域门槛 |

**实际含义**：Spark 长任务、大文件读写会啃网页额度；如果本地 DevSpace 配合
Spark 做重活（如全仓库扫描、批量改写），注意 Google One AI Pro 的每周上限。
当网页额度吃紧时，同一台机器上的 Gemini CLI / ChatGPT 不受影响——额度互相独立，
这正是多入口的价值。

---

## 6. Gemini Web 的 DevSpace vs ChatGPT Web 的 DevSpace

同一个服务器、同一份工具注册，但**两个客户端体验差异很大**。对照表：

| 维度 | ChatGPT Web (GPT-5 系) | Gemini Web (Spark) |
|---|---|---|
| 触发方式 | 普通对话（connector 常驻） | **仅 Spark 任务**，`@` 选中 app |
| 工具目录 | 全量 **59 个**（含 job/game/UI 专用） | 兼容层过滤后 **18 个核心**（workspace/读写/git/task） |
| 传输模式 | 容忍 stateless（SDK 兼容好） | 必须 **stateful**（要 Mcp-Session-Id + SSE） |
| OAuth 回调 | chatgpt.com | **三个** oauth-redirect*.googleusercontent.com |
| 目录拒收风险 | 无（59 个全收） | 有（>50 工具即触发 Google 侧警告/断开） |
| 超时窗口 | 相对宽裕 | Spark 更宽但大仓库 open_workspace 仍可能贴线 |
| 诊断手段 | 少（无 wire 日志概念） | DevSpace 的 mcp_wire/dcr_wire 日志可逐请求复盘 |

**一句话**：ChatGPT 是"随便连都能用"；Gemini 是"必须按它的规矩来"——规矩全部
由 DevSpace 侧兼容层满足后，两边共用一个实例互不干扰。

**18 个工具白名单**（Gemini 能看到并能调用的全部）：
`devspace_info, list_workspaces, open_workspace, resume_workspace, read, write,
edit, grep, glob, ls, git_status, git_diff, project_task, list_task_sessions,
wait_task, poll_task, stop_task, approve_task_manifest`

缺的工具（如 `start_job`/`start_capture`/游戏与 UI 专用工具）在 Gemini 侧**刻意
不下发**——不是不能用，是怕它拿到后误判目录不可用。需要补哪个工具，改
`src/server/express-routes.ts` 的 `GEMINI_TOOL_ALLOWLIST` 即可，改完重启。

---

## 7. 常见问题速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 看不到 Custom apps for Spark | 地区/订阅/Keep Activity/账号类型门槛 | 对照 §3 清单逐项查 |
| "Automatic registration failed" | DevSpace 白名单缺三域之一 | 核对 §4.1-3 环境变量，重启 |
| "Account linking is required" | DCR 被 400 → 降级手填路径 | 别手填；修白名单后重试 |
| "trouble connecting"（会话建了又删） | tools/list 目录过大/特征不合规 | 确认补丁生效（§4.1-4） |
| 工具调用成功但慢/超时 | messiah 仓库太大，open_workspace 贴超时线 | 用 resume_workspace 复用已开工作区 |
| 突然复发"trouble connecting" | Gemini 改了连接器签名，兼容层没匹配上 | 看 run.log 的 mcp_wire 里 clientName，更新 §4.1-4 匹配规则 |

**诊断铁律**：服务端 `run.log` 里有 `mcp_wire` / `dcr_wire` / `gemini_*` 事件，
记录了每个 JSON-RPC 请求的方法、响应体（截断）和 Gemini 会话标记。任何接入问题
先看它，比看 Gemini 的报错文案可靠得多。

---

## 8. 附录：本次接入的固定资产位置

- DevSpace 代码：`D:\Code\GIT\devspace`（main 分支，已提交推送）
- 配置文件：`~/.devspace/config.json`（trustProxy/stateful）、
  `~/.devspace/watchdog.ps1`（白名单注入 + 自启看门狗）
- 排障实录：`docs/gemini-spark-integration.md`
- 兼容层代码：`src/server/express-routes.ts` 内 `GEMINI_CLIENT_MATCH` /
  `GEMINI_TOOL_ALLOWLIST` / `transformToolsListChunk`
- 本机验证探针：`Temp/probe_compat.mjs`（伪装任意客户端签名跑全链路）
