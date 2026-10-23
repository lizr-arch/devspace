# DevSpace 稳定性加固计划：WS-3 日志语义 / WS-4 隧道加固 / WS-5 主机可观测性

- 文档日期：2026-10-24
- 状态：**DRAFT — 待确认执行顺序、维护窗口与阈值后开工**
- 触发事故：2026-10-24 02:10–02:19（CST）ChatGPT Web 侧 DevSpace 连接器反复断线，watchdog 报 `tunnel_down`（公网 502 / 本地 200）与 `local_down`（http=000）
- 关联证据目录：`~/.local/state/devspace/`、`~/.devspace/logs/`
- 仓库基线：`devspace@df1539c`，生产 `dist/cli.js` sha256 `1265140c08386e8ccd0ee70d3936371705434e40646cad79a9f714e18fa74ccd`

---

## 1. 背景：为什么需要这三项

事故根因已在 2026-10-24 排查中确认（详见 §2），不是 DevSpace 主动断线：

1. 宿主机被 8 个 Godot headless 验收测试 + Roslyn 编译进程打满（10 核，load 22–31，系统 CPU 95–100%，swap 峰值 19.7 GB / 20.5 GB）；
2. DevSpace 是单进程单事件循环，被系统调度饿死，`eventLoop.p95` 峰值 **27 950.8 ms**，本地健康检查 8 s 超时返回 `000`；
3. cloudflared 从 `127.0.0.1:7676` 拿不到及时响应，记录 `EOF` / `connection reset by peer`，Cloudflare 对公网请求返回 **502**；
4. ChatGPT 连接器在约 **300 s** 超时后取消（cloudflared 记 `context canceled`）并自动重连（02:15:58–59 连续 4 次 `initialize` + 4 次 `notifications/initialized`）。

三项工作分别解决这次事故暴露的三类缺陷：

| 工作流 | 解决的问题 | 事故中的具体表现 |
| --- | --- | --- |
| **WS-3 日志语义** | 客户端中断被记成 HTTP **200**，把人引向错误方向 | `POST /mcp status=200 durationMs=295455` 实际是超时后被取消的请求 |
| **WS-4 隧道加固** | cloudflared 版本落后、无自愈、无指标、日志无轮转 | 版本 2026.7.3（官方建议 2026.10.3）；watchdog `AUTORESTART=0`；`cloudflared.err.log` 已 11 MB |
| **WS-5 主机可观测性** | 看不到 swap / load / eventLoop 长尾，不能在断线前预警 | 27.9 s 事件循环停顿发生在断线之后才被事后发现；watchdog 只探测 HTTP 200 |

**WS-3 补语义、WS-5 补预警、WS-4 降故障率**，三者合起来才能把"DevSpace 自己断开"变成一条可定位、可预警、可自愈的链路。

---

## 2. 事故证据基线（用于验收对照）

### 2.1 关键时间线（CST，2026-10-24）

| 时间 | 证据 |
| --- | --- |
| 01:29:17 | 外部 agent（Qoder）启动 `tools/run_all_tests.sh --full`，后续不断派生 Godot 子进程 |
| 02:10:05 | Web GPT 调用 `resume_workspace`（`/Users/liz/agy`），服务端耗时 **318 761 ms** |
| 02:14:58 | cloudflared 记 `context canceled`（≈300 s 客户端超时） |
| 02:15:00 | DevSpace 记 `POST /mcp status=200 durationMs=295455`（实际被取消，却记 200） |
| 02:15:19 | watchdog：`tunnel_down`，公网 502 / 本地 200 |
| 02:15:22、02:15:51 | cloudflared：origin `EOF`、`connection reset by peer` |
| 02:15:58–59 | ChatGPT 连续 4 次 `initialize` + 4 次 `notifications/initialized`（断线重连） |
| 02:17:12 | DevSpace monitor：`eventLoop.p95 = 27 950.8 ms` |
| 02:17:47 | watchdog：`local_down`（本地 http=000，8 s 超时） |
| 02:19:14 | 恢复 |

### 2.2 数量基线

- 长调用（2026-10-23 12:00Z 之后）：`project_task` 最长 397 760 ms、`resume_workspace` 318 761 ms、`list_workspaces` 169 825 ms。
- DevSpace 服务未重启：PID 14098 自 2026-10-22 01:06 未变（launchd `runs=25` 未新增）。
- cloudflared 每日错误（`~/.devspace/logs/cloudflared.err.log`，UTC 日）：

