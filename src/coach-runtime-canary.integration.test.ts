import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { AgentObserverStore } from "./agent-observer.js";
import { NativeCodexAgentRunner } from "./codex-agent-runner.js";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import { registerCodexAgentTools } from "./server/tools-codex-agent.js";
import type { ServerContext } from "./server/server-types.js";

async function port(): Promise<number> {
  const s=createServer();
  await new Promise<void>((resolve,reject)=>{
    s.once("error",reject);s.listen(0,"127.0.0.1",()=>resolve());
  });
  const addr=s.address();assert.ok(addr && typeof addr!=="string");
  await new Promise<void>(resolve=>s.close(()=>resolve()));
  return addr.port;
}
const node="/Users/liz/.local/bin/node";
const tid="11111111-1111-4111-8111-111111111111";
test("one native Codex run -> MCP observer and real paired browser sidecar see identical events",async()=>{
  const root=mkdtempSync(join(tmpdir(),"coach-runtime-live-canary-"));
  const workspace=join(root,"workspace");mkdirSync(workspace);
  const script=join(root,"codex-fixture.cjs");
  // The fixture is deliberately not a real Codex login or model invocation.
  writeFileSync(script,[
    'let prompt="";process.stdin.on("data",b=>prompt+=b);',
    'process.stdin.on("end",()=>{',
    'const fs=require("node:fs");fs.writeFileSync("canary-output.txt","TEST_OUTPUT_ONLY");',
    'const events=[',
    '{type:"thread.started",thread_id:"'+tid+'"},',
    '{type:"turn.started"},',
    '{type:"item.started",item:{type:"command_execution",id:"cmd1",command:"echo CANARY_SECRET_NEVER_LEAK"}},',
    '{type:"item.completed",item:{type:"file_change",id:"file1",changes:[{path:"/Users/liz/private.key"}]}},',
    '{type:"turn.completed",usage:{input_tokens:10,output_tokens:2}}',
    '];',
    'for(const item of events)process.stdout.write(JSON.stringify(item)+"\\n");',
    '});'
  ].join("\n"),{mode:0o700});chmodSync(script,0o700);
  const store=new CoachReviewEventStore(join(root,"state"));
  const observer=new AgentObserverStore();
  const runner=new NativeCodexAgentRunner({
    events:store,observer,nodePath:node,codexPath:script,
    spawn:(file,args,options)=>spawn(file,args,options),
    locks:new JobResourceLocks(),
  });
  const sidecar=new ManagedCoachSidecar(new JobResourceLocks(),store.path,observer);
  const mcp=new McpServer({name:"coach-canary",version:"1.0.0"});
  const ws="canary-workspace",op="same-operation";
  const ctx={config:{readOnly:false},coachReviewEvents:store,agentObserver:observer,
    getNativeCodexRunner:()=>runner,
    workspaces:{getWorkspace:(id:string)=>{
      if(id!==ws)throw new Error("WRONG_WORKSPACE");return {root:workspace};
    }},
  } as unknown as ServerContext;
  registerCodexAgentTools(mcp,ctx);
  const client=new Client({name:"web-coach-canary",version:"1.0.0"});
  const [left,right]=InMemoryTransport.createLinkedPair();
  const ext="a".repeat(32);
  let pairedPort=0;
  try{
    await mcp.connect(right);await client.connect(left);
    pairedPort=await port();
    const pair=await sidecar.start({workspaceId:ws,workspaceRoot:workspace,port:pairedPort,
      pairedExtensionId:ext,observeAllNativeAgents:true});
    const args={workspaceId:ws,operationId:op,prompt:"CANARY_SECRET_NEVER_LEAK",
      model:"gpt-6-luna",reasoningEffort:"medium",sandbox:"workspace-write",timeoutMs:10000} as const;
    const started=await client.callTool({name:"codex_agent_start",arguments:args});
    assert.equal(started.isError??false,false,JSON.stringify(started));
    const ended=await runner.run({...args,workspaceRoot:workspace});
    assert.equal(ended.state,"COMPLETED",JSON.stringify(ended));
    const observed=await client.callTool({name:"codex_agent_observe",
      arguments:{workspaceId:ws,operationId:op,cursor:0,limit:50}});
    assert.equal(observed.isError??false,false,JSON.stringify(observed));
    const packet=observed.structuredContent as
      {events:Array<{cursor:number;workspaceId:string;operationId:string;phase?:string}>;
       nextCursor:number;status:{state:string;activeSelection:{model:string;reasoningEffort:string}}};
    assert.equal(packet.status.state,"COMPLETED");
    assert.equal(packet.status.activeSelection.model,"gpt-6-luna");
    assert.equal(packet.status.activeSelection.reasoningEffort,"medium");
    assert.ok(packet.events.some(e=>e.phase==="thread.started"));
    assert.ok(packet.events.some(e=>e.phase==="turn.completed"));
    assert.ok(packet.events.some(e=>e.phase==="runner.finalized"));
    const url="http://127.0.0.1:"+pairedPort+"/agent/events?cursor=0";
    const headers={Authorization:"Bearer "+pair.token,Origin:"chrome-extension://"+ext};
    const http=await fetch(url,{headers});
    assert.equal(http.status,200);
    const browser=await http.json() as {events:typeof packet.events;nextCursor:number};
    assert.deepEqual(browser.events.map(e=>[e.cursor,e.workspaceId,e.operationId,e.phase]),
      packet.events.map(e=>[e.cursor,e.workspaceId,e.operationId,e.phase]),
      "browser and Web GPT did not see the same native events");
    assert.equal(browser.nextCursor,packet.nextCursor);
    const security=await fetch(url);assert.equal(security.status,401);
    const queued=await client.callTool({name:"codex_agent_update_config",arguments:{
      workspaceId:ws,operationId:op,expectedRevision:0,
      model:"gpt-6.1-sol",reasoningEffort:"high"}});
    assert.equal(queued.isError??false,false,JSON.stringify(queued));
    const revision=(queued.structuredContent as
      {configuration:{revision:number;next:{model:string}}}).configuration;
    assert.equal(revision.revision,1);assert.equal(revision.next.model,"gpt-6.1-sol");
    const subsequent=await client.callTool({name:"codex_agent_observe",
      arguments:{workspaceId:ws,operationId:op,cursor:packet.nextCursor}});
    const follow=(subsequent.structuredContent as {events:Array<{phase?:string}>;
      nextCursor:number});
    assert.ok(follow.events.some(e=>e.phase==="runner.config_queued"));
    const browserAgain=await fetch("http://127.0.0.1:"+pairedPort+
      "/agent/events?cursor="+packet.nextCursor,{headers});
    assert.equal(browserAgain.status,200);
    const followBrowser=await browserAgain.json() as {events:Array<{phase?:string}>};
    assert.deepEqual(followBrowser.events.map(e=>e.phase),follow.events.map(e=>e.phase));
    const dump=JSON.stringify({packet,browser,follow,followBrowser});
    assert.doesNotMatch(dump,/CANARY_SECRET_NEVER_LEAK|private\.key|input_tokens/);
    const reopened=new CoachReviewEventStore(join(root,"state"));
    try{
      assert.equal(reopened.getRunConfig(ws,op)?.next.model,"gpt-6.1-sol");
      assert.equal(reopened.getRunConfig(ws,op)?.revision,1);
    }finally{reopened.close();}
    console.log("COACH_RUNTIME_SAME_AGENT_MCP_BROWSER_OBSERVER_CANARY_PASS");
  }finally{
    await runner.close();
    await sidecar.close();
    await client.close();await mcp.close();store.close();
    rmSync(root,{recursive:true,force:true});
  }
});
