import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync,mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuardianMarker,GUARDIAN_SOURCE,readGuardianIdentity,assessGuardian } from "./coach-agent-guardian.js";

const root=mkdtempSync(join(tmpdir(),"coach-guardian-normal-"));
const delayed=join(root,"LEAKED_DESCENDANT.txt"),cli=join(root,"fake.cjs");
const mode=process.env.COACH_TEST_MODE??"with-grandchild";
const childScript="setTimeout(()=>require('node:fs').writeFileSync("+JSON.stringify(delayed)+",'LEAKED'),1500);setTimeout(()=>process.exit(0),2500)";
writeFileSync(cli,[
'const cp=require("node:child_process"),fs=require("node:fs");',
'if(process.argv[2]==="with-grandchild"){',
" const script="+JSON.stringify(childScript)+";",
' cp.spawn(process.execPath,["-e",script],{stdio:["ignore","inherit","inherit"],detached:false});',
'}',
'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"})+"\\n");',
'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");',
'setTimeout(()=>process.exit(0),80);',
].join("\n"),{mode:0o700});chmodSync(cli,0o700);
const marker=createGuardianMarker();
const g=spawn(process.execPath,["-e",GUARDIAN_SOURCE,"--",marker,cli,mode],{
 cwd:root,detached:true,stdio:["pipe","pipe","pipe","pipe"],
});
let data="",errors="";
g.stdout.on("data",(c:Buffer)=>{data+=c.toString()});
g.stderr.on("data",(c:Buffer)=>{errors+=c.toString()});
try{
 assert.ok(g.pid);
 g.stdin.end("hello");
 const code=await Promise.race([
  new Promise<number>((resolve,reject)=>{
   g.on("error",reject);g.on("close",(exit)=>resolve(exit??-1));
  }),
  new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("GUARDIAN_NORMAL_CLOSE_TIMEOUT "+errors+" parentExit="+g.exitCode+" signal="+g.signalCode+" stdoutEnded="+g.stdout?.readableEnded+" stderrEnded="+g.stderr?.readableEnded)),4700)),
 ]);
 assert.equal(code,0,"clean Codex exit must be propagated; stderr="+errors);
 assert.match(data,/"turn.completed"/);
 await new Promise(resolve=>setTimeout(resolve,1700));
 assert.equal(existsSync(delayed),false,"grandchild survived a normal successful Codex exit");
 console.log("COACH006B3_OS_GUARDIAN_NORMAL_CLOSE_NO_SURVIVOR_PASS");
} finally{
 if(g.pid && readGuardianIdentity(g.pid,marker) &&
    assessGuardian(readGuardianIdentity(g.pid,marker)!).kind==="alive"){
   try{process.kill(-g.pid,"SIGKILL")}catch{}
 }
 rmSync(root,{force:true,recursive:true});
}