| UTC 日期 | 总错误行 | origin 不可达 | DNS 刷新超时 | edge 连接关闭 |
| --- | --- | --- | --- | --- |
| 10-17 | 63 | 10 | 1 | 12 |
| 10-18 | 666 | 6 | 1 | 20 |
| 10-19 | 632 | 12 | 1 | 74 |
| 10-20 | 84 | 10 | 0 | 10 |
| 10-21 | 173 | 6 | 2 | 32 |
| 10-22 | 302 | 0 | 0 | 54 |
| 10-23 | 60 | 18 | 5 | 8 |

> 说明：edge 连接关闭是常态背景噪声，不能全部归因于本次事故；WS-4 的验收要区分"origin 不可达（本地服务/主机）"与"edge 抖动（网络/Cloudflare）"两类。

### 2.3 现有资产与边界

| 资产 | 路径 | 备注 |
| --- | --- | --- |
| DevSpace 服务 | `~/Library/LaunchAgents/com.liz.devspace.plist` | `dist/cli.js serve`，端口 7676，KeepAlive |
| DevSpace 日志 | `~/.local/state/devspace/devspace.log` | **156 MB，无轮转** |
| 监控 API | `http://127.0.0.1:7676/monitor/api` | 仅本机；含 eventLoop / load / resourceHistory |
| 隧道服务 | `~/Library/LaunchAgents/com.liz.cloudflared-devspace.plist` → `~/.local/bin/start-devspace-cloudflared.sh` | `--protocol http2 --no-autoupdate` |
| cloudflared | `~/.local/bin/cloudflared`（2026.7.3，sha256 `f35c5008…ed6257`） | 直接下载的静态二进制，非 brew 管理 |
| 隧道日志 | `~/.devspace/logs/cloudflared.err.log` | **11 MB，无轮转** |
| watchdog | `~/.local/bin/devspace-tunnel-watchdog.sh` + `~/Library/LaunchAgents/com.liz.devspace-watchdog.plist` | 每 60 s；`AUTORESTART` 默认 0；脚本**不在仓库内** |
| watchdog 状态 | `~/.local/state/devspace/watchdog.{log,state,conf}` | `watchdog.conf` 当前不存在 |

---

## 3. 目标与非目标

### 3.1 目标

1. **WS-3**：客户端中断的请求在日志、监控事件、MCP 诊断中一律标记为 **499 / CLIENT_ABORT**，不再出现"200 其实是失败"的误导；监控负载分数能反映中断率。
2. **WS-4**：cloudflared 升级到受支持版本并固定；隧道故障具备**可观测指标 + 可控自愈 + 日志轮转**；重复 530/1033 的恢复时间从"人工发现"降到"自动重连 + 告警"。
3. **WS-5**：DevSpace 与 watchdog 能持续观测 `eventLoop.max`、load average、swap 使用率、可用内存；在主机饱和但 HTTP 仍为 200 的阶段就能告警；告警去重、可恢复、可事后取证。

### 3.2 非目标（明确不做）

- 不修改 MCP 工具 schema 与工具行为；不改变 ChatGPT 连接器配置或 OAuth 流程。
- 不自动杀外部 agent 的 Godot/编译进程（只在计划里给出运维建议，由人决定）。
- 不重构 DevSpace 为多进程 / worker_threads（超长工具调用取消属于后续 WS-6 候选）。
- 不更换隧道域名、不复用 token、不把 token 写入仓库。
- 不引入新的第三方监控服务（Prometheus/Grafana 等）；仅用本机 monitor API + watchdog + osascript 通知。

---

## 4. 建议执行顺序与里程碑

用户指定的编号是 3 → 4 → 5；从依赖关系看，**建议执行顺序为 3 → 5 → 4**：

- WS-5 的指标是 WS-4 验收与回滚判据（升级前后对比 origin 不可达次数、edge 抖动、重启次数）；
- WS-3 改动小、风险低，先落地可立刻消除"200 误导"，也为 WS-5 的 aborted 计数提供数据；
- WS-4 需要重启 cloudflared 并有 24 h 观察期，放在最后，避免观察期被 WS-3/WS-5 的 devspace 重启干扰。

| 里程碑 | 内容 | 预估 | 出口条件 |
| --- | --- | --- | --- |
| M0 基线冻结 | 记录当前二进制/构建 sha、7 日错误基线、monitor 采样 | 0.5 h | 基线表写入 `reports/stability-2026-10-24/` |
| M1 = WS-3 | 日志语义修复 + 测试 | 2–3 h | 单测 + 注入验证通过 |
| M2 = WS-5 | monitor 扩展 + watchdog 新检查 | 1 d | 阈值注入测试 + 正常负载 1 h 无假报 |
| M3 = WS-4 | cloudflared 升级 + 自愈 + 指标 + 轮转 | 2–4 h + 24 h 观察 | 版本/连接数/公网 200/自愈测试通过 |
| M4 复盘 | 汇总证据、更新本文档状态 | 1 h | 验收表全绿或明确记录残留风险 |

