import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CoachReviewEventStore } from "./coach-review-events.js";
import {
 createGuardianMarker,readGuardianIdentity,assessGuardian,guardedClearQuarantine,
} from "./coach-agent-guardian.js";

assert.equal(process.platform,"darwin");
const dir=mkdtempSync(join(tmpdir(),"coach-guard-identity-"));
const started=join(dir,"leader-started"),grandchild=join(dir,"grandchild-finished");
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const marker=createGuardianMarker();
const childScript="setTimeout(()=>require('node:fs').writeFileSync("+JSON.stringify(grandchild)+",'finished'),1750);setTimeout(()=>process.exit(0),1850)";
const script=[
'const cp=require("node:child_process"),fs=require("node:fs");',
'cp.spawn(process.execPath,["-e",'+JSON.stringify(childScript)+'],{stdio:"ignore",detached:false});',
'fs.writeFileSync('+JSON.stringify(started)+',"started");',
'setTimeout(()=>process.exit(0),850);',
].join("");
const leader=spawn(process.execPath,["-e",script,"--",marker,dir],{
 detached:true,cwd:dir,stdio:"ignore",
});
const state=join(dir,"state");
let db:CoachReviewEventStore|undefined;
try{
 assert.ok(leader.pid);
 let id:NonNullable<ReturnType<typeof readGuardianIdentity>>|undefined;
 for(let i=0;i<90;i++){
  id=readGuardianIdentity(leader.pid!,marker);
  if(id&&existsSync(started))break;
  await sleep(25);
 }
 assert.ok(id,"test guardian identity not obtained");
 assert.equal(id.pgid,leader.pid);
 assert.equal(assessGuardian(id).kind,"alive");
 assert.equal(guardedClearQuarantine(id).cleared,false,"running guardian must block clearance");
 const badMarker={...id,marker:createGuardianMarker()};
 assert.equal(guardedClearQuarantine(badMarker).cleared,false);
 const oldBirth={...id,lstart:id.lstart.replace(/\d{4}$/,"2001")};
 assert.equal(guardedClearQuarantine(oldBirth).cleared,false);
 const wrongPgid={...id,pgid:id.pgid+1};
 assert.equal(guardedClearQuarantine(wrongPgid).cleared,false);
 db=new CoachReviewEventStore(state);
 const currentDb=db;
 currentDb.claimAgentRun({workspaceId:"identity-ws",operationId:"single-attach",requestSha256:"a".repeat(64)});
 currentDb.recordGuardian({workspaceId:"identity-ws",operationId:"single-attach",identity:id});
 assert.throws(()=>currentDb.recordGuardian({workspaceId:"identity-ws",operationId:"single-attach",identity:id}),
  /ALREADY_RECORDED/);
 assert.throws(()=>currentDb.recordGuardian({workspaceId:"identity-ws",operationId:"no-record",identity:badMarker}),
  /INVALID|NOT_RUNNING/);
 // Leader terminates while a process with its original PGID still lives.
 await new Promise<void>(resolve=>leader.once("exit",()=>resolve()));
 let seen=assessGuardian(id);
 if(seen.kind!=="unknown"){await sleep(75);seen=assessGuardian(id);}
 assert.equal(seen.kind,"unknown","orphan members must not be classified as cleared");
 assert.equal(guardedClearQuarantine(id).cleared,false);
 await sleep(1700);
 assert.equal(existsSync(grandchild),true,"test grandchild fixture never ran");
 let settled=assessGuardian(id);
 for(let i=0;i<25&&settled.kind!=="gone";i++){await sleep(70);settled=assessGuardian(id);}
 assert.equal(settled.kind,"gone","group must be gone after descendant exits");
 assert.equal(guardedClearQuarantine(id).cleared,true);
 db.close();db=undefined;

 // Migration test: a real v3 database has an existing coach_agent_runs table
 // WITHOUT any guardian columns. Opening v4 must ALTER, not silently skip.
 const legacy=join(dir,"v3");mkdirSync(legacy);
 const sqlite=new Database(join(legacy,"coach-review-events.sqlite"));
 sqlite.exec("CREATE TABLE coach_agent_runs (workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_sha256 TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, thread_id TEXT, event_id INTEGER, reason TEXT, PRIMARY KEY(workspace_id,operation_id));");
 sqlite.prepare("INSERT INTO coach_agent_runs (workspace_id,operation_id,request_sha256,state,started_at) VALUES (?,?,?,?,?)")
   .run("legacy","prior-operation","f".repeat(64),"INTERRUPTED",new Date().toISOString());
 sqlite.pragma("user_version = 3");sqlite.close();
 const migrated=new CoachReviewEventStore(legacy);
 try{
  assert.equal(migrated.getAgentRun("legacy","prior-operation")?.state,"INTERRUPTED");
  assert.equal(migrated.hasInterruptedRun("legacy"),true);
  assert.equal(migrated.getGuardian("legacy","prior-operation"),undefined);
  const db2=new Database(migrated.path,{readonly:true});
  try{
   const cols=new Set((db2.pragma("table_info(coach_agent_runs)") as
     {name:string}[]).map(x=>x.name));
   for(const col of ["guardian_marker","guardian_pid","guardian_pgid","guardian_uid","guardian_lstart"])
    assert.ok(cols.has(col),"migration forgot "+col);
   assert.equal(db2.pragma("user_version",{simple:true}),4);
  }finally{db2.close();}
  // v3 CHECK did not know CLEARED. The migration must actually allow
  // an audited terminal clearance; adding columns alone is insufficient.
  const cleared=migrated.clearInterruptedRun({workspaceId:"legacy",
    operationId:"prior-operation",explanation:"schema migration negative test only"});
  assert.equal(cleared.state,"CLEARED");
  assert.equal(migrated.hasInterruptedRun("legacy"),false);
 }finally{migrated.close();}
 console.log("COACH006B3_OS_PID_REUSE_ORPHAN_GROUP_AND_V3_MIGRATION_NEGATIVE_PASS");
}finally{
 if(leader.pid && readGuardianIdentity(leader.pid,marker)){
  try{process.kill(-leader.pid,"SIGKILL")}catch{}
 }
 db?.close();
 rmSync(dir,{recursive:true,force:true});
}
