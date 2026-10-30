import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,rmSync,chmodSync,realpathSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer,type Socket} from "node:net";
import {randomUUID,createHash} from "node:crypto";
import {AppBridgeError,createSharedThread,readSharedThread,sendSharedTurn,sharedAppStatus,bindSharedThread,boundSharedThread,sharedTurnReceipt,reconcileSharedTurn,assertSharedThreadOwnership} from "./coach-app-server-bridge.js";

const dir=mkdtempSync(join(tmpdir(),"codex-app-bridge-"));
const socketPath=join(dir,"shared.sock"),root=join(dir,"project"),wrongRoot=join(dir,"other"),stateDir=join(dir,"state");
mkdirSync(root);mkdirSync(wrongRoot);mkdirSync(stateDir);
const threadId="01a16969-677a-7033-9acd-a77503a7aeaf";
const thread={id:threadId,cwd:root,source:"vscode",ephemeral:false,status:{type:"idle"},turns:[] as any[]};
const state={turnStarts:0,reads:0, resumes:0, denyResume:false, wrongCwd:false, historyUnsupported:false, resumeUnsupported:false, lastPrompt:"", slow:false,
 frameLimit:false, readError:false, echoRequestedIds:false, readCalls:[] as Array<{includeTurns:unknown;threadId:unknown}>};
