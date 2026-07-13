# Checklist

## Part 1: Hardening

- [ ] 所有工具调用（包括 read）都有 audit log
- [ ] run lock 使用原子文件创建（fs.openSync "wx"）
- [ ] lock 文件包含 run_id/created_at/pid/mode/provider
- [ ] symlink traversal 被拒绝（realpathSync 检查）
- [ ] path traversal 被拒绝
- [ ] negative tests 覆盖 symlink 和 atomic lock

## Part 2: Gated Loop Tools

- [ ] `create_handoff_from_webgpt` 写入 `.devspace/ceo/` 并 validate
- [ ] `submit_coach_review` 遵守 CoachReview 合同
- [ ] `create_next_task` 只从已验证 CoachReview 产生
- [ ] `approve_next_run` 对 run_id+task_hash 有效
- [ ] `start_gated_loop` 需要 approval，支持双重 gate
- [ ] `get_gated_loop_status` 返回完整状态

## Part 3: JSON-RPC Smoke

- [ ] initialize 返回正确 protocol version
- [ ] tools/list 返回所有工具
- [ ] tools/call 各工具返回正确格式
- [ ] 错误不会破坏 MCP server
- [ ] audit log 有每个调用记录

## Part 4: Negative Tests

- [ ] `../../package.json` 路径穿越被拒绝
- [ ] symlink 指向外部被拒绝
- [ ] free mode 无 allow_free_mode 被拒绝
- [ ] real provider 无 allow_real_provider 被拒绝
- [ ] real+free 无 allow_real_free_mode 被拒绝
- [ ] 并发 start 只有一个成功
- [ ] stale lock 行为正确
- [ ] submit_coach_review 缺 verdict 被拒绝
- [ ] PASS 无 next_task 且非 DONE 被拒绝
- [ ] stale approval 被拒绝
- [ ] stop 后旧 run 不能写
- [ ] unknown tool 有结构化错误

## Part 5: Reviews

- [ ] Tester review PASS
- [ ] Security review PASS
- [ ] Contract review PASS
- [ ] Red Team review PASS

## Hard Stop Conditions (must all be false)

- [ ] 读工具没有 audit
- [ ] run lock 非原子
- [ ] symlink traversal 可读外部文件
- [ ] free mode 可绕过 gate
- [ ] real provider 可绕过 gate
- [ ] real+free 可绕过 double gate
- [ ] approve_next_run 可重放
- [ ] unknown tool 未 audit
- [ ] stop 后旧 run 可继续写
- [ ] JSON-RPC smoke 失败
