# Checklist

## Part 1: Audit Upgrade

- [x] `AuditEntry` 包含 `event_id` 字段（UUID v4 格式）
- [x] `AuditEntry` 包含可选 `parent_event_id` 字段
- [x] `result_status` 使用枚举：`OK | ERROR | REJECTED | RECOVERED | UNKNOWN_TOOL`
- [x] `createAuditEntry()` 自动生成 `event_id`
- [x] `handlers.ts` 中无任何 `writeAudit()` / `createAuditEntry()` 调用
- [x] `tools.ts` 的 `callTool()` 是唯一的审计写入点
- [x] `mcp_audit.jsonl` 中每行都有 `event_id`

## Part 2: Stale Lock Recovery

- [x] `recover_stale_lock` 工具注册在 schemas.ts 中
- [x] `recover_stale_lock` 参数包含 `ttl_seconds`（默认 300）和 `force`（默认 false）
- [x] pid 存活检测在 Windows 和 Unix 下都能工作
- [x] lock 不存在时返回明确状态（非错误）
- [x] pid 死亡时 lock 被删除，返回 RECOVERED
- [x] TTL 超时时 lock 被删除，返回 RECOVERED
- [x] pid 存活且 TTL 未过期时返回 REJECTED
- [x] `force: true` 跳过 pid/TTL 检查直接删除（含 safety_flags: ["FORCE_LOCK_REMOVAL"]）
- [x] recovery 操作写入 audit log（通过 callTool 统一路径）

## Part 3: Smoke Test

- [x] `runSmoke()` 中 tools/list 返回 20 个工具
- [x] `recover_stale_lock` happy path 测试通过（5 个子路径）
- [x] `start → pause → resume → stop` 完整生命周期测试通过
- [x] `stop → stop` 返回 STOPPED（idempotent）
- [x] lock 已存在时 start 拒绝
- [x] missing verdict 拒绝
- [x] PASS without next_task 拒绝
- [x] stale approval 拒绝
- [x] unknown tool 返回结构化错误
- [x] answer_need_user 输入校验拒绝

## Part 4: JSON-RPC Smoke

- [x] MCP server 进程可被 spawn 并通过 stdin/stdout 通信
- [x] `initialize` 返回 protocolVersion: "2024-11-05"
- [x] `tools/list` 返回正确数量的工具
- [x] `tools/call` 各工具返回正确 JSON-RPC 格式
- [x] 错误格式 JSON 返回 Parse error (-32700)
- [x] 未知方法返回 Method not found (-32601)
- [x] server 进程正常退出

## Part 5: Gated Loop E2E

- [x] create_handoff_from_webgpt 成功写入 handoff 文件
- [x] approve_next_run 成功创建 approval
- [x] start_gated_loop(mock) 成功启动
- [x] submit_coach_review(PASS + next_task) 成功
- [x] create_next_task 成功更新 current_task.md
- [x] task_hash 变化后旧 approval 失效
- [x] 第二轮 start_gated_loop 需要重新 approve
- [x] stop 后清理正确

## Part 6: Subagent Reviews

- [x] Tester review PASS
- [x] Security review PASS_WITH_WARNINGS（force safety_flags + parent_event_id UUID 校验已修复）
- [x] Contract review PASS_WITH_WARNINGS（params.name 校验 + require() 已修复）
- [x] Red Team review PASS

## Hard Stop Conditions (must all be false)

- [x] unattended free mode 未被开放（allow_real_free_mode gate 保留）
- [x] audit 日志中每行都有 event_id
- [x] handlers.ts 中无 writeAudit() 调用
- [x] stale lock recovery force 模式含 safety_flags 标记
- [x] recover_stale_lock 的 force 参数有 safety_flags 守卫
- [x] JSON-RPC smoke 测试通过 (10/10)
- [x] Gated loop E2E 测试通过 (16/16)
- [x] smoke test 41/41 全部通过
