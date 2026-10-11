import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskRunner } from "./task-runner.js";
import { InMemorySecretResolver } from "./secret-resolver.js";
const root = mkdtempSync(join(tmpdir(), "coach006a3-secrets-"));
const sentinel = "COACH_A3_PRIVATE_TEST_SECRET_B3f963d";
const cmd = JSON.stringify([process.execPath, "-e", "process.stdout.write(process.env.API_SECRET);process.stderr.write(process.env.API_SECRET)"]);
const stopped = JSON.stringify([process.execPath, "-e", "process.stdout.write(process.env.API_SECRET);setInterval(()=>{},500)"]);
const manifest = [
  "version: 1", "tasks:", "  quick-secret:", "    mode: session", "    runtime: system", "    timeout_seconds: 30",
  "    command: " + cmd, "    secrets:", "      - secret_ref: test-secret", "        target_env: API_SECRET",
  "  stopped-secret:", "    mode: session", "    runtime: system", "    timeout_seconds: 30",
  "    command: " + stopped, "    secrets:", "      - secret_ref: test-secret", "        target_env: API_SECRET",
].join("\n")+"\n";
mkdirSync(join(root, ".devspace"), {recursive:true});
writeFileSync(join(root, ".devspace", "tasks.yaml"), manifest);
const runner = new TaskRunner();
const resolver = new InMemorySecretResolver();
resolver.set("test-secret", sentinel);
runner.setSecretResolver(resolver);
const invoke = async (taskId: string) => {
 const res = await runner.runTask({workspaceId:"ws-secret",workspaceRoot:root,taskId,params:{},additionalRoots:[]});
 assert.equal(res.mode,"session");
 return res.sessionId;
};
const noLeak=(id:string)=>{
 const v=runner.getSession(id);
 assert.ok(v);
 assert.ok(!v.stdout.includes(sentinel), "getSession stdout leaked");
 assert.ok(!v.stderr.includes(sentinel), "getSession stderr leaked");
 const sessions=runner.listSessions("ws-secret",20);
 assert.ok(sessions.every(s=>!s.stdout.includes(sentinel)&&!s.stderr.includes(sentinel)));
 return v;
};
try {
 const id=await invoke("quick-secret");
 const done=await runner.waitSession(id,3000);
 assert.ok(done && done.status!=="running");
 const final=noLeak(id);
 assert.equal(final.status,"succeeded");
 assert.match(final.stdout,/REDACTED/);
 assert.match(final.stderr,/REDACTED/);
 const id2=await invoke("stopped-secret");
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(runner.stopSession(id2),true);
 const afterStop=await runner.waitSession(id2,3000);
 assert.ok(afterStop && afterStop.status!=="running");
 await new Promise(resolve=>setTimeout(resolve,100));
 noLeak(id2);
 console.log("COACH006A3_SESSION_SECRET_AFTER_EXIT_AND_STOP_PASS");
} finally { rmSync(root,{recursive:true,force:true}); }