> 若用户坚持 3 → 4 → 5，只需把 M2/M3 对调；WS-4 的 24 h 观察期会与 WS-5 开发重叠，验收证据需按时间戳区分。

---

## 5. WS-3：客户端中断语义修复（499 / CLIENT_ABORT）

### 5.1 现状与缺陷

`src/server/express-routes.ts` 的请求日志中间件（约 L84–L139）用同一个 `completeRequest()` 处理 `finish` 与 `close`：

```ts
const completeRequest = () => {
  ...
  finishMonitoring(res.statusCode, performance.now() - startedAt); // 中断时 statusCode 仍是默认 200
  if (res.statusCode >= 400 && ...) { runtime.monitorEvents.record({...}) }
  logEvent(config.logging, "info", "http_request", { ..., status: res.statusCode, durationMs });
};
res.once("finish", ...);
res.once("close", () => {
  if (!res.writableFinished) withMcpRequest(..., () => recordMcpDiagnostic("client_abort", {
    statusCode: res.statusCode, errorClass: "CLIENT_ABORT" }));  // 同样是 200
  completeRequest();
});
```

后果：
- 日志 `status: 200` + `durationMs` 数分钟，误导排查（本次事故的"报错 200"来源之一）；
- `LiveRequestMonitor`（`src/live-monitor.ts` L71–L170）不把中断计入 error/recentErrors，`calculateLoadAssessment`（L348）的可靠性分量失真；
- `mcpDiagnostics` 的 `client_abort` 事件 `statusCode: 200`，与 `CLIENT_ABORT` 语义矛盾；
- `runtime.monitorEvents` 不记录中断，`/monitor/api` 的 `errors.recent` 看不到这类故障。

### 5.2 设计

1. **提取中间件到可测试模块** `src/server/request-logging.ts`：
   - 导出 `createRequestLoggingMiddleware(deps)`（依赖注入 `logEvent`、`requestMonitor`、`monitorEvents`、`config`、`recordMcpDiagnostic`）；
   - 导出纯函数 `resolveRequestOutcome(res): { statusCode: number; aborted: boolean }`：`aborted = !res.writableFinished`；`aborted ? 499 : res.statusCode`。
2. **统一 499 语义**（沿用 nginx "client closed request" 约定，避免自造非标状态码）：
   - `http_request` 日志：`status: 499`，新增 `aborted: true`（仅中断时出现，可选带 `abortAfterMs`）；
   - `finishMonitoring(499, durationMs)`：自然计入 `errors` / `recentErrors`（`LiveRequestMonitor` 已按 `>=400` 计数，无需改动逻辑）；
   - `recordMcpDiagnostic("client_abort", { statusCode: 499, errorClass: "CLIENT_ABORT" })`；
   - `runtime.monitorEvents.record({ source: "http", severity: "warning", code: "HTTP_499", message: "POST /mcp aborted by client", statusCode: 499 })`（沿用现有 `/monitor`、`/app-test` 排除规则）。
3. **保留兼容字段**：`status` 继续是数字；不新增会破坏现有解析器的字段；`aborted` 为新增可选字段。
4. **不改变正常完成路径**：`writableFinished === true` 时行为与现在完全一致。
5. **不改变服务端是否继续执行长任务**（当前中断后工具调用仍会跑完，属后续 WS-6 候选，不在本计划范围）。

### 5.3 文件级改动

| 文件 | 改动 |
| --- | --- |
| `src/server/request-logging.ts`（新增） | 中间件工厂 + `resolveRequestOutcome` |
| `src/server/express-routes.ts` | 删除内联中间件，改用工厂；保持注册顺序不变 |
| `src/mcp-diagnostics.ts` | 不改类型；确认 `statusCode` 接受 499 |
| `src/live-monitor.ts` | 不改计数逻辑；测试补充 499 断言（可选新增 `aborted` 计数，P1） |
| `src/server/request-logging.test.ts`（新增） | 纯函数 + 中间件单测（mock `ServerResponse`/`Request`） |
| `src/live-monitor.test.ts` | 断言 499 计入 errors/recentErrors，load 分数上升 |
| `src/mcp-diagnostics.test.ts` | `client_abort` 断言 `statusCode=499`（更新现有 `statusCode:200` 用例） |
| `docs/logging-contract.md`（新增，可选 P1） | 记录 `http_request` / `MCP diagnostic` 字段与 499 约定 |

