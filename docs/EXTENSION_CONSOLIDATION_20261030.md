# Chrome 扩展分支与代码整理 — 2026-10-30

状态：**CONSOLIDATED_BRANCH_READY**（A+B 合并完成；V6 投递协议已对齐；扩展测试套件双绿；生产 checkout 未动）

本文是 DevSpace Chrome 扩展（`coach-browser-extension`）积压分支/版本的一次性整理记录。
目标：把历史上分叉的两条扩展功能线合并成一条 canonical 分支，明确 test-only 补丁边界，
并为后续（Web GPT 独立复审通过后）更新生产扩展提供可回滚路径。

---

## 1. 问题：为什么“太多太乱”

整理前扩展代码分散在三条互不对齐的线上：

| 线 | 代表提交 | 扩展版本 | 内容 |
|---|---|---|---|
| A. 原生 App 审核/通知线 | `a334311`（分支 `…/devspace-devspace-58d91e4a` tip） | manifest **0.3.18** | 原生 App review 通知、supersede 旧通知、分页 feed（`autoFetchFeed`）、popup/面板 UI 改版、`coach_webgpt_acknowledge_turn` |
| B. exact 多路由 + DSH 线 | `efee92d`（P6 分支 `…/devspace-devspace-71a9f58a` tip `013ba62` 的后代） | manifest **0.3.10**（未 bump） | exact route 一键绑定（`autoOneClickExact`）、`multiroute-gate.js`、`/routes/:id/next|ack|revoke` 消费、P6 DSH 完成自动入队 |
| C. DSH wake v1 实验线 | `feat/dsh-event-wake-v1`、`feat/dsh-event-wake-integration` | 0.3.12 / 0.3.14 | 早期的 8788 旁路 wake feed（已被 B/P6 路线取代） |

A 与 B 的共同祖先是 `1fa5cf9`，两条线各自改了同一个 `auto-worker.js` 与测试套件但没有互相合并。
生产主 checkout `/Users/liz/agy/devspace` 里的 **unpacked 扩展目录更是混合树**：
8 个 tracked 文件未提交；其中 5 个与 `a334311` 逐字节一致，而
`chatgpt-delivery.js` 不匹配近期任何提交、`panel.js` 匹配旧的 4518158/50bd636、
`worker.js` 匹配旧的 3094b4c/0d19f2c（DSH wake v1 线）。即生产扩展 = 0.3.18 主体 + 几个旧实验文件。

备份（整理前已做，只读快照）：
- `/Users/liz/agy/P6-WAKE-TEST/backup/prod-extension-wip-20261030-112700.tgz`
- `/Users/liz/agy/P6-WAKE-TEST/backup/prod-extension-wip-20261030-112700.patch`
- sha256(tgz)：`4e5eaa6c9496a778d8e579a4cb039271c916eb8bfa5260be03f976d3a4cb1bb1`

---

## 2. 合并方案（canonical 分支）

- 分支：`devspace/integration/extension-consolidated-20261030`
- 基线：`013ba62`（B 线 tip，含 P6 bootstrap 与全部 src 侧 DSH wake 实现）
- 合并：`a334311`（A 线 tip，0.3.18 原生 App 审核功能）
- 合并基：`1fa5cf9`
- 扩展 manifest：**0.3.19**（A+B 合并版本；0.3.18 的 A 线内容 + 多路由/DSH 内容）
- 产品代码修复：`autoOneClickExact()` 里读取未声明 `url` 的 bug（此前异常被 `catch` 吞掉并静默回退到 legacy `/bind/start`，导致 exact `/route/propose` 永远不可达）。现为产品代码内置修复（`const url=autoCanonical(tab?.url)`），不再只是 test-only 补丁。

冲突解决（5 个文件，均为“两边功能都保留”的并集式解决）：

