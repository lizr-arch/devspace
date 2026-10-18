# DEVSPACE-CODEX-RELIABILITY-001 最终报告

**裁决：`DEVSPACE_CODEX_RELIABILITY_FIXED = PASS`**
验证日期：2026-10-18。真实 API 重启前确认无在途请求、无 RUNNING Coach Agent、无 Worker lease；部署后 API 健康，使用已部署 `dist` 完成 3 次真实 CLI 调用和 1 次 Native Runner 调用。

## 1. 根因树

| 故障 | 直接原因与证据 | 确定性 |
|---|---|---|
| `RETRYING`、模型超时、缺 `turn.completed` | 终端有 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://127.0.0.1:7897`，macOS 系统 HTTP/HTTPS/SOCKS 代理也启用；实际 API launchd 进程这三项均未设置，且 PATH 只有系统目录。直连 `api.openai.com` IPv4 被拒、IPv6 3 秒超时；经本地代理的 HTTPS 请求完成 TLS 校验并到达服务端（未认证探测返回预期 401）。修复前绕过 Agent 的无代理调用出现 4 条错误事件后才完成；通过系统代理的真实 CLI 连续调用稳定完成。由此确认是运行环境代理差异造成的连接不稳定；历史单次请求的具体远端故障无法追溯。 | 高；历史单次远端根因未能逐条还原 |
| API 诊断与源码不同步 | 实际 API PID `55178` 自 10 月 17 日启动后一直运行 `dist/cli.js serve`；源码已有 `errorEventCount`、`lastErrorCategory`，当时 dist 不含这些字段。Worker LaunchAgent 文件存在，但 `launchctl` 查无该 service；API 未设置 Worker socket/state 环境，实际走内置 Native Runner。 | 确认 |
| 无关脏文件造成证据失败 | 原实现从当前 Git 状态直接收集 diff；运行前已有的敏感/大文件会污染本次证据。Runner 及事件存储分别存在 64 KiB 上限，导致大证据包报 `CODEX_EVIDENCE_TOO_LARGE`。 | 确认 |
| 特殊文件路径导致证据不完整 | 无限制 Git pathspec 可解释 `:(glob)` 等路径；仅比较运行后的 dirty 路径会漏掉运行期间恢复至 HEAD 的文件。普通对象还会把 `__proto__` 当继承属性。 | 确认；均已补复现用例 |
| 完成、证据和审核状态混淆 | 原状态不足以分别表达模型执行完成、证据失败和审核阻断；无效内部审核结果未可靠标为 `REVIEW_BLOCKED`。 | 确认 |

**配置 A/B 结论：** 相同 `gpt-6-luna`、`none`、只读 `OK` 请求，在默认用户配置及 `--ignore-user-config` 下都返回完整事件并成功；用时 11.261 秒和 9.210 秒。用户配置不是本次复现的连接根因。

## 2. 实际执行链路

```text
Web GPT / OAuth MCP 客户端
  → DevSpace API（launchd: com.liz.devspace，stateless MCP，127.0.0.1:7676）
  → 内置 Native Codex Agent Runner
  → Codex CLI 子进程（无独立 Worker）
  → Codex ChatGPT 登录 / CLI 选择的模型服务
```

| 层 | 现场证据 |
|---|---|
| API | 实际 LaunchAgent：`/Users/liz/Library/LaunchAgents/com.liz.devspace.plist`；工作目录 `/Users/liz/agy/devspace`；Node `/Users/liz/.hermes/node/bin/node`，v22.22.3；部署前 PID 55178，部署后 PID 24150。健康版本 1.1.0，部署后 bootId `d513c21f-7cd0-432d-b3a7-a68b074c0e66`，83 个工具。 |
| Worker | 仓库 plist `launchagents/com.liz.devspace.codex-worker.plist` 存在，但 `launchctl print gui/501/com.liz.devspace.codex-worker` 返回 service 不存在；无 Worker PID、无 lease、无 socket 环境变量。未启动或重启它。 |
| Runner / Guardian | API 使用内置 Native Runner；部署前后没有活跃 Codex Agent/Coach Sidecar/Godot 进程。Runner 完成证据走现有 `coach-review-events.sqlite`。 |
| Codex CLI | `/Users/liz/.local/bin/codex`，`codex-cli 0.162.1`；登录状态为 ChatGPT；Node v22.22.3。`~/.codex/config.toml` 选择 `gpt-6-luna`，未发现自定义 provider 或 `base_url`。 |
| 独立 Codex App Server | 机器另有 0.163.0 App Server daemon；它不是 DevSpace API/Worker，本次没有终止或修改。 |

