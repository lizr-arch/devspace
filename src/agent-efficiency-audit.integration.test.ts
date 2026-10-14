import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AgentObserverStore } from "./agent-observer.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner } from "./codex-agent-runner.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAgentAuditTools } from "./server/tools-agent-audit.js";
import type { ServerContext } from "./server/server-types.js";

async function freePort(){
  const s=createServer();
  await new Promise<void>((resolve,reject)=>{s.once("error",reject);s.listen(0,"127.0.0.1",()=>resolve());});
  const a=s.address();assert.ok(a&&typeof a!=="string");
  await new Promise<void>(resolve=>s.close(()=>resolve()));
  return a.port;
}
test("real native JSONL subprocess -> runner -> private durable snapshot -> guarded sidecar",async()=>{
  const root=mkdtempSync(join(tmpdir(),"coach0082-audit-e2e-"));
  const space=join(root,"workspace"),state=join(root,"state");
  mkdirSync(space);mkdirSync(state);
  const fake=join(root,"fake-codex.cjs");
  const script=[
    "process.stdin.resume();",
    "process.stdin.on('end',()=>{",
    "const write=o=>process.stdout.write(JSON.stringify(o)+'\\n');",
    "write({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});",
    "write({type:'turn.started'});",
    "write({type:'item.started',item:{id:'call-a',type:'command_execution',command:'echo SECRET_NEVER_PERSIST'}});",
    "write({type:'item.completed',item:{id:'call-a',type:'command_execution',command:'echo SECRET_NEVER_PERSIST',status:'completed'}});",
    "write({type:'item.started',item:{id:'call-b',type:'command_execution',command:'echo SECRET_NEVER_PERSIST'}});",
    "write({type:'item.completed',item:{id:'call-b',type:'command_execution',command:'echo SECRET_NEVER_PERSIST',status:'completed'}});",
    "write({type:'turn.completed',usage:{input_tokens:44,cached_input_tokens:22,output_tokens:7}});",
    "});",
  ].join("\n");
  writeFileSync(fake,script,{mode:0o700});chmodSync(fake,0o700);
  let store:CoachReviewEventStore|undefined,manager:ManagedCoachSidecar|undefined;
  try{
    store=new CoachReviewEventStore(state);
    const observer=new AgentObserverStore();
    const runner=new NativeCodexAgentRunner({
      events:store,auditStore:store,observer,
      nodePath:"/Users/liz/.local/bin/node",codexPath:fake,
      locks:new JobResourceLocks(),
      spawn:(file,args,opts)=>spawn(file,args,opts)
    });
    const finished=await runner.run({
      workspaceId:"ws-e2e",workspaceRoot:space,operationId:"op-e2e",prompt:"safe agent fixture",
      model:"gpt-6-luna",reasoningEffort:"none",sandbox:"workspace-write",timeoutMs:3000
    });
    assert.equal(finished.state,"COMPLETED",JSON.stringify(finished));
    const snapshot=store.getEfficiencyAudit("ws-e2e","op-e2e");
    assert.ok(snapshot);
    assert.equal(snapshot.confirmedToolStarts,2);
    assert.equal(snapshot.confirmedToolCompletions,2);
    assert.equal(snapshot.observations.some(x=>x.id==="unfinished-steps"),false);
    assert.equal(snapshot.observations.some(x=>x.id==="possibly-repeated-input"),true);
    assert.equal(snapshot.tokenUsage.input_tokens,44);
    assert.doesNotMatch(JSON.stringify(snapshot),/SECRET_NEVER_PERSIST|safe agent fixture/);
    assert.equal(store.getEfficiencyAudit("other-workspace","op-e2e"),undefined);
    await runner.close();
    store.close();store=undefined;
    store=new CoachReviewEventStore(state);
    assert.equal(store.getEfficiencyAudit("ws-e2e","op-e2e")?.confirmedToolCompletions,2,"restart durability");

    // The exact registered MCP tool performs workspace authorization before
    // querying the scoped persistent store, not a generic global lookup.
    const fakeWorkspaces={getWorkspace:(id:string)=>{
      if(id!=="ws-e2e")throw new Error("workspace not authorized");
      return {root:space};
    }};
    const ctx={workspaces:fakeWorkspaces,coachReviewEvents:store} as unknown as ServerContext;
    const server=new McpServer({name:"audit-test-server",version:"1.0.0"});
    registerAgentAuditTools(server,ctx);
    const client=new Client({name:"audit-test-client",version:"1.0.0"});
    const [clientSide,serverSide]=InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);await client.connect(clientSide);
    try{
      assert.ok((await client.listTools()).tools.some(t=>t.name==="get_agent_efficiency_audit"));
      const allowed=await client.callTool({
        name:"get_agent_efficiency_audit",arguments:{workspaceId:"ws-e2e",operationId:"op-e2e"}
      });
      assert.equal(allowed.isError??false,false);
      const snapshotResult=allowed.structuredContent as {result:string;snapshot?:{confirmedToolCompletions:number}};
      assert.equal(snapshotResult.result,"ok");
      assert.equal(snapshotResult.snapshot?.confirmedToolCompletions,2);
      const denied=await client.callTool({
        name:"get_agent_efficiency_audit",arguments:{workspaceId:"other-workspace",operationId:"op-e2e"}
      });
      assert.equal(denied.isError,true);
      const wrongOperation=await client.callTool({
        name:"get_agent_efficiency_audit",arguments:{workspaceId:"ws-e2e",operationId:"other-operation"}
      });
      assert.equal((wrongOperation.structuredContent as {result:string}).result,"unavailable");
    } finally {await client.close();await server.close();}
    const port=await freePort(),ext="a".repeat(32),origin="chrome-extension://"+ext;
    manager=new ManagedCoachSidecar(new JobResourceLocks(),store.path,observer);
    const old=await manager.start({workspaceId:"coach-main",workspaceRoot:space,port,pairedExtensionId:ext});
    const endpoint="http://127.0.0.1:"+port+"/agent/audit?workspaceId=ws-e2e&operationId=op-e2e";
    const first=await fetch(endpoint,{headers:{Authorization:"Bearer "+old.token,Origin:origin}});
    assert.equal(first.status,403,"no implicit global audit scope");
    await manager.stop("coach-main");
    const live=await manager.start({workspaceId:"coach-main",workspaceRoot:space,port,
      pairedExtensionId:ext,observeAllNativeAgents:true});
    const headers={Authorization:"Bearer "+live.token,Origin:origin};
    assert.equal((await fetch(endpoint)).status,401);
    assert.equal((await fetch(endpoint,{headers:{...headers,Origin:"https://chatgpt.com"}})).status,403);
    assert.equal((await fetch(endpoint,{method:"POST",headers})).status,405);
    assert.equal((await fetch(endpoint+"&operationId=duplicate",{headers})).status,400);
    assert.equal((await fetch(endpoint.replace("ws-e2e","other-workspace"),{headers})).status,404);
    assert.equal((await fetch(endpoint.replace("op-e2e","invalid%20id"),{headers})).status,400);
    const badHost=await new Promise<number>((resolve,reject)=>{
      const req=request({hostname:"127.0.0.1",port,path:"/agent/audit?workspaceId=ws-e2e&operationId=op-e2e",
        headers:{...headers,Host:"evil.invalid"}},res=>{res.resume();resolve(res.statusCode||0);});
      req.once("error",reject);req.end();
    });
    assert.equal(badHost,400);
    const response=await fetch(endpoint,{headers});
    assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"no-store");
    const body=await response.json() as {snapshot:{confirmedToolStarts:number;confirmedToolCompletions:number;status:string}};
    assert.equal(body.snapshot.confirmedToolStarts,2);
    assert.equal(body.snapshot.confirmedToolCompletions,2);
    assert.equal(body.snapshot.status,"COMPLETED");
    const raw=JSON.stringify(body);
    assert.doesNotMatch(raw,/SECRET_NEVER_PERSIST|safe agent fixture/);

    const rawDb=new Database(store.path);
    rawDb.prepare("UPDATE agent_efficiency_audits SET snapshot_json=? WHERE workspace_id=?").run(
      JSON.stringify({...snapshot,elapsedMs:999999}),"ws-e2e");
    rawDb.close();
    assert.throws(()=>store!.getEfficiencyAudit("ws-e2e","op-e2e"),/COACH_AUDIT_INTEGRITY_FAILURE/);
    assert.equal((await fetch(endpoint,{headers})).status,503);
  }finally{
    try{await manager?.stop("coach-main");}catch{}
    try{store?.close();}catch{}
    rmSync(root,{recursive:true,force:true});
  }
});