| 文件 | 解决方式 |
|---|---|
| `coach-browser-extension/auto-worker.js` | `autoPump` 保留 B 的 exact multi-route pump + legacy 路由 guard；legacy feed 改用 A 的分页 `autoFetchFeed`（含 DSH wake v1 旁路 feed 的可选合并，见 §4） |
| `src/managed-coach-sidecar.ts` | `Entry` 保留 B 的 routeStore/routeBridge；`DeliveryReceipt.event_id` 采用 A 的 `number|string`；`claimBrowserRoute` 返回类型并集 `boolean|Promise<boolean>`；控制接口保留 B 全部 route API |
| `src/server/server-types.ts` | `TOOL_SCHEMA_REVISION` 并集：`…codex-app-shared-001+coach-multiroute-v1+codex-app-autowake-001+native-outbound-001+cli-delivery-scope-v1` |
| `src/server/server-helpers.ts` | capability 工具白名单并集：`coach_webgpt_claim_browser_route_exact`、`coach_route_admin`、`coach_webgpt_acknowledge_turn` 全部保留 |
| `src/coach-tool-catalog.test.ts` | 上述并集的对应断言（工具存在性/capability/TOOL_SCHEMA_REVISION 正则） |

测试套件修复：合并后 `src/coach-auto-delivery.test.cjs` / `src/coach-browser-extension.test.cjs`
需要适配 A 的分页 feed 协议（`has_more`/`next_cursor`、`/events?limit=50`）与唯一 event identity；
仅更新过期 mock/fixture，不削弱安全断言（认证、identity、去重、uncertain 不重发、receipt、绑定）。

### 2b. 投递协议 V6/V5 对齐（合并时发现的关键缺口）

A 线 `auto-worker.js` 已使用 **V6** 投递协议（`COACH_AUTO_PING_V6` / `COACH_AUTO_DELIVER_V6`，
`autoReady` 要求 `protocol===6`），但其同提交的 `chatgpt-delivery.js` 仍是 **V5** 内容脚本。
若不修复，合并/生产都会出现：ping 永远收不到 `protocol:6` → 重复注入 V5 脚本 → `content_unreachable`
→ 自动投递 100% 失效。

修复材料来自生产工作树里的**未提交唯一副本**（commit 3094b4c 的 V6 脚本 + 一行 `busy:true` 补丁，
其 blob 不在 object DB；备份见 §1）：
- `coach-browser-extension/chatgpt-delivery.js` ← 生产 WIP V6 脚本
  （sha256 `8eeeab98f2172b0ab234daa444a339f837ad7d2d05be40034e883782b05658b4`），
  含 DSH mailbox 指令模板与普通 review free-form 指令路径；
- `coach-browser-extension/worker.js` ← 并入生产 WIP 的 `DSH_MAILBOX_WAKE` 接受逻辑
  （`validDshWake`、`dsh:`/messageId identity），同时保留 B 线的
  `importScripts("multiroute-gate.js")`；
- `coach-browser-extension/panel.js` ← 并入 `kindLabel`（`DSH_MAILBOX_WAKE` → 「信箱唤醒」）。

至此生产工作树里“A 骨架 + dsh-wake lab 文件 + 未入库 V6 投递”的可用组合被**完整捕获**进 canonical 分支，
生产 checkout 本身保持不动。

---

## 3. test-only 补丁边界（不进入产品分支）

真实唤醒 E2E 用的测试扩展副本 `/Users/liz/agy/P6-WAKE-TEST/test-extension/` 曾打 2 处补丁：

1. **跳过“要求 Web GPT 调 MCP claim”的注入**（`autoOneClickExact` 内部）：隔离测试 Sidecar 没有
   Web GPT MCP 可达，绑定由 P6 test bootstrap 本地 claim。**仍只属于 test harness，不进入产品分支。**
2. **`url` 未定义 bug 修复**：已升级为产品代码修复（见 §2），测试副本重新生成时不再需要此补丁。

建议：整理后若还要跑真实唤醒 E2E，从 consolidated 分支的 `coach-browser-extension/` 重新生成测试副本，
仅再打补丁 #1，并保留 “TEST-ONLY / NEVER SHIP” 标记。

---

## 4. 已知保留项 / 后续清理候选

- `DSH_WAKE_SIDECAR_PORT = 8788` / `ws_325cba3d…` 的 DSH wake v1 旁路 feed 代码由 A 线带入：
  dormant（8788 无服务时自动跳过），但已被 P6 route 机制取代。建议在独立复审后删除，
  本次整理不改变该行为，避免混入未审改动。
- `src/coach-auto-delivery.test.cjs` 与 `src/coach-browser-extension.test.cjs` 存在重叠用例
  （后者 `require` 前者）：本次只修复到双绿，测试合并在后续单独进行。
