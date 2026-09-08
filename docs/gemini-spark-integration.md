# Gemini Spark 接入 DevSpace 实战经验（2026-09-08）

> 本文档记录把 DevSpace MCP 服务器接入 **Gemini 网页版（gemini.google.com / Gemini Spark）**
> 的完整排障过程。三天时间，从"连不上服务器"到工具调用成功，共挖出并修复 **4 层独立问题**。
> 全部结论来自服务端 wire 日志实证，非推测。

## 0. 背景与门槛

Gemini 网页版支持自定义 MCP 连接器（Custom apps for Spark），协议层面与 ChatGPT 相同
（Streamable HTTP + OAuth 2.1 + DCR），但有额外硬门槛：

| 门槛 | 说明 |
|---|---|
| 美国 IP **且账号地区**美国 | VPN 够不够取决于账号 billing region |
| AI Pro / Ultra 订阅 | 免费档没有此功能；7 月起 AI Pro（美国）开放 Spark |
| 18+，Keep Activity 开启 | Keep Activity 关着整个功能不可见 |
| 仅英文界面 | |
| **只能在 Spark 任务里用** | 普通 Gemini 对话调不了 custom app |

入口：Settings & help → Connected Apps → Custom apps for Spark → Add a custom app。

## 1. 故障分层与修复（按排障时间序）

每一层修好之前，下一层完全不可见——这也是为什么错误信息换来换去。

### 第 1 层：进程管理（服务"安静消失"）

**症状**：DevSpace 随时静默死亡，无任何错误日志。
**根因**：用 agent 会话的 background 终端跑 `serve`——父进程回收时连带杀掉 node。
**修复**：看门狗计划任务（`DevSpaceWatchdog`，每 2 分钟探活 `/healthz`，挂了自动拉起，
开机自启）。脚本 `~/.devspace/watchdog.ps1`，日志 `~/.devspace/watchdog.log`。
**教训**：长驻服务永远不要挂在 agent 会话的进程树下。

### 第 2 层：OAuth 回调白名单（"Account linking is required"）

**症状**：`Account linking is required to use this custom app. Try again.`
**根因（wire 日志实锤）**：Google DCR 一次提交 **三个**回调域名：

```
https://oauth-redirect.googleusercontent.com/r/<uid>-<server>          ← 生产
https://oauth-redirect-sandbox.googleusercontent.com/r/<uid>-<server>  ← sandbox
https://oauth-redirect-test.googleusercontent.com/r/<uid>-<server>     ← test
```

DevSpace 的 `registerClient` 校验是 `redirect_uris.every(redirectHostAllowed)`——
**漏一个整单 400**。只加生产域名时自动注册必死，Gemini 退回手填凭据降级路径，
而手填路径的 client 只带单回调域，授权回跳必失败 → "account linking" 收不了尾。

**修复**：环境变量（看门狗 ps1 内注入）：

```
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS = chatgpt.com,gemini.google.com,
  oauth-redirect.googleusercontent.com,oauth-redirect-sandbox.googleusercontent.com,
  oauth-redirect-test.googleusercontent.com
```

**教训**：排查 OAuth 失败必须抓注册请求原文。dcr_wire 日志（见 §3）里
`redirect_uris` 数组一次性看清 Google 到底注册了几个域。

### 第 3 层：传输模式（"We had trouble connecting"，ChatGPT 能用 Gemini 不能）

**症状**：OAuth 全绿、工具调用在服务端 200，但 Gemini 报"trouble connecting"。
**根因**：DevSpace 默认 `mcpTransportMode: "stateless"`——不发 `Mcp-Session-Id`、
`GET /mcp` 一律 405。**ChatGPT 容忍 stateless，Gemini 不容忍**：它要 stateful 会话
（session id + SSE 通道），拿不到就判连接不健康。

**修复**：`config.json` 加 `"mcpTransportMode": "stateful"` 并重启。
验证：`node dist/cli.js doctor --public --full-loop` 全绿（该命令内部完成
DCR→OAuth→initialize→tools/call 全链路，是权威体检入口）。

### 第 4 层：tools/list 目录被 Gemini 拒收（最深的坑）

**症状**：initialize 200、tools/list 200（服务端日志全绿），但 Gemini 收到工具目录后
**主动 DELETE 会话**，重试 3 次后报"trouble connecting"。
**根因（wire 日志 + Google 官方文档对照）**：全量目录 59 工具 / 129KB，每个工具带
`$schema` + `additionalProperties` + `outputSchema` + Apps-UI `_meta`。
Google 官方文档：

- *"Servers that provide no usable tools have their connections closed"* —— Gemini
  把整个目录判为"零个可用工具"就断开；
- Google 自家 issue #21823：**>50 工具警告、~70 崩**；
- 文档列出其管线要 sanitize 的 schema 特征：`$schema`、`additionalProperties`、
  anyOf+default（对 `outputSchema` 未提及，但实测也不能收）。

**修复（fork 补丁，`src/server/express-routes.ts`）**：Gemini 兼容层——

1. `initialize` 时识别连接器签名：Gemini 实测报 `clientInfo = {name:"mcp", version:"0.1.0"}`
   （`gemini_session_marked` 日志确认识别成功）；