### 5.4 测试与验收

| 编号 | 测试 | 通过标准 |
| --- | --- | --- |
| WS3-T1 | `tsx src/server/request-logging.test.ts` | abort 分支输出 `status=499, aborted=true`；正常分支 `status=201/200` 不变 |
| WS3-T2 | `tsx src/live-monitor.test.ts` | `errors`/`recentErrors` +1；`errorRatePercent` 上升；`mcp.total` 不重复计数 |
| WS3-T3 | `tsx src/mcp-diagnostics.test.ts` | `client_abort` 事件 `statusCode=499`、`errorClass=CLIENT_ABORT` |
| WS3-T4 | `npm run typecheck && npm run build` | 通过；`dist/cli.js` 可启动 |
| WS3-T5 | 生产注入（维护窗口） | 发起一个 `/mcp` 调用后 `kill -TERM curl` 中断，日志出现 `status:499, aborted:true`；`/monitor/api` 对应 error +1；下一次真实 ChatGPT 300 s 取消时自动出现 499（被动验证） |

验收定义：**日志、monitor、MCP 诊断三处对同一中断事件给出同一结论（499 / CLIENT_ABORT），且正常请求的 200 语义不变。**

### 5.5 回滚

`git revert` 对应提交 → `npm run build` → 维护窗口重启 `com.liz.devspace`（重启会中断当前 MCP 会话，见 §8 检查清单）。无数据迁移，回滚成本低。

---

## 6. WS-5：主机与隧道可观测性

### 6.1 现状与缺陷

- `/monitor/api` 已有 `eventLoop.p95Ms/maxMs`、`system.cpu*`、`system.memoryUsedPercent`（基于 `os.freemem()`）、`load` 评分，但：
  - **没有 swap**（本次事故最硬的证据：swap 峰值 19.7/20.5 GB）；
  - **没有 load average / CPU 核数**；
  - `os.freemem()` 在 macOS 上只统计 free 页，会把"inactive/speculative 可回收内存"算成已用（事故时显示 98.6% used，而 `memory_pressure` 显示 free 34%）——需要标注口径，避免误判；
  - `resourceHistory` 只存 `eventLoopP95Ms`，没有 `eventLoopMaxMs`（27.9 s 的长尾在历史里看不到）。
- watchdog 只看三层 HTTP（cloudflared 进程、本地 healthz、公网 healthz），**HTTP 200 与主机饱和可以同时成立**，本次事故前半段即如此。
- watchdog 脚本不在仓库内，无版本、无测试、无 dry-run。

### 6.2 设计

#### A. 扩展 `src/live-monitor.ts`

- `ProcessResourceSnapshot` 新增（全部可选，避免破坏现有消费者）：
  - `cpuCount: number`
  - `loadAverage: { one: number; five: number; fifteen: number }`（`os.loadavg()`）
  - `swapUsedMiB / swapTotalMiB / swapUsedPercent: number | null`（macOS：`sysctl -n vm.swapusage`；其他平台 `null`）
  - `memoryPressureFreePercent: number | null`（macOS：`vm_stat` 的 `free + inactive + speculative` 页占比，作为补充口径）
- `ResourceHistoryPoint` 新增 `eventLoopMaxMs`、`swapUsedPercent`（保留旧字段）。
- 采样策略：swap/`vm_stat` 属于外部命令，**每 5 个采样周期（5 s）执行一次并缓存**，避免每秒 fork；命令失败返回 `null`，不抛错、不影响主循环。
- `calculateLoadAssessment`：先不改权重；仅当 WS-5 基线建立后，评估是否把 `eventLoopMax` 与 swap 纳入（改动会改负载分数语义，需单列评审）。

#### B. 扩展 `/monitor/api`（`src/server/express-routes.ts` L152–L215）

`system` 块新增：`cpuCount`、`loadAverage`、`swap{Used,Total}MiB`、`swapUsedPercent`、`memoryPressureFreePercent`、`memoryAccounting: "macos_freemem_vs_vm_stat"` 之类的口径标记。

#### C. watchdog 扩展（脚本入库 + 新状态）

1. **入库与安装**：
   - 新增 `scripts/ops/devspace-tunnel-watchdog.sh`（当前脚本的受控版本）、`scripts/ops/watchdog.conf.example`、`scripts/ops/install-devspace-watchdog.sh`（备份旧脚本 → 安装/软链 → `launchctl kickstart`）；
   - `~/.local/bin/devspace-tunnel-watchdog.sh` 改为指向仓库脚本的软链（或安装脚本覆盖），保证 SSOT。
