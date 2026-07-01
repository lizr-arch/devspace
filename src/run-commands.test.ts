import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = join(
  dirname(require.resolve("tsx/package.json")),
  "dist",
  "cli.mjs",
);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "devspace-run-commands-test-"));

try {
  const devspaceDir = join(root, ".devspace");
  const ceoDir = join(devspaceDir, "ceo");
  await mkdir(ceoDir, { recursive: true });

  await writeFile(
    join(ceoDir, "delegate_contract.md"),
    `# Delegate Contract

## Acceptable Risk Level
low

## Maximum Auto Scope
test only

## What User Proxy CAN Do
- current task

## What User Proxy CANNOT Do
- publish_externally

## MUST Trigger NEED_USER When
- change_architecture
`,
  );

  await writeFile(
    join(ceoDir, "stop_conditions.md"),
    `# Stop Conditions

## DONE Conditions
- Task is complete

## BLOCKED Conditions
- Missing dependency

## NEED_USER Conditions
- Need a user decision

## SAFETY_STOP Conditions
- Dangerous operation

| Limit | Value |
| Max Rounds | 1 |
| Max Consecutive Failures | 2 |
| Max Runtime | 60 |
| Max File Changes | 10 |
`,
  );

  await writeFile(
    join(ceoDir, "autonomy_policy.md"),
    `# Autonomy Policy

## Current Mode
delegate
`,
  );

  await writeFile(
    join(devspaceDir, "current_task.md"),
    `# 任务：验证 run current

## 状态
待执行

## 任务ID
\`task-run-001\`

## 目标
验证 run current 会真实生成执行报告

## 背景
当前命令需要替代占位输出，生成可读的运行结果。

## 允许修改范围
- src/*

## 禁止修改范围
- package.json

## 验收标准
- [ ] 生成 execution_report.md
- [ ] 生成 runs 目录产物

## 必须运行的测试
\`\`\`bash
npm test
\`\`\`

## 报告格式要求
1. 修改文件列表
2. 测试结果

## 失败时如何处理
1. 说明问题
2. 提供下一步

## 优先级
P1
`,
  );

  await writeFile(join(devspaceDir, "execution_report.md"), "# 执行报告\n\n## 状态\n待执行\n");

  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "run",
      "current",
      "--provider",
      "mock",
      "--mode",
      "delegate",
      "--max-rounds",
      "1",
      "--timeout",
      "5",
    ],
    { cwd: root },
  );

  const report = await readFile(join(devspaceDir, "execution_report.md"), "utf-8");
  assert.match(report, /task-run-001/);
  assert.doesNotMatch(report, /## 状态\n待执行/);

  const runs = await readdir(join(devspaceDir, "runs"));
  assert.equal(runs.length > 0, true);

  const latestRun = runs.sort().at(-1);
  assert.ok(latestRun);
  assert.equal(
    existsSync(join(devspaceDir, "runs", latestRun, "local_report.md")),
    true,
  );

  const reportCommand = await execFileAsync(
    process.execPath,
    [tsxCliPath, cliPath, "run", "report"],
    { cwd: root },
  );
  assert.match(reportCommand.stdout, /Latest Run:/);
  assert.match(reportCommand.stdout, /Execution Report:/);
} finally {
  await rm(root, { recursive: true, force: true });
}