## 3. 网络检查

- 终端代理变量指向 `127.0.0.1:7897`；API PID 环境中 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 均未设置，Worker 不存在。
- `scutil --proxy`：HTTP、HTTPS、SOCKS 均启用，端口 7897，PAC 关闭。Clash Verge / `verge-mihomo` 进程存在；不能把旧 plist 中的代理变量视为实际运行配置。
- 当前系统 DNS 结果：`api.openai.com` A `103.42.176.244`、AAAA `2a03:2880:f10d:83:face:b00c:0:25de`；`chatgpt.com` A `69.171.224.36`、AAAA `2606:4700:4408::ac40:9bd1` 与 `2a06:98c1:3101::6812:202f`。这是本机解析结果，不断言为服务权威地址。
- 默认 IPv4 路由为 Wi-Fi `en0` / `192.168.3.1`；存在 `utun0–utun3` 接口，但 `scutil --nc list` 没有活动 VPN service，未发现需要修改的 TUN 默认路由。
- 直连探测：`api.openai.com:443` IPv4 连接被拒；IPv6 3 秒超时。通过系统代理对 `https://api.openai.com/v1/models` 与 `https://chatgpt.com/backend-api/codex/models` 发起无认证请求，均完成 TLS 校验（`ssl_verify_result=0`），收到 HTTP 401，符合无凭据探测预期。
- 实际 Codex 真实模型请求已通过配置路径完成，故模型调用连通性另有端到端证据；CLI 自身不公开单次请求最终远端 IP，未伪称捕获到该地址。
- `--ignore-user-config` A/B 均成功，证明该选项未改变此次可用性结论。Worker/API 环境不再依赖终端导出变量；Runner 在 macOS 上从 `scutil --proxy` 读取启用的系统代理，分别补齐缺失的 HTTP/HTTPS 协议。PAC 不作猜测；显式协议变量保留原值；不写入令牌、不关闭 TLS 校验、不硬编码代理地址。

## 4. 源码修复

- [src/codex-proxy-environment.ts](../src/codex-proxy-environment.ts)：新增安全解析 macOS 系统代理，支持 HTTP/HTTPS 分离配置，只补进程环境缺少的协议。
- [src/codex-agent-runner.ts](../src/codex-agent-runner.ts)：Native Runner 子进程使用解析后的环境；记录白名单错误分类与 `failureStage`；独立表达 `executionCompleted`、`evidenceState`、`reviewState`。成功以 exit 0、正确 thread、`turn.completed` 和有效事件流为条件，可恢复 `error` 事件不单独判失败。
- 同一 Runner：证据只覆盖运行前后实际变化的路径；敏感拦截检查本次差异；Git pathspec 按字面解释；包括删除和恢复至 HEAD 的最终文件 SHA/状态。哈希清单取代静默截断；大文件不把全文塞进包。
- [src/coach-review-events.ts](../src/coach-review-events.ts)：证据包上限由 64 KiB 调至 1 MiB，并由 Runner 控制包大小与完整性。
- [src/server/tools-codex-agent.ts](../src/server/tools-codex-agent.ts)：Observer/status 只透出安全的分类、执行/证据/审核状态。
- 针对性测试覆盖代理分协议、可恢复 error、错误分类、已有脏敏感文件、tracked 文件还原、`:(glob)**`、`__proto__`、超大文件哈希清单及无效审核 verdict。

## 5. 修复提交与影响范围