2. **新增主机健康检查**（仅当本地 healthz 200 时执行）：
   - 读取 `http://127.0.0.1:7676/monitor/api`（2 s 超时，`--noproxy '*'`），取 `eventLoop.maxMs`、`system.loadAverage.one`、`system.swapUsedPercent`、`system.memoryAvailableMiB`；
   - 建议阈值（可配置，DRAFT）：
     - `eventLoopMaxMs ≥ 5000` 连续 2 次 → `host_saturated`
     - `load1 ≥ cpuCount × 2`（10 核即 20）连续 3 次 → `host_saturated`
     - `swapUsedPercent ≥ 80` 连续 2 次 → `memory_pressure`
     - `memoryAvailableMiB < 1024` 连续 3 次 → `memory_pressure`
   - 新状态不触发 cloudflared 重启（重启隧道解决不了主机饱和），只通知 + 写状态文件。
3. **状态与通知**：
   - `watchdog.state` 扩展为多段（`tunnel|host|memory|notify_at|restart_at`），旧单行格式兼容读取；
   - 每次运行把主机采样落盘 `~/.local/state/devspace/watchdog-host.json`（保留最近 N 条）便于事后取证；
   - 通知去重：状态跃迁即通知，持续故障按 `REMIND_SECONDS` 重提醒，恢复通知一次。
4. **dry-run / fixture 支持**（为了可测试）：
   - `--once`：只跑一轮、输出判定 JSON；
   - `DEVSPACE_WATCHDOG_DRY_RUN=1`：不执行 `launchctl`、不弹通知，只写日志；
   - `DEVSPACE_WATCHDOG_FIXTURE_MONITOR_JSON=<path>`：用固定 monitor JSON 替换真实请求。

#### D. 日志轮转（P1，纳入 WS-5 运维产物）

- watchdog 每轮顺带检查：`devspace.log > 100 MB`、`cloudflared.err.log > 20 MB`、`monitor-events.jsonl > 20 MB` 时 copytruncate 到 `.1`（保留 2 份，gzip 可选）；
- 注意 `devspace.log` 是 launchd stdout 追加写，copytruncate 对追加写 fd 安全；实施前先在临时文件演练。

### 6.3 文件级改动

| 文件 | 改动 |
| --- | --- |
| `src/live-monitor.ts` | 快照/历史字段、5 s 缓存的 swap+vm_stat 采样、类型定义 |
| `src/server/express-routes.ts` | `/monitor/api` system 块扩展 |
| `src/live-monitor.test.ts` | 新字段断言（允许 `null`，平台分支）；`eventLoopMaxMs` 进入 history |
| `scripts/ops/devspace-tunnel-watchdog.sh`（新增） | 入库版 watchdog（保留现有三层检查 + 主机检查 + dry-run/fixture） |
| `scripts/ops/watchdog.conf.example`（新增） | 阈值/冷却/URL 配置模板 |
| `scripts/ops/install-devspace-watchdog.sh`（新增） | 备份、安装、`launchctl kickstart`、校验 |
| `scripts/ops/devspace-tunnel-watchdog.test.sh`（新增） | fixture 驱动的判定测试（正常/本地挂/隧道挂/主机饱和/恢复） |
| `package.json` | 新增 `"test:ops": "bash scripts/ops/devspace-tunnel-watchdog.test.sh"`，不并入 `test:unit` |

### 6.4 测试与验收

| 编号 | 测试 | 通过标准 |
| --- | --- | --- |
| WS5-T1 | `tsx src/live-monitor.test.ts` | 新字段存在；swap 在非 macOS 为 `null` 不崩；history 含 `eventLoopMaxMs` |
| WS5-T2 | `npm run typecheck && npm run build` | 通过 |
| WS5-T3 | `npm run test:ops` | 5 个 fixture 场景判定与通知/状态文件符合预期，dry-run 下不执行 launchctl/osascript |
| WS5-T4 | 真实阈值注入（临时把阈值调低）+ `yes > /dev/null` 拉满 CPU | 60–120 s 内出现一次 `host_saturated` 通知，状态文件记录；停止负载后出现恢复通知；不触发 cloudflared 重启 |
| WS5-T5 | 正常负载 1 h soak | 0 条主机类误报；watchdog 每轮耗时 < 5 s；日志/轮转正常 |
| WS5-T6 | swap 口径核对 | 监控值与 `sysctl vm.swapusage` 误差 < 5%，口径写在 API 字段注释中 |

