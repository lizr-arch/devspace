import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import {
 GUARDIAN_SOURCE, createGuardianMarker, readGuardianIdentity, assessGuardian, guardedClearQuarantine,
} from "./coach-agent-guardian.js";
import { registerCodexAgentTools } from "./server/tools-codex-agent.js";
import { setToolQuarantineGuard } from "./server/server-helpers.js";
import type { ServerContext } from "./server/server-types.js";

const root=mkdtempSync(join(tmpdir(),"coach-guardian-real-crash-"));
const space=join(root,"workspace");mkdirSync(space);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(fn:()=>boolean,limit=5000)=>{
 const until=Date.now()+limit;
 while(Date.now()<until){if(fn())return;await sleep(35);}
 throw new Error("COACH_OS_FIXTURE_TIMED_OUT");
};
const marker=createGuardianMarker();
const identityFile=join(space,"guardian-owner.json"),started=join(space,"fake-started.txt");
const delayed=join(space,"UNSAFE_SURVIVOR_WRITE.txt"),unrelatedFile=join(root,"unrelated-survived.txt");
const fake=join(root,"fake-codex.cjs"),harness=join(root,"harness.cjs");
writeFileSync(fake,[
  'const cp=require("node:child_process"),fs=require("node:fs");',
  'const root=process.argv[2];',
  'fs.writeFileSync(require("node:path").join(root,"fake-started.txt"),"started");',
  'const delayed=require("node:path").join(root,"UNSAFE_SURVIVOR_WRITE.txt");',
  'cp.spawn(process.execPath,["-e",',
  ' "setTimeout(()=>require(\\\"node:fs\\\").writeFileSync("+JSON.stringify(delayed)+",\\\"UNSAFE\\\"),1500);setTimeout(()=>process.exit(0),2900)"],',
  ' {stdio:"ignore",detached:false});',
  'setInterval(()=>{},300);',
].join("\n"),{mode:0o700});
chmodSync(fake,0o700);
writeFileSync(harness,[
 'const cp=require("node:child_process"),fs=require("node:fs"),path=require("node:path");',
 'const root=process.argv[2],source=process.argv[3],marker=process.argv[4],fake=process.argv[5];',
 'const g=cp.spawn(process.execPath,["-e",source,"--",marker,fake,root],',
 ' {cwd:root,detached:true,stdio:["pipe","pipe","pipe","pipe"]});',
 'g.stdin.end("test-prompt");',
 'fs.writeFileSync(path.join(root,"guardian-owner.json"),JSON.stringify({pid:g.pid,marker}));',
 'setInterval(()=>{},300);',
].join("\n"),{mode:0o700});
chmodSync(harness,0o700);
let owner:ReturnType<typeof spawn>|undefined;
let unrelated:ReturnType<typeof spawn>|undefined;
let guardianIdentity:NonNullable<ReturnType<typeof readGuardianIdentity>>|undefined;
let store:CoachReviewEventStore|undefined;
try {
 assert.equal(process.platform,"darwin","Darwin-only parent SIGKILL safety test");
 // This independent process is NOT in the guardian's group. It must survive.
 unrelated=spawn(process.execPath,["-e",
  "setTimeout(()=>require('node:fs').writeFileSync("+JSON.stringify(unrelatedFile)+",'OK'),1000)"],{
  cwd:tmpdir(),detached:true,stdio:"ignore",
 });
 owner=spawn(process.execPath,[harness,space,GUARDIAN_SOURCE,marker,fake],{
  cwd:tmpdir(),stdio:"ignore",
 });
 assert.ok(owner.pid && owner.pid!==process.pid);
 await wait(()=>existsSync(identityFile));
 const ownerData=JSON.parse(readFileSync(identityFile,"utf8")) as {pid:number;marker:string};
 assert.equal(ownerData.marker,marker);
 await wait(()=>existsSync(started));
 for(let i=0;i<40;i++){
  guardianIdentity=readGuardianIdentity(ownerData.pid,marker);
  if(guardianIdentity)break;
  await sleep(35);
 }
 assert.ok(guardianIdentity,"guardian identity must match Darwin PID/PGID/UID/birth/marker");
 assert.equal(assessGuardian(guardianIdentity).kind,"alive");
 assert.equal(guardedClearQuarantine(guardianIdentity).cleared,false,
   "live guardian identity must block all clearance");
 assert.equal(assessGuardian({...guardianIdentity,lstart:"Sun Oct 11 01:01:01 1980"}).kind,"unknown",
   "PID reuse or process birth time mismatch must fail closed");
 assert.equal(assessGuardian({...guardianIdentity,marker:createGuardianMarker()}).kind,"unknown",
   "wrong guardian marker must fail closed");
 // KILL ONLY the parent process represented by this test's ChildProcess.
 // Never signal an arbitrary PID from the machine's process list.
 process.kill(owner.pid!,"SIGKILL");
 await sleep(1900);
 assert.equal(existsSync(delayed),false,
  "guardian failed to kill descendant after its parent's SIGKILL");
 assert.equal(existsSync(unrelatedFile),true,
  "guardian damaged an unrelated detached process");
 const status=assessGuardian(guardianIdentity);
 assert.equal(status.kind,"gone","guardian/descendant group must be absent: "+JSON.stringify(status));

 store=new CoachReviewEventStore(join(root,"state"));
 store.claimAgentRun({workspaceId:"os-scratch",operationId:"crashed-agent",
  requestSha256:"a".repeat(64)});
 store.recordGuardian({workspaceId:"os-scratch",operationId:"crashed-agent",
  identity:guardianIdentity});
 store.close();
 store=new CoachReviewEventStore(join(root,"state"));
 assert.deepEqual(store.reconcileInterruptedRuns(),{interrupted:1,completed:0});
 assert.equal(store.hasInterruptedRun("os-scratch"),true);
 const ctx={config:{readOnly:false},coachReviewEvents:store,
  workspaces:{
   getWorkspace:(id:string)=>{
    if(id!=="os-scratch")throw new Error("NOT_AUTHORIZED");
    return {root:space};
   },liveLeases:()=>1,
  },
  jobs:{activeJobIdsForRoot:()=>[]},tasks:{listSessions:()=>[]},
  getNativeCodexRunner:()=>{throw new Error("UNEXPECTED_RUNNER");},
 } as unknown as ServerContext;
 const srv=new McpServer({name:"b3os-isolated-mcp",version:"1.0"});
 registerCodexAgentTools(srv,ctx);
 const cli=new Client({name:"b3os-test-client",version:"1.0"});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await srv.connect(b);await cli.connect(a);
 setToolQuarantineGuard((id)=>store!.hasInterruptedRun(id));
 try {
  const statusResult=await cli.callTool({name:"codex_agent_quarantine_status",
   arguments:{workspaceId:"os-scratch"}});
  assert.equal(statusResult.isError??false,false);
  assert.equal((statusResult.structuredContent as Record<string,unknown>|undefined)?.quarantined,true);
  const invalid=await cli.callTool({name:"codex_agent_clear_quarantine",
   arguments:{workspaceId:"not-authorized",operationId:"crashed-agent",explanation:"invalid"}});
  assert.equal(invalid.isError,true);
  const approved=await cli.callTool({name:"codex_agent_clear_quarantine",
   arguments:{workspaceId:"os-scratch",operationId:"crashed-agent",
    explanation:"isolated parent SIGKILL; trusted guardian ID; no group members; no foreign occupancy"}});
  assert.equal(approved.isError??false,false,JSON.stringify(approved));
  assert.equal(store.hasInterruptedRun("os-scratch"),false);
  assert.equal(store.getAgentRun("os-scratch","crashed-agent")?.state,"CLEARED");
  const repeated=await cli.callTool({name:"codex_agent_clear_quarantine",
   arguments:{workspaceId:"os-scratch",operationId:"crashed-agent",explanation:"repeat"}});
  assert.equal(repeated.isError,true,"clearance repeated silently");
  assert.throws(()=>store!.claimAgentRun({workspaceId:"os-scratch",
    operationId:"crashed-agent",requestSha256:"a".repeat(64)}),/NO_REPLAY/);
 }finally {
  setToolQuarantineGuard(undefined);
  await cli.close();await srv.close();
 }
 console.log("COACH006B3_OS_REAL_PARENT_SIGKILL_GUARDIAN_NO_ORPHAN_MCP_CLEAR_PASS");
}finally {
 if(owner?.pid && owner.exitCode===null){try{owner.kill("SIGKILL")}catch{}}
 if(unrelated?.pid && unrelated.exitCode===null){try{unrelated.kill("SIGTERM")}catch{}}
 // Emergency cleanup is allowed ONLY for the actual test guardian with
 // verified original identity, never any system-wide PID or process group.
 if(guardianIdentity && assessGuardian(guardianIdentity).kind==="alive"){
  try{process.kill(-guardianIdentity.pgid,"SIGKILL")}catch{}
 }
 store?.close();
 rmSync(root,{recursive:true,force:true});
}