- 代码提交：`b94a653580ace9cfd7fb5a0bdc31efdcafbadc95`，分支 `codex/devspace-codex-reliability-001`，已 fast-forward 合入 main。
- 只修改 Runner、Observer 投影、review event store 和对应测试/Smoke 工具；没有修改 TriaRegna、Codex CLI 配置、认证信息、其他 task 文件或用户 main 脏改动。
- 真实调用 smoke 源码及输出位于 [reports/evidence/DEVSPACE-CODEX-RELIABILITY-001](../reports/evidence/DEVSPACE-CODEX-RELIABILITY-001/)；原始编译日志保留在隔离 worktree 的 [build-release.log](/Users/liz/.devspace/worktrees/devspace-codex-reliability-001/reports/evidence/DEVSPACE-CODEX-RELIABILITY-001/build-release.log)。日志中 Vite 插件带有尾随空格，因此没有把原始日志纳入 Git。

## 6. 精准验收矩阵

| 编号 | 结果 | 证据 |
|---|---|---|
| T01 CLI 与 Worker 版本 | PASS | CLI 0.162.1；API 新 PID 24150 于 dist 替换后启动；Worker 未加载，未把 plist 文件当运行证据。 |
| T02 DNS / TCP / TLS / 实际模型路径 | PASS | DNS 与代理/直连差异见第 3 节；代理 TLS 校验为 0；真实模型调用 3/3 完成。 |
| T03 用户配置 A/B | PASS | `config-ab-final.jsonl`：默认配置与 `--ignore-user-config` 均完整完成。 |
| T04 最小 CLI 任务 | PASS | 部署后 smoke 的 3 个 operationId 均 exact `OK`、exit 0、有 `thread.started` / `turn.started` / `turn.completed`，用时 10.696 / 8.444 / 7.977 秒。 |
| T05 DevSpace Native Agent | PASS | 从已部署 `/Users/liz/agy/devspace/dist` 导入 Runner，`devspace-codex-reliability-001-1792329633642-native-01` 用时 12.017 秒，exit 0，完成事件完整，证据 `VERIFIED`，状态 `READY_FOR_GPT_REVIEW`，review event count=1。该 smoke 直连 Native Runner 类；没有绕过 OAuth 去冒充 MCP 客户端入口调用。 |
| T06 模型错误分类 | PASS | 精准 Runner 测试覆盖认证、模型不可用、429、5xx、网络中断、timeout 与未分类文本；不返回原始消息。 |
| T07 临时错误后恢复 | PASS | `codex-agent-runner.test.ts` 的 retry-success 验证 error 事件后仍由 `turn.completed` 决定完成。 |
| T08 证据包过大 | PASS | 140 KiB 文件生成路径、大小、SHA-256 清单；不静默截断。SQLite 包上限 1 MiB。 |
| T09 敏感路径与旧脏文件 | PASS | 运行前未变的 dirty 敏感文件不污染证据；本次新增/还原敏感文件仍失败并设 `evidenceState=FAILED`。 |
| T10 Worker/API 生命周期 | PASS | restart 前 API in-flight=0、active sessions=0、Coach RUNNING=0、Worker lease=0；部署后健康。数据库里仍有 59 条历史 `operations.status='running'` 记录（最新 10/17），但没有对应活进程/lease；未清理或改写。 |
| T11 READY_FOR_GPT_REVIEW | PASS | 真实 Native Runner 成功后产生一条可查询 review event；没有伪造审核 APPROVED。 |
| T12 Git 与其他任务安全 | PASS | 只 fast-forward 本任务提交；原有 `AGENTS.md`、`package.json`、`src/server/express-routes.ts` 修改和未跟踪 Gemini 文件均保留；无游戏/其他任务进程被终止。 |

**构建与测试：** `npm run typecheck` PASS；最终 `npm run build` PASS（两次 Vite build 完成，只有大 chunk 警告）；以下精准测试全部 PASS：`codex-proxy-environment.test.ts`、`codex-agent-runner.test.ts`、`codex-agent-mcp.test.ts`、`codex-worker-lifecycle.test.ts`、`coach-review-events.test.ts`；`git diff --check` 无输出。文档规则命令 `npm --prefix tools/docs test` 因仓库没有 `tools/` 目录及其 `package.json` 返回 ENOENT；报告只记录现场，没有运行全量 DevSpace 测试。