- 生产 checkout 的混合 WIP 文件**本次不覆盖**：需 Web GPT 独立复审 consolidated 分支后再更新生产。

---

## 5. 验证命令（在 consolidated worktree 内）

```bash
cd /Users/liz/.devspace/worktrees/devspace-ext-consolidated-20261030
npm run typecheck
node --test src/coach-auto-delivery.test.cjs
node --test src/coach-browser-extension.test.cjs
node --test src/coach-multiroute-extension.test.cjs
node --test src/coach-native-app-wake.test.mjs
node --test src/coach-binding-transport.test.cjs
node --import tsx src/coach-tool-catalog.test.ts
# P6 回归
node --import tsx src/coach-routes/p6-test-bootstrap.test.ts
node --import tsx src/coach-routes/p6-autotrigger.test.ts
node --import tsx src/coach-routes/dsh-bridge-ingress.test.ts
```

证据日志：`/Users/liz/agy/CROSS-AGENT-BRIDGE-001/dsh-autoloop-recovery/EXT-CONSOLIDATION-GATES-20261030.log`

---

## 6. 后续：把统一扩展更新到生产（复审通过后，需用户明确授权）

1. 备份生产 unpacked 扩展目录（tar + patch），记录 sha256；
2. 用 consolidated 分支的 `coach-browser-extension/` 覆盖 `/Users/liz/agy/devspace/coach-browser-extension/`；
3. 在 Chrome `chrome://extensions` 点扩展卡片「重新加载」；
4. 重新配对（生产 native host 自动或手动），跑一次生产回归（Codex 审核通知 + 路由绑定）；
5. 失败回滚：恢复备份目录 → 重新加载 → 重新配对。

不得 merge/push/deploy；本整理只产生一条本地 canonical 分支与文档。

---

## 7. 本次验证结果（2026-10-30）

全部在 consolidated worktree 内真实执行；原始输出见
`/Users/liz/agy/CROSS-AGENT-BRIDGE-001/dsh-autoloop-recovery/EXT-CONSOLIDATION-GATES-20261030.log`
（最终一轮为 `/tmp/p6-final-gates.log`，已合并进上述日志）。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `node --test src/coach-auto-delivery.test.cjs` | 66 pass / 0 fail |
| `node --test src/coach-browser-extension.test.cjs` | 81 pass / 0 fail |
| `node --test src/coach-multiroute-extension.test.cjs` | 11 pass / 0 fail |
| `node --test src/coach-native-app-wake.test.mjs` | 13 assertions PASS（version 字段为 mock 的 0.3.18） |
| `node --test src/coach-binding-transport.test.cjs` | 1 pass / 0 fail |
| `node --import tsx src/coach-tool-catalog.test.ts` | PASS（103 tools） |
| P6 `p6-test-bootstrap.test.ts` | 3/3 PASS |
| P6 `p6-autotrigger.test.ts` | 2/2 PASS |
| P6 `dsh-bridge-ingress.test.ts` | 8/8 PASS |

已知非本次回归：`src/coach-agent-audit-browser.test.cjs` 在基线 B（013ba62）上就因
“importScripts is not defined”2 条失败，本次合并未改变其状态（未纳入本次验收门）。

测试修复说明：两个扩展套件的 content-script harness 已升级到 V6（ping/deliver protocol 6、
DSH wake 精确模板负例、`worker.feedCheck` 的 DSH_MAILBOX_WAKE 校验）；新增覆盖但没有删除或
放宽任何安全断言（认证、identity、去重、uncertain 不重发、receipt、绑定、route 冲突、指令校验）。

### 未做（有意）

- 真实 Chrome / ChatGPT 端到端唤醒：仍属 P6 真实测试范畴，本次只做分支与代码整理；
  若继续 E2E，请从本分支重新生成 `/Users/liz/agy/P6-WAKE-TEST/test-extension/`，
  仅再打 test-only 补丁 #1（跳过 MCP claim 注入），V6 内容脚本与 url 修复已进入产品代码。
- 生产 checkout 仍保持 8 个未提交 WIP 原样；未 reload 生产扩展、未重启任何服务。
- 分支删除：见 `EXTENSION-BRANCH-INVENTORY-20261030.md` 的 KEEP/ARCHIVE/DELETE 建议，
  本次未删除任何分支/worktree，仅建议先 tag/bundle 再清理。