### 6.5 回滚

1. 恢复 `~/.local/bin/devspace-tunnel-watchdog.sh` 备份（`install-devspace-watchdog.sh` 会保留 `.pre-<date>`）；
2. `launchctl kickstart -k gui/501/com.liz.devspace-watchdog`；
3. DevSpace 代码侧 `git revert` + 重建/重启（若已发布）。

---

## 7. WS-4：Cloudflare 隧道加固

### 7.1 现状与缺陷

- cloudflared **2026.7.3**，官方日志已连续 33 次提示升级到 **2026.10.3**；二进制约 7 月 26 日放入 `~/.local/bin`，非包管理器管理，无版本固定/校验记录。
- 启动参数固定 `--protocol http2 --no-autoupdate`，**未启用 metrics**，watchdog 无法读取连接数/请求错误。
- 隧道日志无轮转（11 MB），故障取证靠人工 grep。
- watchdog `AUTORESTART=0`、`watchdog.conf` 不存在：530/1033/502 只能报警，不能自愈。
- 已知背景噪声：edge 连接关闭每天 8–74 次；DNS 刷新 `i/o timeout` 每天 0–5 次（与系统 Clash 代理/DNS 同层，需单独验证是否影响可用性）。

### 7.2 设计

#### A. 升级并固定 cloudflared（P0）

- 目标版本：**2026.10.3**（`https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3`）。
- 资产：`cloudflared-darwin-arm64.tgz`（本机 arm64）。
- **校验冲突（必须先解决，否则不升级）**：
  - GitHub Release 正文 `SHA256 Checksums` 给出的 `cloudflared-darwin-arm64.tgz` 是 `f249139e0541fa589c987397d867cc16c83ab1236d31eb6782f2e4552ee9cf80`；
  - GitHub API 的 asset `digest` 字段给出 `sha256:1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55`；
  - 两者不一致，**按 fail-closed 处理**：下载后计算 sha256，API `digest` 与正文 checksum 都必须逐个比对。若文件与 API `digest` 一致、但与正文 checksum 不一致，先记录冲突、暂停升级并人工确认权威值，**不默认信任任何一个**；若两者都不匹配则直接停止并上报。
- 升级步骤（维护窗口，约 5 min 中断）：
  1. 记录旧二进制 sha256（`f35c5008…ed6257`）并备份到 `~/.local/share/devspace/bin-backup/cloudflared-2026.7.3`；
  2. 下载 tgz → `tar -xzf` → `./cloudflared --version` 自检 → sha256 双源校验；
  3. 原子替换 `~/.local/bin/cloudflared`（`install -m 0755` 到临时名再 `mv`）；
  4. `launchctl kickstart -k gui/501/com.liz.cloudflared-devspace`；
  5. 验证 4 条 `Registered tunnel connection`、公网 `/healthz` 200、watchdog 连续 OK ≥ 3 轮。
- 升级后保留 `--no-autoupdate`，由本计划固定版本；**不启用自动更新**（避免生产隧道在无人值守时换版本）。

#### B. 隧道指标与可观测性（P1）

- 启动脚本增加 `--metrics 127.0.0.1:20241`（先用 `cloudflared tunnel run --help` 确认该版本参数形态），供 watchdog 读取：
  - `cloudflared_tunnel_ha_connections`（应为 4）
  - `cloudflared_tunnel_request_errors`
  - `cloudflared_tunnel_response_by_code{status_code="502"}` 等
- watchdog 增加"连接数 < 4 连续 2 次 → tunnel_degraded"检查；该状态记录，不默认重启（先观察与 530 的相关性）。

#### C. DNS / 代理层验证（P1，先取证后改）

- 取证项（一次性，写入证据目录）：
  - `scutil --dns`、系统代理设置（当前 `127.0.0.1:7897`，Clash Verge）；
  - 对 `region1.v2.argotunnel.com` 做 10 次 `dig @127.0.0.1` 与 10 次直连 1.1.1.1 的对比；
  - 统计 DNS 刷新超时发生前后 5 min 的公网健康检查结果，判断是否与真实断线相关。
- 只有当证据显示 DNS 超时与 530/1033 相关时，才进入参数调整（候选：`--edge-ip-version 4`、`--retries`、`--grace-period`）；**不凭感觉加参数**。
- cloudflared 不读取 `HTTP_PROXY` 环境变量；若经 Clash TUN 路由，需在网络层单独验证，不在本计划中擅自改 Clash 配置。

#### D. 自愈策略（P0，需用户确认）