2. 对标记会话的 `tools/list` 响应做流内改写：
   - 白名单过滤到 **18 个工具**（`GEMINI_TOOL_ALLOWLIST`：workspace/读写/git/task 核心）；
   - 递归剥 `inputSchema` 里的 `$schema`、`additionalProperties`；
   - 删除 `outputSchema`、`_meta`；
3. **`Content-Length` 处理是隐藏炸弹**：@hono/node-server（SDK 依赖它桥接 Web
   Response ↔ Node res）在 body 泵出前就把 Content-Length 定死为**未过滤**尺寸，
   少写字节客户端直接 terminated。必须在 `writeHead` 时删掉 Content-Length 让
   Node 退回 chunked；
4. **chunk 形状坑**：hono 泵的是 `Uint8Array`（来自 SDK 的 TextEncoder），不是
   string/Buffer——拦截器只认后两者会静默看到 0 字节（第一次部署就栽在这，
   mcp_wire 里 resLen=0 但客户端收到全量响应）。

**隔离性承诺（实测）**：兼容层只作用于 `name=mcp & version=0.1.0` 签名会话。
用探针（§3）双向验证：

- `mcp/0.1.0` → 18 工具 / 18KB / 无 $schema/outputSchema/_meta ✅
- 其他签名（模拟 ChatGPT）→ 59 工具 / 129KB / 原样 ✅ 字节级不变

## 2. 最终结果

- Gemini Spark 会话建立、工具目录下发、工具调用（`resume_workspace` success）
  全链路打通；
- 用户侧用法：Spark 任务里 `@` 选中 custom app → 自然语言下达 → Gemini 翻译成
  工具调用；
- 18 工具清单：devspace_info, list_workspaces, open_workspace, resume_workspace,
  read, write, edit, grep, glob, ls, git_status, git_diff, project_task,
  list_task_sessions, wait_task, poll_task, stop_task, approve_task_manifest。

## 3. 排障工具箱（本次沉淀的可复用资产）

| 工具 | 用途 |
|---|---|
| `dcr_wire` / `mcp_wire` 日志（fork 常驻） | 记录 DCR 请求/响应原文、JSON-RPC 方法、响应体（600 字节截断，不记 Authorization 头）。**下次任何 MCP 客户端接入问题先看这个** |
| `Temp/probe_compat.mjs` | 伪装任意 clientInfo 签名跑全链路（DCR→OAuth→tools/list），验证兼容层隔离性 |
| `Temp/dcr_three_uri.mjs` | 复现 Google 三体回调注册 |
| `Temp/dump_wire.py` 等分析脚本 | 解析 run.log 的 JSON 事件流 |
| `doctor --public --full-loop` | 权威全链路体检（open_workspace 扫大仓库 ~320s，超时属正常） |

## 4. 通用教训（适用任何 MCP 服务器 × 任何新客户端）

1. **错误信息只描述症状层，不指认根因层**。同一个"trouble connecting"先后对应了
   stateless / 目录拒收两个完全不同的根因；"Account linking is required" 的真凶是
   DCR 白名单。逐层推进，每层修好才见下一层。
2. **wire 日志是唯一可信证据**。JSON-RPC 层的请求方法+响应体+会话行为，比 HTTP 状态码
   和客户端错误文案多出几个量级的信息量。本次三个根因全部由 wire 日志实锤。
3. **不要用单路径探针下结论**。第一版 DCR 探针只发 1 个回调 URI 一路 201，从未复现
   Google 的三体注册——直到 wire 日志抓到真实请求体。探针要复刻客户端的真实行为，
   而不是"我认为它会怎么做"。
4. **SDK 的抽象层会藏实现细节**。hono/node-server 桥接层的 Content-Length 定长、
   Uint8Array chunk 形状，都只在读 SDK/桥源码后才可见。改响应流前先读桥。
5. **兼容性改动必须双向验证**：目标客户端拿到降级目录 ✅ + 现有客户端字节级不变 ✅，
   缺一半都是回归。

## 5. 已知限制与后续

- **连接器签名可能漂移**：兼容层匹配 `name:"mcp" version:"0.1.0"`，Gemini 若改签名
  会退回全量目录 → 可能复发"trouble connecting"。届时看 mcp_wire 的 clientName。
- **日志里出现过 `clientName='Gemini'` 的会话**（未进过滤通道，拿到全量目录），
  来源待观察——若是 Spark 主通道改用此签名，需把匹配规则加上。
- `resume_workspace` 耗时 321s 贴着超时线（messiah 仓库太大）；若将来 Spark 侧超时，
  可考虑给 Gemini 会话预置更小的 workspace 或索引预热。
- fork 补丁清单（merge/rebase 上游前必须核对保留）：
  1. `/register` 空串净化 shim（2026-09-07）
  2. `/register` + `/mcp` wire 日志（dcr_wire/mcp_wire/gemini_*）
  3. Gemini Spark tools/list 兼容层（2026-09-08）
  4. 配置侧：`trustProxy`、`mcpTransportMode: stateful`、三域回调白名单、看门狗
- 未提交；用户确认稳定后按补丁 1+2+3 分组提交。
