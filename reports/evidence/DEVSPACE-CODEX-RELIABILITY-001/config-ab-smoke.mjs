import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { codexChildEnvironment } from "../../../dist/codex-proxy-environment.js";

const env = { ...process.env };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
const childEnv = codexChildEnvironment(env);
const results = [];
for (const ignoreUserConfig of [false, true]) {
  const args = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"];
  if (ignoreUserConfig) args.push("--ignore-user-config");
  args.push("--disable", "chronicle", "--model", "gpt-6-luna", "-c", 'model_reasoning_effort="none"', "-");
  const started = Date.now();
  const child = spawnSync("/Users/liz/.local/bin/codex", args, {
    env: childEnv, cwd: "/tmp",
    input: "Reply with exactly OK. Do not run any tools or commands.\n",
    encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024,
  });
  const eventTypes = [];
  let exactReply = false;
  for (const line of (child.stdout ?? "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (typeof event.type === "string") eventTypes.push(event.type);
      if (event.type === "item.completed" && event.item?.type === "agent_message" &&
          typeof event.item.text === "string") exactReply ||= event.item.text.trim() === "OK";
    } catch {}
  }
  const passed = child.status === 0 && eventTypes.includes("thread.started") &&
    eventTypes.includes("turn.started") && eventTypes.includes("turn.completed") && exactReply;
  const result = { ignoreUserConfig, model: "gpt-6-luna", reasoningEffort: "none",
    elapsedMs: Date.now() - started, exitCode: child.status, signal: child.signal,
    spawnError: child.error?.code, eventTypes, exactReply, passed };
  results.push(result);
  process.stdout.write(JSON.stringify(result) + "\n");
  assert.ok(passed, `A/B run failed (ignoreUserConfig=${ignoreUserConfig})`);
}
process.stdout.write(JSON.stringify({ pairPassed: results.length === 2 && results.every((r) => r.passed) }) + "\n");