## 7. 真实 Codex 成功记录

部署后最终一轮使用已部署 dist：

| operationId | 类型 | 模型/推理 | 用时 | 结果 |
|---|---|---|---:|---|
| `devspace-codex-reliability-001-1792329633642-direct-01` | CLI | `gpt-6-luna` / `none` | 10.696 秒 | exit 0，精确 `OK`，完整事件 |
| `devspace-codex-reliability-001-1792329633642-direct-02` | CLI | `gpt-6-luna` / `none` | 8.444 秒 | exit 0，精确 `OK`，完整事件 |
| `devspace-codex-reliability-001-1792329633642-direct-03` | CLI | `gpt-6-luna` / `none` | 7.977 秒 | exit 0，精确 `OK`，完整事件 |
| `devspace-codex-reliability-001-1792329633642-native-01` | Native Runner | `gpt-6-luna` / `none` | 12.017 秒 | exit 0，`turn.completed`，证据 SHA 已持久化并通过校验 |

所有提示均要求只回复 `OK`，禁止使用工具/命令，CLI sandbox 为 read-only；没有外部写入动作。原始结构化结果：[real-smoke-deployed.jsonl](../reports/evidence/DEVSPACE-CODEX-RELIABILITY-001/real-smoke-deployed.jsonl)。

## 8. 部署结果

- 部署内容来自已测试提交的 dist；Runner bundle SHA-256：`24da7841950aa82a5b23481b38bb9a3cf783200e9e0405332f956335b2142cf8`。代理模块存在且分类字段已编译。
- 原 dist 保留在 `/Users/liz/agy/devspace/dist.pre-codex-rel001-20261018`；新 dist 已部署至 `/Users/liz/agy/devspace/dist`。
- 空闲闸门通过后，对唯一空闲 DevSpace API 执行 `launchctl kickstart -k gui/501/com.liz.devspace`；旧 PID 55178 → 新 PID 24150。健康接口返回 version 1.1.0、新 bootId、83 工具、0 in-flight。随后从目标 dist 运行的 CLI/Native smoke 全部通过。
- 没有运行或重启未加载的 Worker；没有强制停止 Codex App Server 或其他进程。

## 9. 剩余风险

- 旧失败请求的逐次远端目标与原始网络包未留存，无法断言历史上每个 55–120 秒超时都由同一瞬时路由造成。已证实 launchd 缺代理、系统代理可达、直连失败，并用最终运行版本稳定完成真实模型请求。
- API 的配置 A/B 在受控 CLI 环境执行；没有通过 OAuth MCP connector 发起一个单独的外部 HTTP Agent operation。Native Runner 的生产构建类与证据链已实测。
- 本机 `operations` 表保留 59 条旧 RUNNING 状态记录；没有活动进程或 lease，因此不影响此次部署，但记录需要后续独立审计。本任务未清理这些历史行。
- `codex-worker` LaunchAgent 当前未注册；若部署目标切换为独立 Worker，需另行安装/启动并核验其独立生命周期。本次可靠性修复由实际运行的内置 Runner 生效。

## 10. Git 状态

- main 已从 `72106131ac5b0a628be285f57dde00fa3d8dd75d` fast-forward 至代码提交 `b94a653580ace9cfd7fb5a0bdc31efdcafbadc95`；本报告作为后续独立提交合入；未 push，未重写历史。
- 本任务工作分支为 `codex/devspace-codex-reliability-001`；隔离 worktree 保留以便审阅，没有清理其他 worktree。
- main 原有未提交修改及 Gemini 未跟踪文件仍保留；没有纳入本次提交。main 原先领先 origin 5 个提交；代码提交后领先 6 个，报告合入后领先 7 个。
- 备份 dist、临时构建日志和其他历史 smoke 输出均保留；未清空数据库、旧证据或工作树。
