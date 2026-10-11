import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { NativeCodexAgentRunner } from "./codex-agent-runner.js";
import { TaskRunner } from "./task-runner.js";
import { computeManifestSha256 } from "./task-manifest.js";
import { registerCodexAgentTools } from "./server/tools-codex-agent.js";
import { registerCodexReviewTools } from "./server/tools-codex-review.js";
import type { ServerContext } from "./server/server-types.js";

const tmp=mkdtempSync(join(tmpdir(),"coach-five-cycles-"));
const workspace=join(tmp,"workspace"),state=join(tmp,"state"),fake=join(tmp,"fake-codex.cjs");
mkdirSync(join(workspace,".devspace"),{recursive:true});
writeFileSync(join(workspace,".devspace","tasks.yaml"),[
 "version: 1", "tasks:", "  verify:", "    mode: run",
 "    runtime: system", "    timeout_seconds: 20",
 "    command: "+JSON.stringify([process.execPath,"-e","process.stdout.write('UNIT_TESTS_PASS')"]),
].join("\n")+"\n");
const manifestHash=computeManifestSha256(workspace)!;
writeFileSync(fake,[
 'let prompt="";',
 'process.stdin.on("data",c=>prompt+=c);',
 'process.stdin.on("end",()=>{',
 ' require("node:fs").writeFileSync("main.ts","export const phase = "+JSON.stringify(prompt.trim())+";\\n");',
 ' const u="11111111-1111-4111-8111-111111111111";',
 ' process.stdout.write(JSON.stringify({type:"thread.started",thread_id:u})+"\\n");',
 ' process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:7,output_tokens:2}})+"\\n");',
 '});',
].join("\n"),{mode:0o700});
chmodSync(fake,0o700);
const store=new CoachReviewEventStore(state);
const runner=new NativeCodexAgentRunner({
 events:store,nodePath:"/Users/liz/.local/bin/node",codexPath:fake,
 locks:new JobResourceLocks(),spawn:(file,args,options)=>spawn(file,args,options),
});
const tasks=new TaskRunner();
const ctx={config:{readOnly:false},coachReviewEvents:store,tasks,
 getNativeCodexRunner:()=>runner,
 workspaces:{getWorkspace(id:string){
  if(id!=="authorized")throw new Error("WORKSPACE_NOT_AUTHORIZED");
  return {root:workspace,approvedTasks:{manifestSha256:manifestHash,taskIds:["verify"]}};
 }}} as unknown as ServerContext;
const server=new McpServer({name:"five-cycles",version:"1.0"});
registerCodexAgentTools(server,ctx);
registerCodexReviewTools(server,ctx);
const client=new Client({name:"five-cycle-client",version:"1.0"});
const [a,b]=InMemoryTransport.createLinkedPair();
await server.connect(b);await client.connect(a);
async function call(name:string,args:Record<string,unknown>){
 const r=await client.callTool({name,arguments:args});
 assert.equal(r.isError??false,false,name+": "+JSON.stringify(r));
 return r;
}
async function completion(operationId:string){
 for(let i=0;i<150;i++){
  const s=runner.status(operationId);
  if(s.state!=="RUNNING")return s;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw new Error("FIVE_CYCLE_TIMEOUT");
}
const actions=["REWORK","APPROVED","REWORK","APPROVED","APPROVED"] as const;
const results:{operationId:string;decision:string;threadId?:string;eventId?:number}[]=[];
try {
 for(let i=0;i<5;i++){
  const n=i+1,operationId="stage-"+n,prompt="review-cycle-"+n;
  const base={workspaceId:"authorized",operationId,prompt,
   reasoningEffort:"none",sandbox:"workspace-write"} as const;
  if(n===2 || n===4){
   await call("codex_agent_start_rework",{...base,parentOperationId:n===2?"stage-1":"stage-3"});
  }else{
   await call("codex_agent_start",{...base,model:"gpt-5.6-luna"});
  }
  const completed=await completion(operationId);
  assert.equal(completed.state,"COMPLETED",JSON.stringify(completed));
  assert.equal(completed.threadId,"11111111-1111-4111-8111-111111111111");
  assert.equal(store.listPending("authorized").pending_count,1,
    "exactly current event must be awaiting review");
  const packet=store.getEvidence("authorized",operationId) as {evidenceSha256:string;sourceDiff:string;
    finalFingerprint:string;invocation:{parentOperationId?:string}};
  assert.ok(packet.sourceDiff.includes("review-cycle-"+n));
  if(n===2 || n===4){
   assert.equal(packet.invocation.parentOperationId,n===2?"stage-1":"stage-3");
  }
  if(actions[i]==="APPROVED"){
   await call("codex_agent_verify_test",{workspaceId:"authorized",eventId:completed.eventId,taskId:"verify"});
   assert.equal(store.getVerifiedTest(completed.eventId!)?.task_id,"verify");
  }else {
   assert.equal(store.getVerifiedTest(completed.eventId!),undefined);
  }
  await call("codex_agent_submit_review",{workspaceId:"authorized",operationId,
   eventId:completed.eventId,decision:actions[i],evidenceSha256:packet.evidenceSha256});
  assert.equal(store.getReview("authorized",operationId)?.decision,actions[i]);
  assert.equal(store.listPending("authorized").pending_count,0);
  // A repeated start must resolve to the original result, never spawn another
  // task or emit another event.
  const dup=runner.status(operationId);
  assert.equal(dup.eventId,completed.eventId);
  results.push({operationId,decision:actions[i],threadId:completed.threadId,eventId:completed.eventId});
 }
 await runner.close();
 const old=store.getAgentRun("authorized","stage-5");
 assert.equal(old?.state,"COMPLETED");
 const reloaded=new CoachReviewEventStore(state);
 try {
   assert.deepEqual(reloaded.reconcileInterruptedRuns(),{interrupted:0,completed:0});
   for(const row of results){
     assert.equal(reloaded.getReview("authorized",row.operationId)?.decision,row.decision);
     assert.equal(reloaded.getAgentRun("authorized",row.operationId)?.state,"COMPLETED");
     assert.ok(reloaded.getEvidence("authorized",row.operationId));
   }
   assert.equal(reloaded.listPending("authorized").pending_count,0);
 } finally {reloaded.close();}
 console.log(JSON.stringify({gate:"COACH006_B2_B3_FIVE_CYCLE_RUNNER_MCP_PASS",
   cycles:results.length,reworks:results.filter(x=>x.decision==="REWORK").length,
   approvals:results.filter(x=>x.decision==="APPROVED").length,
   sameThread:results.every(x=>x.threadId===results[0].threadId),
   pending:0,modelCalls:0}));
} finally {
 await runner.close();await client.close();await server.close();store.close();
 rmSync(tmp,{force:true,recursive:true});
}
