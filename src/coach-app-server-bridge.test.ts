import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,rmSync,chmodSync,realpathSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer,type Socket} from "node:net";
import {randomUUID,createHash} from "node:crypto";
import {AppBridgeError,createSharedThread,readSharedThread,sendSharedTurn,sharedAppStatus,bindSharedThread,boundSharedThread} from "./coach-app-server-bridge.js";

const dir=mkdtempSync(join(tmpdir(),"codex-app-bridge-"));
const socketPath=join(dir,"shared.sock"),root=join(dir,"project"),wrongRoot=join(dir,"other"),stateDir=join(dir,"state");
mkdirSync(root);mkdirSync(wrongRoot);mkdirSync(stateDir);
const threadId="01a16969-677a-7033-9acd-a77503a7aeaf";
const thread={id:threadId,cwd:root,source:"vscode",ephemeral:false,status:{type:"idle"},turns:[] as any[]};
const state={turnStarts:0,reads:0, resumes:0, denyResume:false, wrongCwd:false, historyUnsupported:false, resumeUnsupported:false, lastPrompt:"", slow:false};
function reply(s:Socket,m:any) {
 const json=Buffer.from(JSON.stringify(m));
 const n=json.length;let h:Buffer;if(n<126)h=Buffer.from([0x81,n]);else if(n<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(n,2);}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(n),2)}
 s.write(Buffer.concat([h,json]));
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
   else if(x.method==="thread/read"){state.reads++;if(state.historyUnsupported&&x.params?.includeTurns)reply(s,{id:x.id,error:{code:-32600,message:"list_turns is not supported yet"}});else reply(s,{id:x.id,result:{thread:{...thread,cwd:state.wrongCwd?wrongRoot:root}}});}
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
      if(state.slow)continue;
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
});
await new Promise<void>(resolve=>server.listen(socketPath,resolve));
chmodSync(socketPath,0o600);
const context={workspaceId:"ws_test",root,threadId,stateDir,socketPath};
async function rejectsCode(p:Promise<unknown>,code:string){await assert.rejects(p,e=>e instanceof AppBridgeError&&e.code===code);}
try{
 assert.equal((await sharedAppStatus(socketPath)).connected,true);
 const thread=await readSharedThread({...context,limit:5});
 assert.equal(thread.thread.threadId,threadId);
 assert.equal(thread.messages.length,0);
 state.historyUnsupported=true;
 const noHistory=await readSharedThread({...context,limit:5});assert.equal(noHistory.historyAvailable,false);
 state.historyUnsupported=false;
 await rejectsCode(readSharedThread({...context,root:wrongRoot}),"CODEX_APP_THREAD_WORKSPACE_MISMATCH");
 const created=await createSharedThread({root,socketPath});
 assert.equal(created.source,"vscode");assert.equal(created.cwd,realpathSync(root));
 await rejectsCode(sendSharedTurn({...context,operationId:"unbound",prompt:"no",sandbox:"read-only"}),"CODEX_APP_THREAD_NOT_BOUND");
 assert.equal(boundSharedThread(stateDir,"ws_test"),undefined);
 assert.equal(await bindSharedThread(context),threadId);
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
 const n=state.turnStarts;
 await rejectsCode(sendSharedTurn({...context,operationId:"turn_uncertain",prompt:"slow",sandbox:"read-only"}),"CODEX_APP_OPERATION_UNCERTAIN");
 assert.equal(state.turnStarts,n);
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
 console.log("CODEX_APP_SHARED_BRIDGE_TEST_PASS",JSON.stringify({totalTurns:state.turnStarts,historyMessages:history.messages.length}));
}finally{
 await new Promise<void>(r=>server.close(()=>r()));
 rmSync(dir,{recursive:true,force:true});
}