function reply(s:Socket,m:any) {
 const json=Buffer.from(JSON.stringify(m));
 const n=json.length;let h:Buffer;if(n<126)h=Buffer.from([0x81,n]);else if(n<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(n,2);}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(n),2)}
 s.write(Buffer.concat([h,json]));
}
// Declares an uncompressed frame larger than the bridge's 2 MiB MAX_FRAME; the
// client must fail with CODEX_APP_FRAME_LIMIT before any payload is parsed.
function sendOversizeFrame(s:Socket) {
 const h=Buffer.alloc(10);h[0]=0x82;h[1]=127;h.writeBigUInt64BE(BigInt(3_000_000),2);s.write(h);
}
const server=createServer(s=>{
 let buffer=Buffer.alloc(0),upgraded=false;
 const consume=()=>{
  if(!upgraded){const i=buffer.indexOf("\r\n\r\n");if(i<0)return;
    const header=buffer.subarray(0,i).toString("ascii"), key=/Sec-WebSocket-Key:\s*(.+)/i.exec(header)?.[1]?.trim();
    assert.ok(key);
    s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+createHash("sha1").update(key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")+"\r\n\r\n");
    upgraded=true;buffer=buffer.subarray(i+4);}
  while(buffer.length>=2){
   let n=buffer[1]&127,pos=2;if(n===126){if(buffer.length<4)return;n=buffer.readUInt16BE(2);pos=4;}else if(n===127){if(buffer.length<10)return;n=Number(buffer.readBigUInt64BE(2));pos=10;}
   const maskFlag=!!(buffer[1]&128),end=pos+(maskFlag?4:0)+n;if(buffer.length<end)return;
   const data=Buffer.from(buffer.subarray(pos+(maskFlag?4:0),end));
   if(maskFlag){const m=buffer.subarray(pos,pos+4);for(let i=0;i<data.length;i++)data[i]^=m[i%4];}
   buffer=buffer.subarray(end);
   if((buffer[0]&15)===8)continue;
   let x:any;try{x=JSON.parse(data.toString("utf8"));}catch{continue;}
   if(x.method==="initialize")reply(s,{id:x.id,result:{platformOs:"macos"}});
   else if(x.method==="initialized"){}
   else if(x.method==="thread/read"){state.reads++;state.readCalls.push({includeTurns:x.params?.includeTurns,threadId:x.params?.threadId});
      if(state.readError)reply(s,{id:x.id,error:{code:-32603,message:"internal error"}});
      else if(state.frameLimit&&x.params?.includeTurns)sendOversizeFrame(s);
      else if(state.historyUnsupported&&x.params?.includeTurns)reply(s,{id:x.id,error:{code:-32600,message:"list_turns is not supported yet"}});
      else reply(s,{id:x.id,result:{thread:{...thread,id:state.echoRequestedIds?x.params.threadId:thread.id,cwd:state.wrongCwd?wrongRoot:root}}});}
   else if(x.method==="thread/resume"){
     state.resumes++;
     if(state.denyResume)reply(s,{id:x.id,error:{code:-32600,message:"thread already has an active writer"}});
     else if(state.resumeUnsupported)reply(s,{id:x.id,error:{code:-32600,message:"list_turns is not supported yet"}});
     else reply(s,{id:x.id,result:{thread:{...thread,cwd:state.wrongCwd?wrongRoot:root}}});
   }
   else if(x.method==="thread/start"){
      reply(s,{id:x.id,result:{thread:{...thread,id:"aa2369a7-c3aa-44ae-9334-11ea12745fb1",cwd:x.params.cwd}}});
   }
   else if(x.method==="turn/start"){
      state.turnStarts++;
      state.lastPrompt=x.params.input?.[0]?.text;
      const turnId=randomUUID();
      reply(s,{id:x.id,result:{turn:{id:turnId}}});
      if(state.slow){thread.turns.push({status:{type:"inProgress"},id:turnId,items:[{type:"userMessage",content:[{type:"text",text:state.lastPrompt}]}]});continue;}
      const ack="REPLY:"+state.lastPrompt;
      thread.turns.push({status:"completed",id:turnId,items:[
        {type:"userMessage",content:[{type:"text",text:state.lastPrompt}]},
        {type:"agentMessage",text:ack}
      ]});
      setImmediate(()=>{
       reply(s,{method:"item/completed",params:{threadId,item:{type:"agentMessage",text:ack}}});
       reply(s,{method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",items:[{type:"agentMessage",text:ack}]}}});
      });
   }
  }
 };
 s.on("data",d=>{buffer=Buffer.concat([buffer,Buffer.isBuffer(d)?d:Buffer.from(d)]);consume();});
  // A frame-limited client destroys its socket; keep that teardown from
  // surfacing as an unhandled server error.
  s.on("error",()=>{});
});
await new Promise<void>(resolve=>server.listen(socketPath,resolve));
chmodSync(socketPath,0o600);
const context={workspaceId:"ws_test",root,threadId,stateDir,socketPath};
async function rejectsCode(p:Promise<unknown>,code:string){await assert.rejects(p,e=>e instanceof AppBridgeError&&e.code===code);}
try{
 assert.equal((await sharedAppStatus(socketPath)).connected,true);
 const firstRead=await readSharedThread({...context,limit:5});
 assert.equal(firstRead.thread.threadId,threadId);
 assert.equal(firstRead.origin,"live","normal live read keeps origin=live");
 assert.equal(firstRead.messages.length,0);
 state.historyUnsupported=true;
 const noHistory=await readSharedThread({...context,limit:5});assert.equal(noHistory.historyAvailable,false);
 assert.equal(noHistory.origin,"live","metadata-only live read is still live transport");
 state.historyUnsupported=false;
 await rejectsCode(readSharedThread({...context,root:wrongRoot}),"CODEX_APP_THREAD_WORKSPACE_MISMATCH");
 const created=await createSharedThread({root,socketPath});
 assert.equal(created.source,"vscode");assert.equal(created.cwd,realpathSync(root));
 await rejectsCode(sendSharedTurn({...context,operationId:"unbound",prompt:"no",sandbox:"read-only"}),"CODEX_APP_THREAD_NOT_BOUND");
 assert.equal(boundSharedThread(stateDir,"ws_test"),undefined);
 assert.equal(await bindSharedThread(context),threadId);
 assertSharedThreadOwnership(stateDir,"ws_test",root,threadId);
 assert.throws(()=>assertSharedThreadOwnership(stateDir,"ws_test",wrongRoot,threadId),/OWNERSHIP_CHANGED/);
 assert.equal(await bindSharedThread(context),threadId);
 await rejectsCode(bindSharedThread({...context,workspaceId:"another_workspace"}),"CODEX_APP_THREAD_ALREADY_OWNED");
 await rejectsCode(bindSharedThread({...context,workspaceId:"ws_test",threadId:"aa2369a7-c3aa-44ae-9334-11ea12745fb1"}),"CODEX_APP_THREAD_MISMATCH");
 const a=await sendSharedTurn({...context,operationId:"turn_a",prompt:"hello",sandbox:"read-only"});
 assert.equal(a.reply,"REPLY:hello");assert.equal(a.threadId,threadId);
 const b=await sendSharedTurn({...context,operationId:"turn_b",prompt:"next",sandbox:"read-only"});
 assert.equal(b.reply,"REPLY:next");assert.equal(state.turnStarts,2);
 const duplicate=await sendSharedTurn({...context,operationId:"turn_b",prompt:"next",sandbox:"read-only"});
 assert.deepEqual(duplicate,b);assert.equal(state.turnStarts,2,"successful operation MUST NOT replay");
 await rejectsCode(sendSharedTurn({...context,operationId:"turn_b",prompt:"changed",sandbox:"read-only"}),"CODEX_APP_OPERATION_CONFLICT");
 const history=await readSharedThread({...context,limit:10});
 assert.equal(history.thread.turns,2);
 assert.ok(history.messages.some(x=>x.role==="user"&&x.text==="next"));
 assert.ok(history.messages.some(x=>x.role==="assistant"&&x.text==="REPLY:hello"));
 state.wrongCwd=true;
 await rejectsCode(sendSharedTurn({...context,operationId:"turn_cross",prompt:"not allowed",sandbox:"read-only"}),"CODEX_APP_THREAD_WORKSPACE_MISMATCH");
 assert.equal(state.turnStarts,2);
 state.wrongCwd=false;state.denyResume=true;
 await rejectsCode(sendSharedTurn({...context,operationId:"turn_locked",prompt:"not allowed",sandbox:"read-only"}),"CODEX_APP_RPC_REJECTED:thread already has an active writer");
 assert.equal(state.turnStarts,2);
 state.denyResume=false;
 // Uncertain response has already been admitted and cannot be replayed on transport timeout.
 state.slow=true;
 await rejectsCode(sendSharedTurn({...context,operationId:"turn_uncertain",prompt:"slow",sandbox:"read-only",timeoutMs:3000}),"CODEX_APP_TURN_TIMEOUT");
 const uncertain=sharedTurnReceipt(stateDir,"ws_test","turn_uncertain");
 assert.equal(uncertain?.state,"UNCERTAIN");assert.ok(uncertain?.acceptedTurnId,"accepted turn identity is durable before waiting");
 const n=state.turnStarts;
 await rejectsCode(sendSharedTurn({...context,operationId:"turn_uncertain",prompt:"slow",sandbox:"read-only"}),"CODEX_APP_OPERATION_UNCERTAIN");
 assert.equal(state.turnStarts,n);
 const delayed=thread.turns.find((x:any)=>x.id===uncertain?.acceptedTurnId);assert.ok(delayed);
 delayed.status={type:"completed"};delayed.items.push({type:"agentMessage",text:"late completion"});
 const recovered=await reconcileSharedTurn({...context,operationId:"turn_uncertain"});
 assert.equal(recovered?.reply,"late completion");assert.equal(sharedTurnReceipt(stateDir,"ws_test","turn_uncertain")?.state,"COMPLETED");
 assert.equal((await reconcileSharedTurn({...context,operationId:"turn_uncertain"}))?.turnId,uncertain?.acceptedTurnId,
   "restart reconciliation is idempotent and uses the accepted turn ID");
 state.slow=false;
 const pair=await Promise.all([sendSharedTurn({...context,operationId:"turn_same",prompt:"once",sandbox:"read-only"}),
   sendSharedTurn({...context,operationId:"turn_same",prompt:"once",sandbox:"read-only"})]);
 assert.deepEqual(pair[0],pair[1]);assert.equal(state.turnStarts,n+1);
 const distinct=await Promise.all([
   sendSharedTurn({...context,operationId:"turn_distinct_a",prompt:"serial_a",sandbox:"read-only"}),
   sendSharedTurn({...context,operationId:"turn_distinct_b",prompt:"serial_b",sandbox:"read-only"})]);
 assert.deepEqual(distinct.map(x=>x.reply),["REPLY:serial_a","REPLY:serial_b"]);
 state.resumeUnsupported=true;
 const backcompat=await sendSharedTurn({...context,operationId:"turn_legacy_resume",prompt:"backcompat",sandbox:"read-only"});
 assert.equal(backcompat.reply,"REPLY:backcompat");
 state.resumeUnsupported=false;
 const missing=await sharedAppStatus(join(dir,"missing.sock"));assert.equal(missing.connected,false);
 const alias=join(dir,"unsafe-alias.sock");symlinkSync(socketPath,alias);
 const unsafe=await sharedAppStatus(alias);assert.equal(unsafe.error,"CODEX_APP_SOCKET_UNSAFE");
 // ---- Oversize live frame: fail-closed native-rollout fallback -------------
 // A live `thread/read includeTurns:true` frame larger than MAX_FRAME closes the
 // connection. The bridge must re-read live metadata without turns and rebuild
 // history from the exact persisted rollout instead of surfacing FRAME_LIMIT.
 const codexHome=join(dir,"codex-home"),sessionDir=join(codexHome,"sessions","2026","10","24");
 mkdirSync(sessionDir,{recursive:true});
 const rolloutPath=(id:string)=>join(sessionDir,`rollout-2026-10-24T18-00-00-${id}.jsonl`);
 const sessionMeta=(id:string,metaId=id)=>({type:"session_meta",payload:{id:metaId,session_id:metaId,source:"vscode",cwd:root}});
 const writeRollout=(path:string,lines:unknown[])=>writeFileSync(path,lines.map(l=>JSON.stringify(l)).join("\n")+"\n");
 const conversation=(id:string)=>[
   sessionMeta(id),
   {type:"event_msg",payload:{type:"task_started",turn_id:"turn-1"}},
   {type:"event_msg",payload:{type:"item_completed",item:{type:"UserMessage",id:"u1",content:[{type:"text",text:"large user"}]}}},
   {type:"event_msg",payload:{type:"item_completed",item:{type:"AgentMessage",id:"a1",content:[{type:"text",text:"large assistant"}]}}},
   {type:"event_msg",payload:{type:"task_complete",turn_id:"turn-1"}},
 ];
 writeRollout(rolloutPath(threadId),conversation(threadId));
 state.echoRequestedIds=true;state.frameLimit=true;
 const callsBefore=state.readCalls.length;
 const fallback=await readSharedThread({...context,limit:1,codexHome});
 assert.equal(fallback.origin,"local_rollout");
 assert.equal(fallback.historyAvailable,true);
 assert.deepEqual(fallback.messages,[{role:"assistant",text:"large assistant"}]);
 assert.equal(fallback.thread.threadId,threadId);
 assert.equal(realpathSync(fallback.thread.cwd),realpathSync(root));
 assert.equal(fallback.thread.turns,1);
 assert.equal(fallback.thread.status,"idle","live status metadata wins over rollout-derived status");
 // The oversize full read is attempted first; fallback then reads metadata only.
 assert.deepEqual(state.readCalls.slice(callsBefore).map(c=>c.includeTurns),[true,false]);
 // Re-binding an already-bound large-history thread verifies via the fallback.
 assert.equal(await bindSharedThread({...context,codexHome}),threadId);
 // A fresh large-history thread must bind through readSharedThread(limit:1).
 const bindId=randomUUID(),bindStateDir=join(dir,"state-large");
 mkdirSync(bindStateDir);
 writeRollout(rolloutPath(bindId),conversation(bindId));
 assert.equal(await bindSharedThread({workspaceId:"ws_large",root,threadId:bindId,stateDir:bindStateDir,socketPath,codexHome}),bindId);
 assert.equal(boundSharedThread(bindStateDir,"ws_large"),bindId);
 // A live identity mismatch during fallback still propagates.
 state.wrongCwd=true;
 await rejectsCode(readSharedThread({...context,limit:1,codexHome}),"CODEX_APP_THREAD_WORKSPACE_MISMATCH");
 state.wrongCwd=false;
 // Missing rollout: explicit unavailable, never an empty success.
 await rejectsCode(readSharedThread({...context,threadId:randomUUID(),limit:1,codexHome}),"CODEX_APP_NATIVE_HISTORY_UNAVAILABLE");
 // Corrupt rollout: explicit unavailable.
 const corruptId=randomUUID();writeFileSync(rolloutPath(corruptId),"{\"type\":\"session_meta\"}\n");
 await rejectsCode(readSharedThread({...context,threadId:corruptId,limit:1,codexHome}),"CODEX_APP_NATIVE_HISTORY_UNAVAILABLE");
 // Rollout describing another thread identity: explicit identity mismatch.
 const mismatchId=randomUUID();writeRollout(rolloutPath(mismatchId),[sessionMeta(mismatchId,randomUUID())]);
 await rejectsCode(readSharedThread({...context,threadId:mismatchId,limit:1,codexHome}),"CODEX_APP_NATIVE_HISTORY_IDENTITY_MISMATCH");
 // Rollout with zero user/assistant content: explicit unavailable.
 const emptyId=randomUUID();
 writeRollout(rolloutPath(emptyId),[sessionMeta(emptyId),
   {type:"event_msg",payload:{type:"task_started",turn_id:"turn-1"}},
   {type:"event_msg",payload:{type:"task_complete",turn_id:"turn-1"}}]);
 await rejectsCode(readSharedThread({...context,threadId:emptyId,limit:1,codexHome}),"CODEX_APP_NATIVE_HISTORY_UNAVAILABLE");
 state.frameLimit=false;
 // Unrelated RPC errors are never treated as frame limits.
 state.readError=true;
 await rejectsCode(readSharedThread({...context,limit:1,codexHome}),"CODEX_APP_RPC_REJECTED:internal error");
 state.readError=false;state.echoRequestedIds=false;
 console.log("CODEX_APP_SHARED_BRIDGE_TEST_PASS",JSON.stringify({totalTurns:state.turnStarts,historyMessages:history.messages.length,fallbackMessages:fallback.messages.length}));
}finally{
 await new Promise<void>(r=>server.close(()=>r()));
 rmSync(dir,{recursive:true,force:true});
}
