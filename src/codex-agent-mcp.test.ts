import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner } from "./codex-agent-runner.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { registerCodexAgentTools } from "./server/tools-codex-agent.js";
import type { ServerContext } from "./server/server-types.js";

const root=mkdtempSync(join(tmpdir(),"coach-b1-mcp-"));
const workspace=join(root,"workspace");
const fs=await import("node:fs");
fs.mkdirSync(workspace);
const fake=join(root,"codex-fixture.cjs");
writeFileSync(fake,[
'let input="";process.stdin.on("data",c=>input+=c);',
'process.stdin.on("end",()=>{',
' const thread=JSON.stringify({type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"});',
' const end=JSON.stringify({type:"turn.completed",usage:{input_tokens:5,output_tokens:2,prompt:"not_a_real_usage_field"}});',
' require("node:fs").writeFileSync("mcp-edit.txt",input);',
' process.stdout.write(thread+"\\n"+end+"\\n");',
'});'
].join("\n"),{mode:0o700});
chmodSync(fake,0o700);
const state=join(root,"state");
const store=new CoachReviewEventStore(state);
const locks=new JobResourceLocks();
const runner=new NativeCodexAgentRunner({
 events:store,nodePath:"/Users/liz/.local/bin/node",codexPath:fake,locks,
 spawn:(file,args,options)=>spawn(file,args,options),
});
function context(readOnly:boolean):ServerContext {
 return {config:{readOnly},workspaces:{
  getWorkspace(id:string){if(id!=="authorized")throw new Error("WORKSPACE_NOT_AUTHORIZED");return {root:workspace};}
 },coachReviewEvents:store,getNativeCodexRunner:()=>runner} as unknown as ServerContext;
}
const mp=new McpServer({name:"native-b1-roundtrip",version:"1.0.0"});
registerCodexAgentTools(mp,context(false));
const client=new Client({name:"native-b1-test",version:"1.0.0"});
const [a,b]=InMemoryTransport.createLinkedPair();
await mp.connect(b);await client.connect(a);
try {
 const names=(await client.listTools()).tools.map(t=>t.name).sort();
 assert.deepEqual(names,["codex_agent_clear_quarantine","codex_agent_evidence","codex_agent_quarantine_status","codex_agent_source_diff","codex_agent_start","codex_agent_status","codex_agent_stop"]);
 const denied=await client.callTool({name:"codex_agent_start",arguments:{
  workspaceId:"untrusted",operationId:"denied",prompt:"edit",model:"gpt-5.6-luna",
  reasoningEffort:"none",sandbox:"workspace-write"
 }});
 assert.equal(denied.isError,true);
 assert.equal(store.listPending("authorized").pending_count,0);
 const input={workspaceId:"authorized",operationId:"mcp-real",prompt:"mcp-fixture-edit",
  model:"gpt-5.6-luna",reasoningEffort:"none",sandbox:"workspace-write"} as const;
 const initial=await client.callTool({name:"codex_agent_start",arguments:input});
 assert.equal(initial.isError ?? false,false,JSON.stringify(initial));
 assert.equal(JSON.stringify(initial).includes(input.prompt),false,"prompt must not echo");
 const complete=await runner.run({...input,workspaceRoot:workspace});
 assert.equal(complete.state,"COMPLETED");
 const status=await client.callTool({name:"codex_agent_status",
  arguments:{workspaceId:"authorized",operationId:"mcp-real"}});
 assert.equal(status.isError ?? false,false);
 assert.equal(((status.structuredContent as Record<string,unknown> | undefined)?.status as {state:string} | undefined)?.state,"COMPLETED");
 const ev=await client.callTool({name:"codex_agent_evidence",
  arguments:{workspaceId:"authorized",operationId:"mcp-real"}});
 assert.equal(ev.isError ?? false,false);
 const evidence=(ev.structuredContent as Record<string,unknown> | undefined)?.evidence as {operationId:string;evidenceSha256:string}|undefined;
 assert.ok(evidence);
 assert.equal(evidence.operationId,"mcp-real");
 assert.equal(evidence.evidenceSha256,complete.evidenceSha256);
 assert.ok(!JSON.stringify(evidence).includes(input.prompt));
 assert.equal("sourceDiff" in evidence,false,"ordinary evidence must not expose source");
 const diff=await client.callTool({name:"codex_agent_source_diff",arguments:{workspaceId:"authorized",operationId:"mcp-real"}});
 assert.equal(diff.isError??false,false);
 assert.match(String((diff.structuredContent as Record<string,unknown> | undefined)?.sourceDiff),/mcp-fixture-edit/);
 assert.ok(!JSON.stringify(evidence).includes("not_a_real_usage_field"));
 assert.equal(store.listPending("authorized").pending_count,1);
 const nope=await client.callTool({name:"codex_agent_evidence",
  arguments:{workspaceId:"other",operationId:"mcp-real"}});
 assert.equal(nope.isError,true);
 const stopped=await client.callTool({name:"codex_agent_stop",
  arguments:{workspaceId:"authorized",operationId:"mcp-real"}});
 assert.equal(stopped.isError??false,false);
 assert.equal((stopped.structuredContent as Record<string,unknown> | undefined)?.stopped,false);
 const reopened=new CoachReviewEventStore(state);
 try {
  const packet=reopened.getEvidence("authorized","mcp-real") as any;
  assert.equal(packet.evidenceSha256,complete.evidenceSha256,
    "evidence must survive a new SQLite handle / simulated server restart");
  assert.equal(reopened.getEvidence("other","mcp-real"),undefined);
 } finally {reopened.close();}
 const readonly=new McpServer({name:"native-b1-ro",version:"1.0.0"});
 registerCodexAgentTools(readonly,context(true));
 const roclient=new Client({name:"native-b1-ro-client",version:"1.0.0"});
 const [ra,rb]=InMemoryTransport.createLinkedPair();
 await readonly.connect(rb);await roclient.connect(ra);
 try {
  assert.deepEqual((await roclient.listTools()).tools.map(x=>x.name).sort(),
    ["codex_agent_evidence","codex_agent_quarantine_status","codex_agent_source_diff","codex_agent_status"]);
 } finally {await roclient.close();await readonly.close();}
 console.log("COACH006B1_MCP_CLIENT_START_STATUS_EVIDENCE_STOP_AND_RESTART_PASS");
} finally {
 await runner.close();await client.close();await mp.close();
 store.close();rmSync(root,{force:true,recursive:true});
}
