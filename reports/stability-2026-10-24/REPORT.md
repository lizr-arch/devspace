# DevSpace 稳定性加固执行报告（WS-3 / WS-4 / WS-5）

- 日期：2026-10-24
- 计划文档：`docs/plans/2026-10-24-stability-hardening-ws3-ws4-ws5-plan.md`
- 执行顺序：WS-3 → WS-5 → WS-4 → 合并 main → 构建 → 重启（按计划建议顺序）
- 触发事故：2026-10-24 02:10–02:19（CST）ChatGPT Web 连接器断线，watchdog 报 502/000

## 1. 结论

| 工作流 | 状态 | 摘要 |
| --- | --- | --- |
| WS-3 日志语义 | DONE | 客户端中断统一 499/CLIENT_ABORT，新增可测中间件模块与测试 |
| WS-5 主机可观测性 | DONE | monitor 暴露 load/swap/memory-pressure/eventLoopMax；watchdog 入库、可配置、可自愈、可 dry-run；日志轮转 |
| WS-4 隧道加固 | DONE | cloudflared 2026.7.3 → 2026.10.3（签名/双校验），4 条连接 + 公网 200；metrics 默认可用；AUTORESTART 启用 |
| 合并/构建/重启 | DONE | 见 §6（main `3427e57`，新 bootId，公网 200） |

## 2. 基线（事故证据）

- 宿主机：10 核，load 峰值 22–31，系统 CPU 95–100%，swap 峰值 19.7/20.5 GB，可用内存 225 MiB；
- DevSpace：PID 14098（2026-10-22 01:06 起未重启），事件循环 `p95 = 27 950.8 ms`；
- cloudflared（旧）：2026.7.3，每日 edge closed 8–74 次、origin 不可达 0–18 次、DNS 刷新超时 0–5 次；
- 客户端：约 300 s 取消长工具调用（`resume_workspace` 318 761 ms、`project_task` 397 760 ms），触发连接器重连（4 次 `initialize`）。

## 3. WS-3 交付

| 文件 | 变更 |
| --- | --- |
| `src/server/request-logging.ts` | 新增：中间件工厂 + `resolveRequestOutcome`；中断 → 499 + `aborted: true` |
| `src/server/express-routes.ts` | 内联中间件替换为工厂；删除不再使用的导入 |
| `src/server/request-logging.test.ts` | 新增：正常 201 / 非 MCP 中断 / MCP 中断（CLIENT_ABORT statusCode=499） |
| `src/live-monitor.test.ts` | 断言 499 计入 error 指标 |
| `package.json` | `test:unit` 注册新测试 |

验证：

```
npx tsx src/server/request-logging.test.ts      -> request logging abort semantics PASS
npx tsx src/live-monitor.test.ts                -> live monitor tests passed
npx tsx src/mcp-diagnostics.test.ts             -> mcp diagnostics ... PASS
# live (post-restart): 中断 762K 静态资源流后
# devspace.log: {"path":"/assets/emacs-lisp-...js","status":499,"aborted":true}
# /monitor/api: http.errors=1, recentErrors=1, HTTP_499 event present
npx tsc -p tsconfig.json --noEmit               -> exit 0
```

## 4. WS-5 交付

| 文件 | 变更 |
| --- | --- |
| `src/live-monitor.ts` | 新增 `cpuCount`、`loadAverage`、`swapUsedMiB/Total/Percent`、`memoryPressureFreePercent`、history `eventLoopMaxMs/swapUsedPercent`；vm_stat/sysctl 5 s 缓存采样 |
| `src/server/express-routes.ts` | `/monitor/api` system 块暴露新字段与口径标记 |
| `src/live-monitor.test.ts` | 新字段与 history 断言 |
| `scripts/ops/devspace-tunnel-watchdog.sh` | 入库版 watchdog：三层隧道检查 + 主机/内存压力维度 + AUTORESTART_AFTER + dry-run + fixture + 日志轮转 |
| `scripts/ops/watchdog.conf.example` | 阈值/冷却/URL 配置模板 |
| `scripts/ops/install-devspace-watchdog.sh` | 备份 + 安装 + kickstart + 单轮校验 |
| `scripts/ops/devspace-tunnel-watchdog.test.sh` | 8 场景 fixture 测试（healthy/local_down/tunnel_down/自愈/conf/饱和/恢复/重提醒） |
| `package.json` | 新增 `test:ops` |

