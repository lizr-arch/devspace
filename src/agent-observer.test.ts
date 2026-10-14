import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentObserverStore, normalizeCodexNativeEvent } from "./agent-observer.js";
test("observer is monotonic, bounded, and redacts unsafe fields",()=>{
 const s=new AgentObserverStore(2);s.emit({workspaceId:"w",operationId:"o",kind:"tool",tool:"safe",basename:"x.ts",phase:"RUNNING"});
 s.emit({workspaceId:"w",operationId:"o",kind:"status",tool:"echo secret-token",basename:"/Users/liz/.env",phase:"bad value"});
 s.emit({workspaceId:"w",operationId:"o",kind:"end",status:"COMPLETED"});const r=s.read("w",0);assert.equal(r.events.length,2);assert.equal(r.gap,1);assert.equal(JSON.stringify(r).includes("secret-token"),false);assert.equal(JSON.stringify(r).includes(".env"),false);assert.ok(r.events[0].cursor<r.events[1].cursor);
});

test("Codex JSONL fixture projection is bounded to safe, known event categories",()=>{
 const store=new AgentObserverStore();
 const examples=[
  {type:"thread.started",thread_id:"01aaaaaa",prompt:"SECRET_PHRASE_A"},
  {type:"item.started",item:{type:"command_execution",command:"echo SECRET_PHRASE_B",command_line:"/Users/x/.env",stdout:"SECRET_PHRASE_C"}},
  {type:"item.completed",item:{type:"file_change",changes:[{path:"/Users/x/private.key",diff:"SECRET_PHRASE_D"}]}},
  {type:"item.updated",item:{type:"mcp_tool_call",arguments:{"api_key":"SECRET_PHRASE_E"}}},
  {type:"item.started",item:{type:"reasoning",text:"SECRET_PHRASE_F"}},
  {type:"item.started",item:{type:"agent_message",text:"SECRET_PHRASE_G"}},
  {type:"SECRET_PHRASE_H",item:{type:"command_execution"}},
  {type:"turn.completed",usage:{input_tokens:123},text:"SECRET_PHRASE_I"},
  {type:"error",message:"SECRET_PHRASE_J"},
 ];
 for(const raw of examples){
   const record=normalizeCodexNativeEvent("w1","operation-1",raw);
   if(record)store.emit(record);
 }
 const feed=store.readGlobal(0);
 assert.deepEqual(feed.events.map(e=>e.kind),["start","command","file-change","tool","end","status"]);
 assert.deepEqual(feed.events.map(e=>e.status),["RUNNING","RUNNING","COMPLETED","RUNNING","COMPLETED","RETRYING"]);
 assert.deepEqual(feed.events.map(e=>e.tool).filter(Boolean),["shell","patch","mcp"]);
 assert.doesNotMatch(JSON.stringify(feed),/SECRET_PHRASE|\.env|private\.key|api_key|command_line|input_tokens/);
 assert.equal(normalizeCodexNativeEvent("w","op",{type:"item.completed",item:{type:"unexpected_new_tool",text:"SECRET"}}),undefined);
 assert.equal(normalizeCodexNativeEvent("w","op",{type:"turn.unsafe_raw_cmd",command:"SECRET"}),undefined);
 assert.equal(normalizeCodexNativeEvent("w","op","not-json"),undefined);
});
test("observer global cursor gap, restart detection, and multi-worktree isolation",()=>{
 const s=new AgentObserverStore(2);
 s.emit({workspaceId:"A",operationId:"opA",kind:"start"});
 s.emit({workspaceId:"B",operationId:"opB",kind:"start"});
 s.emit({workspaceId:"A",operationId:"opA",kind:"end",phase:"runner.finalized",status:"STOPPED"});
 const tail=s.readGlobal(0);
 assert.equal(tail.gap,1);
 assert.equal(tail.events.length,2);
 assert.equal(s.read("B",0).events.length,1);
 assert.equal(s.read("A",0).events.length,2);
 assert.equal(s.read("A",1000).reset,true,"stale MCP cursor must reset after DevSpace boot");
 assert.deepEqual(s.read("A",1000).events.map(e=>e.phase),s.read("A",0).events.map(e=>e.phase));
 assert.equal(s.readGlobal(1000).reset,true);
 assert.equal(s.readGlobal(1000).events.length,2);
});
