import assert from "node:assert/strict";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenCodeSessionAdapter} from "./opencode-session-adapter.js";

const root=mkdtempSync(join(tmpdir(),"opencode-session-adapter-"));
const canonicalRoot=realpathSync(root);
const sessionId="ses_0123456789ABCDEF";
const calls:Array<{method:string;path:string;directory:string;data?:unknown}>=[];
let returnedDirectory=canonicalRoot;
const adapter=await OpenCodeSessionAdapter.authorize({
  baseUrl:"http://127.0.0.1:49374",directory:root,sessionId,
  request:async(method,path,directory,data)=>{
    calls.push({method,path,directory,data});
    if(method==="GET"&&path===`/api/session/${sessionId}`)
      return{status:200,body:{data:{id:sessionId,location:{directory:returnedDirectory},model:{providerID:"openai",id:"gpt-6-luna",variant:"medium"}}}};
    if(method==="POST"&&path.endsWith("/prompt"))return{status:200,body:{data:{id:"msg_user_1",type:"user"}}};
    if(method==="GET"&&path.endsWith("/message"))return{status:200,body:{data:[{id:"msg_user_1",type:"user",time:{created:1}},{id:"msg_assistant_1",type:"assistant",time:{created:2,completed:3},finish:"stop",content:[{type:"text",text:"ok"}]}]}};
    throw new Error(`Unexpected request ${method} ${path}`);
  },
});

try{
  const identity=await adapter.readSession();
  assert.equal(identity.id,sessionId);
  assert.equal(identity.model?.providerID,"openai");
  assert.equal(identity.model?.id,"gpt-6-luna");
  assert.equal(identity.model?.variant,"medium");
  const accepted=await adapter.prompt("first turn");
  assert.deepEqual(accepted,{id:"msg_user_1",type:"user"});
  const assistant=await adapter.waitForTurn("msg_user_1",100);
  assert.equal(assistant.id,"msg_assistant_1");
  assert.ok(calls.every(call=>call.directory===canonicalRoot),"must scope every API call to the authorized directory");
  assert.ok(calls.some(call=>call.method==="POST"&&call.data&&"text" in (call.data as object)));

  returnedDirectory=join(canonicalRoot,"wrong-directory");
  await assert.rejects(adapter.prompt("must not send"),/OPENCODE_SESSION_DIRECTORY_MISMATCH/);
  assert.equal(calls.filter(call=>call.method==="POST").length,1,"mismatched session must be rejected before prompt POST");
  await assert.rejects(OpenCodeSessionAdapter.authorize({baseUrl:"http://example.com",directory:root,sessionId}),/OPENCODE_BASE_URL_MUST_BE_LOOPBACK/);
  await assert.rejects(OpenCodeSessionAdapter.authorize({baseUrl:"http://127.0.0.1:49374",directory:root,sessionId:"not-a-session"}),/OPENCODE_SESSION_ID_INVALID/);
  console.log("OpenCode Session adapter tests passed: pinned ID, loopback endpoint, exact directory, prompt and completed-turn polling.");
}finally{
  rmSync(root,{recursive:true,force:true});
}