验证：

```
bash scripts/ops/devspace-tunnel-watchdog.test.sh -> devspace watchdog tests PASS
# live: launchd 下每 ~60 s 运行一次；03:52-03:54 观测到
#   ALERT dimension=host consecutive=2 load1=31.51 cpuCount=10
#   ALERT dimension=memory consecutive=3 swapUsedPercent=88 memoryAvailableMiB=114
#   隧道维度保持 healthy，未触发 AUTORESTART（真阳性，非误报）
```

> 说明：macOS 上 `os.freemem()` 不含 inactive/speculative，`memoryUsedPercent` 会偏高；API 通过 `memoryAccounting` 与 `memoryPressureFreePercent` 标注真实口径，避免误判。

## 5. WS-4 交付

### 5.1 版本与校验

| 项目 | 值 |
| --- | --- |
| 升级后版本 | `2026.10.3`（built 2026-10-21） |
| 二进制路径 | `~/.local/bin/cloudflared` |
| 二进制 sha256 | `f249139e0541fa589c987397d867cc16c83ab1236d31eb6782f2e4552ee9cf80` |
| 备份（旧版） | `~/.local/share/devspace/bin-backup/cloudflared-2026.7.3`（sha256 `f35c5008…ed6257`） |
| 压缩包 sha256 | `1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55`（= GitHub API asset digest） |
| 签名 | Developer ID Application: Cloudflare Inc. (68WVV388M8) |

**校验冲突澄清**：GitHub Release 正文 checksum 行虽以 `.tgz` 命名，实际是解压后二进制的哈希；GitHub API 的 `digest` 是压缩包哈希。二者分别对应不同对象，因此升级同时验证两层：压缩包 = API digest、解压二进制 = 正文 checksum，均通过。

### 5.2 升级后验证

- `cloudflared --version` → 2026.10.3；
- 隧道日志 4 条 `Registered tunnel connection`（connIndex 0–3，http2）；
- `http://127.0.0.1:20241/metrics` → `cloudflared_tunnel_ha_connections 4`（metrics 默认已可用，无需改启动脚本）；
- 公网 `https://mcp.workspaceport.com/healthz` → 200；
- watchdog 连续 OK（见 §6 部署后验证）。

### 5.3 自愈配置

安装 `~/.local/state/devspace/watchdog.conf`（来自 `watchdog.conf.example`）：`AUTORESTART=1`、`AUTORESTART_AFTER=3`、`RESTART_COOLDOWN=900`、主机阈值按计划默认值。仅在 `local http=200 && tunnel_down && 连续 3 次` 时重启 cloudflared；`local_down`/`host_saturated` 不重启。

## 6. 合并、构建与重启验收

### 6.1 代码与构建

| 项目 | 值 |
| --- | --- |
| 提交 1 | `63e9f41` fix(test): doctor 工具面钉值与当前 main 对齐（main 原本已红：revision / 工具数 / 只读清单三处过期） |
| 提交 2 | `dc2b29e` feat(observability): 499/CLIENT_ABORT + 主机压力指标 |
| 提交 3 | `3427e57` feat(ops): watchdog 入库 + cloudflared 版本固定文档 |
| main | `3427e57`（fast-forward；本地领先 `origin/main` 3 个提交，未推送） |
| 构建 | `npm run build` 通过（含 typecheck） |
| `dist/cli.js` sha256 | `1265140c08386e8ccd0ee70d3936371705434e40646cad79a9f714e18fa74ccd` |
| `dist/live-monitor.js` sha256 | `4d9ef6fd8d01bb1920aa5b6067cc267a0a6928ac37a0389d5203a15f23eeb128` |
| `dist/server/request-logging.js` sha256 | `34be7c73af333877b567835a6a2455380b713b53045fc1d32662fd62f2202e6a` |

### 6.2 重启

- 重启前：PID 14098，bootId `9f7eb330-…`，jobs active 0，MCP in-flight 0；
- `launchctl kickstart -k gui/$(id -u)/com.liz.devspace`；
- 重启后：PID **35342**，bootId **`e7f51179-7fae-47fd-be0c-1dcc82b1e1c3`**，startedAt `2026-10-23T19:51:51.916Z`，launchd `runs=26`；
- 本地 `/healthz` 200；公网 `https://mcp.workspaceport.com/healthz` 200；`cloudflared_tunnel_ha_connections 4`。

