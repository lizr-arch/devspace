import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexChildEnvironment } from "../../../dist/codex-proxy-environment.js";
import { NativeCodexAgentRunner } from "../../../dist/codex-agent-runner.js";
import { CoachReviewEventStore } from "../../../dist/coach-review-events.js";
import { AgentObserverStore } from "../../../dist/agent-observer.js";

const runTag = Date.now();
const operationIds = [1, 2, 3].map((n) => `devspace-codex-reliability-001-${runTag}-direct-0${n}`);
const env = { ...process.env };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
const childEnv = codexChildEnvironment(env);
const direct = [];
for (const operationId of operationIds) {
  const args = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check",
    "--ignore-user-config", "--disable", "chronicle", "--model", "gpt-6-luna", "-c",
    'model_reasoning_effort="none"', "-"];
  const started = Date.now();
  const child = spawnSync("/Users/liz/.local/bin/codex", args, {
    env: childEnv, cwd: tmpdir(),
    input: "Reply with exactly OK. Do not run any tools or commands.\n",
    encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024,
  });
  const eventTypes = [];
  const errorCategories = [];
  let exactReply = false;
  for (const line of (child.stdout ?? "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (typeof event.type === "string") eventTypes.push(event.type);
      if (event.type === "error" || event.type === "turn.failed") {
        const value = JSON.stringify(event).toLowerCase();
        errorCategories.push(/timeout|timed out|deadline/.test(value) ? "timeout"
          : /429|rate.limit|quota/.test(value) ? "rate_or_quota"
          : /401|403|unauthorized|auth/.test(value) ? "authentication"
          : /500|502|503|504/.test(value) ? "provider_5xx" : "unclassified");
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" &&
          typeof event.item.text === "string") exactReply ||= event.item.text.trim() === "OK";
    } catch {}
  }
  const passed = child.status === 0 && eventTypes.includes("thread.started") &&
    eventTypes.includes("turn.started") && eventTypes.includes("turn.completed") && exactReply;
  const row = { operationId, model: "gpt-6-luna", reasoningEffort: "none",
    elapsedMs: Date.now() - started, exitCode: child.status, signal: child.signal,
    spawnError: child.error?.code, eventTypes, errorCategories, exactReply, passed };
  direct.push(row);
  process.stdout.write(JSON.stringify(row) + "\n");
  assert.ok(passed, `${operationId} did not complete the read-only OK task`);
}

const evidenceDir = new URL(".", import.meta.url).pathname;
const stateDir = join(evidenceDir, `native-state-${runTag}`);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const workspaceRoot = mkdtempSync(join(tmpdir(), "devspace-codex-rel001-native-"));
const events = new CoachReviewEventStore(stateDir);
const observer = new AgentObserverStore();
const runner = new NativeCodexAgentRunner({
  events, observer, nodePath: "/Users/liz/.local/bin/node", codexPath: "/Users/liz/.local/bin/codex",
});
const operationId = `devspace-codex-reliability-001-${runTag}-native-01`;
const status = await runner.run({
  workspaceId: "devspace-codex-reliability-001", workspaceRoot, operationId,
  prompt: "Reply with exactly OK. Do not run any tools or commands.",
  model: "gpt-6-luna", reasoningEffort: "none", sandbox: "read-only", timeoutMs: 90000,
});
const evidence = runner.getEvidence(operationId);
const ready = events.listPending("devspace-codex-reliability-001").pending_count;
const native = {
  operationId, model: "gpt-6-luna", reasoningEffort: "none", elapsedMs: status.elapsedMs,
  state: status.state, exitCode: status.exitCode, threadId: status.threadId,
  eventTypes: evidence?.eventTypes, executionCompleted: status.executionCompleted,
  evidenceState: status.evidenceState, reviewState: status.reviewState,
  evidenceSha256: status.evidenceSha256, readyForGptReviewCount: ready,
  errorEventCount: status.errorEventCount ?? 0, lastErrorCategory: status.lastErrorCategory,
  failureStage: status.failureStage,
};
process.stdout.write(JSON.stringify(native) + "\n");
assert.equal(status.state, "COMPLETED");
assert.equal(status.exitCode, 0);
assert.ok(evidence?.eventTypes.includes("thread.started"));
assert.ok(evidence?.eventTypes.includes("turn.started"));
assert.ok(evidence?.eventTypes.includes("turn.completed"));
assert.equal(status.executionCompleted, true);
assert.equal(status.evidenceState, "VERIFIED");
assert.equal(status.reviewState, "READY_FOR_GPT_REVIEW");
assert.equal(ready, 1);
await runner.close();
events.close();

process.stdout.write(JSON.stringify({ directRuns: direct.length, directPasses: direct.filter((r) => r.passed).length,
  nativePassed: true, evidenceDatabase: join(stateDir, "coach-review-events.sqlite") }) + "\n");