- 新增 `~/.local/state/devspace/watchdog.conf`（模板入库 `scripts/ops/watchdog.conf.example`）：
  ```sh
  AUTORESTART=1
  AUTORESTART_AFTER=3        # 新增：连续 3 次 tunnel_down 才重启（当前脚本硬编码 2）
  RESTART_COOLDOWN=900
  REMIND_SECONDS=1800
  ```
- 脚本改造：
  - `AUTORESTART_AFTER` 可配置，默认 3；
  - 仅当 `local HTTP == 200` 且状态为 `tunnel_down` 时重启（`local_down`/`host_saturated` 绝不重启隧道）；
  - 重启前后记录回执（时间、PID、前后公网状态），恢复失败升级通知；
  - `--once` / `DRY_RUN` 复用 WS-5 的实现。
- 风险：Cloudflare edge 侧故障时重启本地连接器可能无效但会引起 1–2 min 抖动；冷却 900 s + 连续 3 次阈值用于抑制抖动。

### 7.3 文件级改动

| 文件/路径 | 改动 |
| --- | --- |
| `~/.local/bin/cloudflared` | 升级到 2026.10.3（备份旧版） |
| `~/.local/bin/start-devspace-cloudflared.sh` | 增加 `--metrics 127.0.0.1:20241`（P1，需先确认参数） |
| `~/Library/LaunchAgents/com.liz.cloudflared-devspace.plist` | 无改动（KeepAlive 已满足重启） |
| `scripts/ops/devspace-tunnel-watchdog.sh` | 自愈开关、回执、连接数检查（与 WS-5 同一文件，注意串行实施） |
| `scripts/ops/watchdog.conf.example` | 新模板 |
| `~/.local/state/devspace/watchdog.conf` | 生产配置（不入库） |
| `docs/cloudflare-named-tunnel.md` | 补"版本固定/升级/回滚"一节 |
| `reports/stability-2026-10-24/` | 升级前后证据 |

### 7.4 测试与验收

| 编号 | 测试 | 通过标准 |
| --- | --- | --- |
| WS4-T1 | 升级后 `cloudflared --version` | 2026.10.3，sha256 与校验源一致（冲突已解决） |
| WS4-T2 | 隧道注册 | 日志 4 条 `Registered tunnel connection`；若 B 阶段已启用 `--metrics`，额外断言 `ha_connections=4` |
| WS4-T3 | 公网连通 | 连续 3 轮 watchdog OK；人工 `curl --noproxy '*'` 公网 `/healthz` 200 |
| WS4-T4 | 自愈注入 | `kill -TERM cloudflared` → launchd 自动拉起；再模拟"公网异常"（fixture/dry-run）验证 `AUTORESTART_AFTER` 与冷却；回执完整 |
| WS4-T5 | 24 h 观察 | 记录 origin 不可达 / edge closed / 530 次数，与 §2.2 基线对比；无新增异常重启回环 |
| WS4-T6 | 回滚演练 | 用备份二进制执行 `--version` 与本地健康检查（不切换服务），确认回滚步骤可执行 |

### 7.5 回滚

1. `launchctl bootout`/`kickstart` 前先停 watchdog 的 AUTORESTART，避免回滚过程中被拉起；
2. 备份二进制原子替换回 `~/.local/bin/cloudflared`；
3. `launchctl kickstart -k gui/501/com.liz.cloudflared-devspace`；
4. 验证 4 条连接 + 公网 200；恢复 `watchdog.conf` 原值（或删除）。

---

## 8. 部署窗口与重启检查清单（WS-3/WS-5 需要重启 devspace）

参考 2026-10-14 `RELIABILITY_001` 的教训（重启会打断活跃 Codex/Godot 任务、Coach sidecar 会停止），执行前逐项确认：

- [ ] `curl -s http://127.0.0.1:7676/monitor/api | jq '.jobs.active'` → 0（或已知且可接受）
- [ ] 无活跃 ChatGPT/Web GPT 工具会话（最近 60 s 无 `mcp_wire` 日志）
- [ ] 外部 agent 的 Godot/编译任务已结束或确认可中断（`pgrep -f Godot_mono`）
- [ ] 已备份：`dist/` 当前构建、watchdog 脚本、cloudflared 二进制、`watchdog.conf`
- [ ] 记录重启前 `bootId`、PID、`dist/cli.js` sha256
- [ ] 重启后验证：`/healthz` 200、`devspace_info` 的 bootId/schema、公网 healthz 200、watchdog 连续 3 轮 OK

---

## 9. 统一验收表（全部完成后）

