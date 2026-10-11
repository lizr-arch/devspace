import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync,mkdtempSync, readFileSync,rmSync,writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { DevSpaceInstanceLock } from "./devspace-instance-lock.js";

const wait=async(check:()=>boolean,ms=7000)=>{
 const until=Date.now()+ms;
 while(Date.now()<until){if(check())return;await new Promise(r=>setTimeout(r,50));}
 throw new Error("COACH_RELEASE_INSTANCE_WAIT_TIMEOUT");
};
if(process.argv[2]==="--lock-owner-child"){
 const state=process.argv[3],ready=process.argv[4];
 const lease=new DevSpaceInstanceLock(state);
 writeFileSync(ready,JSON.stringify({pid:process.pid}));
 // Keep the owned SQLite connection strongly reachable for the lifetime
 // of the child process; otherwise GC may finalize it before SIGKILL.
 setInterval(()=>{assert.ok(lease.path)},200);
}else{
 const root=mkdtempSync(join(tmpdir(),"coach-release-lock-"));
 const state=join(root,"state");
 let child:ReturnType<typeof spawn>|undefined;
 try {
  const one=new DevSpaceInstanceLock(state);
  assert.throws(()=>new DevSpaceInstanceLock(state),/DEVSPACE_INSTANCE_ALREADY_RUNNING/);
  one.release();one.release();
  const resumed=new DevSpaceInstanceLock(state);
  resumed.release();
  // A real child holding the native SQLite file must block this process.
  const ready=join(root,"child-ready.json");
  // Run the TS child directly in the exact OS process that holds SQLite.
  // Launching the tsx CLI adds a wrapper PID and can leave an unobserved
  // worker running after its wrapper exits, making the SIGKILL test flaky.
  child=spawn(process.execPath,["--import","tsx",fileURLToPath(import.meta.url),
    "--lock-owner-child",state,ready],{
   cwd:dirname(fileURLToPath(import.meta.url)),
   stdio:["ignore","pipe","pipe"],env:{...process.env},
  });
  assert.ok(child.pid);
  await wait(()=>existsSync(ready));
  const ownerPid=JSON.parse(readFileSync(ready,"utf8")).pid as number;
  assert.ok(Number.isSafeInteger(ownerPid) && ownerPid>1);
  assert.equal(ownerPid,child.pid,"the lock holder must be our direct child");
  assert.throws(()=>new DevSpaceInstanceLock(state),/DEVSPACE_INSTANCE_ALREADY_RUNNING/);
  // ChildProcess PID identity is proven by the ready handshake. No broad
  // process searches, and no signaling any process outside the fixture.
  child.kill("SIGKILL");
  await new Promise<void>(resolve=>child!.once("close",()=>resolve()));
  const afterKill=new DevSpaceInstanceLock(state);
  afterKill.release();

  // The ACTUAL DevSpace factory locks before any native event reconciliation.
  const config=loadConfig({
    DEVSPACE_CONFIG_DIR:join(root,"config"),
    DEVSPACE_ALLOWED_ROOTS:root,
    DEVSPACE_OAUTH_OWNER_TOKEN:"devspace-release-lock-simulation-token-long-enough",
    DEVSPACE_PUBLIC_BASE_URL:"https://devspace.example.com",
    DEVSPACE_STATE_DIR:state,
    DEVSPACE_WORKTREE_ROOT:join(root,"worktrees"),
    DEVSPACE_LOG_LEVEL:"silent",
    DEVSPACE_WIDGETS:"off",
  });
  const server=createServer(config);
  try{
    const journal=server.ctx.coachReviewEvents;
    journal.claimAgentRun({workspaceId:"lock-test",operationId:"active-codex",
      requestSha256:"a".repeat(64)});
    // The second server MUST fail before RUNNING -> INTERRUPTED reconciliation.
    assert.throws(()=>createServer(config),/DEVSPACE_INSTANCE_ALREADY_RUNNING/);
    assert.equal(journal.getAgentRun("lock-test","active-codex")?.state,"RUNNING");
    // It cannot bypass the lock by holding a second independent lease.
    assert.throws(()=>new DevSpaceInstanceLock(state),/DEVSPACE_INSTANCE_ALREADY_RUNNING/);
  }finally{await server.close();}
  // After orderly shutdown the lease is released and old RUNNING is now
  // conservatively reconciled to INTERRUPTED, not silently restarted.
  const restarted=createServer(config);
  try{
    assert.equal(restarted.ctx.coachReviewEvents.getAgentRun(
      "lock-test","active-codex")?.state,"INTERRUPTED");
  }finally{await restarted.close();}
  console.log("COACH006_RELEASE_INSTANCE_EXCLUSIVE_DUAL_SERVER_SIGKILL_RECOVERY_PASS");
 }finally{
  if(child && child.exitCode===null && child.signalCode===null)
    try{child.kill("SIGKILL")}catch{}
  rmSync(root,{recursive:true,force:true});
 }
}
