import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import { sha256 } from "./coach-task-contract.js";

const root=mkdtempSync(join(tmpdir(),"coach-status-routing-"));
const store=new CoachReviewEventStore(root),db=new Database(store.path);
const sidecar=new ManagedCoachSidecar(undefined,store.path),token=Buffer.alloc(32,9);
const entry={workspaceId:"owner",authorizedWorkspaceIds:["owner","other"],port:12345,token,database:db};
function feed(url="/events",bearer=token.toString("base64url")){
  let status=0,body="";
  (sidecar as any).handle(entry,{headers:{host:"127.0.0.1:12345",authorization:"Bearer "+bearer},method:"GET",url},
    {setHeader:()=>{},writeHead:(code:number)=>{status=code;},end:(text:string)=>{body=text;}});
  return {status,...JSON.parse(body)};
}
function complete(op:string,report?:unknown,task:unknown={taskId:"test"},workspaceId="owner"){
  const base={workspaceId,operationId:op,task,...(report===undefined?{}:{report}),sourceDiff:""};
  const evidenceSha256=sha256(JSON.stringify(base));
  return store.recordCompletedWithEvidence({workspaceId,operationId:op,evidenceSha256,packetJson:JSON.stringify({...base,evidenceSha256})});
}
const outcome=(status:string)=>({schema:"DEVSPACE_CODEX_REPORT_CHECK_V1",valid:true,status,code:"REPORT_VALID_UNVERIFIED_CLAIMS",reportSha256:"a".repeat(64),testsIndependentlyVerified:false});
try{
  // Filtering must happen BEFORE the 50-row cap and pending_count calculation.
  for(let i=0;i<55;i++)complete("progress-"+i,outcome("IN_PROGRESS"));
  complete("invalid",{...outcome("READY_FOR_REVIEW"),valid:false});
  complete("missing-digest",{...outcome("READY_FOR_REVIEW"),reportSha256:undefined});
  complete("bad-schema",{...outcome("READY_FOR_REVIEW"),schema:"invalid"});
  complete("bad-code",{...outcome("READY_FOR_REVIEW"),code:"REPORT_INVALID"});
  complete("bad-type",{...outcome("READY_FOR_REVIEW"),valid:1});
  complete("missing");complete("blocked",outcome("BLOCKED"));
  const ready=complete("ready",outcome("READY_FOR_REVIEW"));
  complete("conflict",outcome("PLAN_CONFLICT"));
  complete("other-conflict",outcome("PLAN_CONFLICT"),{taskId:"other"},"other");
  const legacyBase={workspaceId:"owner",operationId:"historical",sourceDiff:""};
  const legacySha=sha256(JSON.stringify(legacyBase));
  const historical=store.recordCompletedWithEvidence({workspaceId:"owner",operationId:"historical",evidenceSha256:legacySha,packetJson:JSON.stringify({...legacyBase,evidenceSha256:legacySha})});
  assert.equal(store.listPending("owner").pending_count,3);
  const selected=feed("/events?workspaceId=owner");
  assert.equal(selected.status,200);assert.equal(selected.pending_count,3);
  assert.deepEqual(selected.events.map((e:any)=>[e.operation_id,e.event_type]),[
    ["ready","READY_FOR_GPT_REVIEW"],["conflict","PLAN_CONFLICT"],["historical","READY_FOR_GPT_REVIEW"]]);
  assert.equal(feed().pending_count,4);assert.equal(feed("/events?workspaceId=other").events[0].workspace_id,"other");
  assert.equal(feed("/events?workspaceId=unauthorized").status,403);assert.equal(feed("/events","invalid").status,401);
  assert.equal(feed("/events?workspaceId=owner&workspaceId=other").status,400);
  assert.doesNotMatch(JSON.stringify(selected),/progress-|missing|invalid|blocked|other-conflict/);
  // Existing exact-event signed receipt and historical review semantics survive.
  store.submitReview({workspaceId:"owner",eventId:historical.event_id,decision:"APPROVED",evidenceSha256:legacySha});
  assert.equal(feed("/events?workspaceId=owner").pending_count,2);
  assert.equal(store.getReview("owner","historical")?.decision,"APPROVED");
  const oldPacket=db.prepare("SELECT packet_json FROM coach_review_evidence WHERE event_id=?").get(ready.event_id) as {packet_json:string};
  db.prepare("UPDATE coach_review_evidence SET packet_json=? WHERE event_id=?").run(oldPacket.packet_json.replace('"sourceDiff":""','"sourceDiff":"tampered"'),ready.event_id);
  assert.equal(feed().status,503);assert.throws(()=>store.listPending("owner"),/INTEGRITY/);
  console.log("COACH_R1_HANDLER_STATUS_PAGINATION_OWNER_AUTH_HISTORY_INTEGRITY_NEGATIVES_PASS");
}finally{db.close();store.close();rmSync(root,{recursive:true,force:true});}