### 6.3 新监控字段（活体）

```json
{
  "system": {
    "cpuCount": 10,
    "loadAverage": {"one": 35.73, "five": 29.5, "fifteen": 23.31},
    "swapUsedMiB": 11013.38,
    "swapTotalMiB": 12288,
    "swapUsedPercent": 89.6,
    "memoryPressureFreePercent": 18.7,
    "memoryAccounting": "freemem_excludes_inactive_speculative"
  },
  "eventLoop": {"p95Ms": 23.6, "maxMs": 24.9},
  "resourceHistory[0]": {"eventLoopMaxMs": 0, "swapUsedPercent": 89.6}
}
```

### 6.4 watchdog 安装与活体验证

- `scripts/ops/install-devspace-watchdog.sh --with-config`：安装到 `~/.local/bin/devspace-tunnel-watchdog.sh`，旧脚本备份为 `.pre-20261024-035214`；
- `~/.local/state/devspace/watchdog.conf`：`AUTORESTART=1 / AUTORESTART_AFTER=3 / RESTART_COOLDOWN=900`、主机阈值 5 s/2×核/80%/1 GiB、`METRICS_URL=http://127.0.0.1:20241/metrics`、`EXPECTED_CONNECTIONS=4`；
- launchd `com.liz.devspace-watchdog` 已 kickstart，03:52–03:54 观测到约 60 s 周期运行；
- 单轮输出：`tunnelStatus=healthy, hostChecked=true, cloudflaredConnections=4`；
- 真实高负载下 `host_saturated`（load1 25–33 > 20）与 `memory_pressure`（swap 88–91% > 80%，可用 114–613 MiB）均为**真阳性**；隧道维度健康，未触发 `AUTORESTART`；
- 日志轮转：首次运行即把 156.9 MB 的 `devspace.log` copytruncate 为 `.1`（150 MB）+ 新文件。

### 6.5 WS-3 活体验证

客户端中断 762 KB 静态资源流后：

```json
{"event":"http_request","method":"GET","path":"/assets/emacs-lisp-...js","status":499,"durationMs":82,"aborted":true}
```

`/monitor/api`：`requests.http.errors=1`、`recentErrors=1`、`errors.recent` 出现 `HTTP_499`（`GET /other aborted by client`，`/other` 为 `safeMonitorPath` 的既有脱敏行为）。

### 6.6 单元/集成门槛

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| `npm run test:unit` | exit 0（62 个测试文件全绿，含新增 request-logging 测试） |
| `npm run test:ops` | `devspace watchdog tests PASS` |
| `npm run build` | exit 0 |

> 说明：`npm run test:unit` 首次运行时暴露 main 已有红测（`src/doctor.test.ts` 的 revision/工具数/只读清单钉值过期），已用独立提交 `63e9f41` 修复；这是测试维护，不改变生产行为。

## 7. 待观察 / 未闭环

1. cloudflared 24 h 观察：origin 不可达 / edge closed / 530 次数与基线对比。
2. 主机告警在**真实高负载**下 1 h 误报复核（当前 8 个 Godot 验收测试为真实来源时，`host_saturated` 属真阳性；需确认去重与提醒节奏）。
3. ChatGPT Web 连接器页面级验证（重连后工具是否正常）。
4. `resume_workspace`/`list_workspaces` 长调用本身未优化（WS-6 候选：立即返回 job + 轮询），本次仅修复可观测性与隧道自愈。
5. 外部 agent 全量测试并行策略仍属运维决策，不由本仓库代码强制。

## 8. 回滚

- WS-3/WS-5：`git revert <commit>` → `npm run build` → 维护窗口重启 `com.liz.devspace`。
- WS-4：还原 `~/.local/share/devspace/bin-backup/cloudflared-2026.7.3` 到 `~/.local/bin/cloudflared` → `launchctl kickstart -k gui/$(id -u)/com.liz.cloudflared-devspace`；回滚前先把 watchdog `AUTORESTART=0`。
- watchdog：`install` 脚本会在 `~/.local/bin/` 保留 `devspace-tunnel-watchdog.sh.pre-<timestamp>` 备份。
