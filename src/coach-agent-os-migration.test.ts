import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { assessGuardian, guardedClearQuarantine,createGuardianMarker } from "./coach-agent-guardian.js";

const root=mkdtempSync(join(tmpdir(),"coach-b3-v3-migrate-"));
try{
 const dbDir=join(root,"state");
 mkdirSync(dbDir);
 const path=join(dbDir,"coach-review-events.sqlite");
 let old=new Database(path);
 try{
  old.exec("CREATE TABLE coach_agent_runs ("+
   "workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,"+
   "state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETED','FAILED','STOPPED','INTERRUPTED')),"+
   "started_at TEXT NOT NULL,finished_at TEXT,thread_id TEXT,event_id INTEGER,reason TEXT,"+
   "PRIMARY KEY(workspace_id,operation_id));");
  old.prepare("INSERT INTO coach_agent_runs "+
   "(workspace_id,operation_id,request_sha256,state,started_at,reason) VALUES (?,?,?,?,?,?)")
   .run("safe-ws","legacy-interrupted","a".repeat(64),"INTERRUPTED",
    "2026-10-11T00:00:00Z","legacy_crash");
  old.prepare("INSERT INTO coach_agent_runs "+
   "(workspace_id,operation_id,request_sha256,state,started_at,reason) VALUES (?,?,?,?,?,?)")
   .run("safe-ws","legacy-finished","b".repeat(64),"FAILED",
    "2026-10-11T00:00:01Z","legacy_failure");
  old.pragma("user_version = 3");
 } finally {old.close();}
 const store=new CoachReviewEventStore(dbDir);
 try{
  const fields=store.getAgentRun("safe-ws","legacy-interrupted");
  assert.equal(fields?.state,"INTERRUPTED");
  assert.equal(fields?.reason,"legacy_crash");
  assert.equal(store.getAgentRun("safe-ws","legacy-finished")?.state,"FAILED");
  assert.equal(store.hasInterruptedRun("safe-ws"),true);
  assert.equal(store.getGuardian("safe-ws","legacy-interrupted"),undefined,
   "old unidentifiable run must fail closed");
  // A v3 row without guardian metadata cannot be cleared by the authorized
  // MCP endpoint; this direct storage call tests the v4 SQLite CHECK migration.
  const cleared=store.clearInterruptedRun({workspaceId:"safe-ws",
   operationId:"legacy-interrupted",explanation:"fixture-only schema migration probe"});
  assert.equal(cleared.state,"CLEARED");
  assert.equal(store.hasInterruptedRun("safe-ws"),false);
  assert.throws(()=>store.claimAgentRun({workspaceId:"safe-ws",
   operationId:"legacy-interrupted",requestSha256:"a".repeat(64)}),/NO_REPLAY/);
  assert.throws(()=>store.clearInterruptedRun({workspaceId:"safe-ws",
   operationId:"legacy-interrupted",explanation:"duplicate"}),/NOT_CLEARABLE/);
 } finally{store.close();}
 const reopened=new Database(path,{readonly:true});
 try{
  assert.equal(reopened.pragma("user_version",{simple:true}),5);
  const row=reopened.prepare("SELECT state,guardian_marker FROM coach_agent_runs "+
   "WHERE workspace_id='safe-ws' AND operation_id='legacy-interrupted'").get() as
   {state:string;guardian_marker:string|null};
  assert.equal(row.state,"CLEARED");
  assert.equal(row.guardian_marker,null);
  const audit=reopened.prepare("SELECT count(*) AS n FROM coach_agent_quarantine_audit").get() as {n:number};
  assert.equal(audit.n,1);
 }finally{reopened.close();}

 const marker=createGuardianMarker();
 const impossible={
  marker,pid:128497329,pgid:128497329,uid:process.getuid!(),
  lstart:"Sun Oct 11 22:47:01 2026",
 };
 assert.equal(assessGuardian({...impossible,marker:"invented"}).kind,"unknown");
 assert.equal(assessGuardian({...impossible,pgid:1}).kind,"unknown");
 assert.equal(guardedClearQuarantine({...impossible,marker:"invented"}).cleared,false);
 console.log("COACH006B3_V3_TO_V4_MIGRATION_AND_INVALID_GUARDIAN_PASS");
}finally{rmSync(root,{recursive:true,force:true});}