| 门槛 | 通过标准 | 证据 |
| --- | --- | --- |
| WS3_ACCEPTED | 499/CLIENT_ABORT 在日志/monitor/诊断三处一致；正常 200 不变 | 单测日志 + 注入日志片段 |
| WS5_ACCEPTED | monitor 暴露 swap/load/eventLoopMax；watchdog 主机告警与恢复；1 h 无假报 | `/monitor/api` 样例 + `watchdog-host.json` + 通知记录 |
| WS4_ACCEPTED | 2026.10.3 固定、4 连接、自愈注入通过、24 h 观察完成 | 版本 sha、隧道日志、watchdog 回执、基线对比表 |
| NO_REGRESSION | `npm run typecheck`、`npm run test:unit`、`npm run build`、`npm run test:ops` 全绿；MCP 冒烟（`tests/test_mcp_jsonrpc.ts`）通过 | CI/本地日志 |
| DOCS_UPDATED | 本文档状态改为 DONE；`docs/cloudflare-named-tunnel.md`、`docs/logging-contract.md` 更新 | 文档 diff |

---

## 10. 风险与开放问题

### 10.1 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 主机持续被外部测试打满 | 任何"隧道已恢复"的验收都不可信；告警会持续触发 | 先与用户确认测试并发策略（运维侧，非代码）；验收窗口避开全量测试 |
| cloudflared 校验源冲突（正文 vs API digest） | 升级可能装错/被篡改版本 | fail-closed：双源不一致即停止，保留旧版，另行取证 |
| 自愈误重启 | 公网短抖动触发 cloudflared 重启，1–2 min 抖动 | 连续 3 次 + 900 s 冷却 + 仅 tunnel_down 触发 + dry-run 先跑 |
| 499 改变监控语义 | 依赖 `errorRatePercent` 的看板/人需要重新理解 | 文档标注；load 评分权重暂不变，仅计数变化 |
| watchdog 脚本入库后与原脚本漂移 | 两套逻辑不一致 | 安装脚本强制软链/覆盖 + `--version` 注释 + 测试 |
| 日志 copytruncate 与并发写 | 极低概率截断单行 | 轮转时先检查 mtime/size，保留 `.1` 原始副本 |

### 10.2 开放问题（需用户确认）

1. **执行顺序**：按建议 3 → 5 → 4，还是按原编号 3 → 4 → 5？
2. **维护窗口**：何时允许重启 `com.liz.devspace` 与 `com.liz.cloudflared-devspace`（各 1–5 min 中断）？
3. **自愈策略**：是否同意 `AUTORESTART=1`（连续 3 次、900 s 冷却）？还是先只告警观察一周？
4. **阈值**：eventLoopMax 5 s、swap 80%、load1 ≥ 2×核数、可用内存 1 GiB 是否接受？可按你的偏好调整。
5. **watchdog 入库方式**：`~/.local/bin` 改软链到仓库脚本（推荐），还是保留两份由安装脚本同步？
6. **cloudflared 校验冲突**：允许我在升级时先下载并双源校验，不一致就停下报告，而不是必须当天升完？
7. **日志轮转**：是否同意 copytruncate（>100 MB 轮转、保留 2 份）？

---

## 11. 附录

### 11.1 常用取证命令

```bash
# DevSpace 实时指标
curl -s http://127.0.0.1:7676/monitor/api | jq '{eventLoop, system, load, jobs: .jobs.active}'
# 主机压力
sysctl -n vm.loadavg vm.swapusage; sysctl -n hw.ncpu; vm_stat | head -8; memory_pressure | tail -3
# 隧道版本/连接
~/.local/bin/cloudflared --version
launchctl print gui/$(id -u)/com.liz.cloudflared-devspace | grep -E 'state|pid|runs'
grep -c 'Registered tunnel connection' ~/.devspace/logs/cloudflared.err.log
# watchdog
tail -20 ~/.local/state/devspace/watchdog.log; cat ~/.local/state/devspace/watchdog.state
# 最近的客户端中断（WS-3 完成后）
grep '"status":499' ~/.local/state/devspace/devspace.log | tail
```

### 11.2 阈值与配置存放位置

- 代码内常量：`src/live-monitor.ts`（采样周期、历史长度）。
- 运行期配置：`~/.local/state/devspace/watchdog.conf`（不入库，模板在 `scripts/ops/watchdog.conf.example`）。
- 版本固定：cloudflared 二进制 + 本文档记录 sha256；建议同时写入 `docs/cloudflare-named-tunnel.md`。

### 11.3 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-24 | 初稿（基于 02:10–02:19 事故取证） |
