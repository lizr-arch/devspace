/**
 * Opt-in macOS E2E: DEVSPACE_RUN_REAL_E2E=1 node --import tsx
 * src/codex-worker-api-restart.real.test.ts
 *
 * Uses a real Codex CLI, Worker UDS, DevSpace API/MCP process, temporary OAuth
 * and SQLite state, and an isolated workspace. Never targets production.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { loadConfig } from "./config.js";
import { CodexWorkerClient, defaultCodexWorkerKey, defaultCodexWorkerSocket } from "./codex-worker-ipc.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { assessGuardian, inspectProcessIdentity } from "./coach-agent-guardian.js";

if (process.env.DEVSPACE_RUN_REAL_E2E !== "1") {
  console.log("SKIP: set DEVSPACE_RUN_REAL_E2E=1 to run a real, isolated Codex/API restart test");
  process.exit(0);
}
assert.equal(process.platform,"darwin","real worker lifecycle test requires macOS process identity inspection");

// UDS path length is bounded by the macOS sockaddr_un limit.
const root=mkdtempSync(join(tmpdir(),"dsr2-"));
const workspace=join(root,"workspace"),stateDir=join(root,"state"),configDir=join(root,"config");
mkdirSync(workspace);mkdirSync(stateDir);mkdirSync(configDir);
const port=await freePort();
const baseUrl=`http://127.0.0.1:${port}`;
const ownerToken=`reliability-test-${randomUUID()}-owner-token`;
writeFileSync(join(configDir,"config.json"),JSON.stringify({host:"127.0.0.1",port,publicBaseUrl:baseUrl,allowedRoots:[workspace],mcpTransportMode:"stateless",widgets:"off"}),{mode:0o600});
writeFileSync(join(configDir,"auth.json"),JSON.stringify({ownerToken}),{mode:0o600});
const env={...process.env,DEVSPACE_CONFIG_DIR:configDir,DEVSPACE_STATE_DIR:stateDir,DEVSPACE_ALLOWED_ROOTS:workspace,DEVSPACE_CODEX_WORKER_SOCKET:defaultCodexWorkerSocket(stateDir),DEVSPACE_MCP_TRANSPORT_MODE:"stateless",HOST:"127.0.0.1",PORT:String(port),DEVSPACE_PUBLIC_BASE_URL:baseUrl};
const config=loadConfig(env);
let workerProcess:ChildProcess|undefined;
let api:ChildProcess|undefined;
let provider:SingleUserOAuthProvider|undefined;
let workerClient:CodexWorkerClient|undefined;
let evidenceStore:CoachReviewEventStore|undefined;
let operationId=`real-api-restart-${randomUUID()}`;
let hardExitOperationId=`real-api-hard-exit-${randomUUID()}`;
let workerCrashOperationId=`real-worker-crash-${randomUUID()}`;
let workspaceId="";

try {
  workerProcess=await startWorker(env);
  workerClient=new CodexWorkerClient(defaultCodexWorkerSocket(stateDir),defaultCodexWorkerKey(stateDir));
  evidenceStore=new CoachReviewEventStore(stateDir);
  provider=new SingleUserOAuthProvider(config.oauth,new URL(`${baseUrl}/mcp`),stateDir);
  const redirectUri="http://localhost/reliability-test";
  const registerClient=provider.clientsStore.registerClient;
  assert.ok(registerClient,"OAuth client registration is available");
  const client=await registerClient.call(provider.clientsStore,{redirect_uris:[redirectUri],client_name:"isolated reliability test"});
  const code=`code-${randomUUID()}`;
  (provider as unknown as {oauthStore:{saveAuthorizationCode(input:unknown):void}}).oauthStore.saveAuthorizationCode({code,clientId:client.client_id,params:{redirectUri,codeChallenge:"test-challenge",scopes:[config.oauth.scopes[0]??"devspace"],resource:new URL(`${baseUrl}/mcp`)},expiresAtMs:Date.now()+60_000});
  const token=await provider.exchangeAuthorizationCode(client,code,undefined,redirectUri,new URL(`${baseUrl}/mcp`));
  await provider.close();provider=undefined;

  api=await startApi(env,port);
  const initialHealth=await getJson(`${baseUrl}/healthz`);
  const opened=await mcpCall(baseUrl,token.access_token,1,"tools/call",{name:"open_workspace",arguments:{path:workspace}});
  const openedWorkspaceId=findString(opened,"workspaceId");assert.ok(openedWorkspaceId,"open_workspace returns workspaceId");workspaceId=openedWorkspaceId;
  const coachPort=await freePort(),extensionId="a".repeat(32);
  const coachStarted=await mcpCall(baseUrl,token.access_token,14,"tools/call",{name:"start_coach_sidecar",arguments:{workspaceId,port:coachPort,pairedExtensionId:extensionId}});
  const coachToken=findString(coachStarted,"token");assert.ok(coachToken,"Coach returns one-time pairing token");
  const coachUrl=`http://127.0.0.1:${coachPort}`;
  assert.equal((await fetch(`${coachUrl}/health`,{headers:{Authorization:`Bearer ${coachToken}`}})).status,200);
  assert.equal((await fetch(`${coachUrl}/health`)).status,401,"Coach rejects missing bearer token");
  assert.equal((await fetch(`${coachUrl}/agent/events?cursor=0`,{headers:{Authorization:`Bearer ${coachToken}`,Origin:"chrome-extension://"+"b".repeat(32)}})).status,403,"Coach rejects forged extension Origin");

  const prompt="Wait at least 25 seconds before changing files (use a shell sleep command so the supervisor has time to be restarted). Then create exactly one file named result.txt in the current workspace containing exactly this single line and newline: DEVSPACE_RELIABILITY_002_REAL_CODEX_OK. Do not create or modify any other file. Verify result.txt contents.";
  const started=await mcpCall(baseUrl,token.access_token,2,"tools/call",{name:"codex_agent_start",arguments:{workspaceId,operationId,prompt,model:"gpt-6-luna",reasoningEffort:"low",sandbox:"workspace-write",timeoutMs:180000}});
  assert.ok(JSON.stringify(started).includes(operationId),"MCP returns the operation ID");
  let status=await workerClient.status(operationId,workspaceId);
  assert.equal(status.state,"RUNNING",`Codex must be running before API restart; status=${status.state}`);
  const workerPid=(await workerClient.health()).pid;
  const apiPid=api.pid!;assert.notEqual(apiPid,workerPid,"API and Worker must have distinct PIDs");
  const guardianBefore=evidenceStore.getGuardian(workspaceId,operationId);assert.ok(guardianBefore,"Guardian identity persisted before API restart");
  const guardianProcessBefore=inspectProcessIdentity(guardianBefore.pid);assert.ok(guardianProcessBefore&&guardianProcessBefore.lstart===guardianBefore.lstart&&guardianProcessBefore.pgid===guardianBefore.pgid,"Guardian OS identity matches SQLite before API restart");

  await stopApi(api);api=undefined;
  assert.equal((await workerClient.status(operationId,workspaceId)).state,"RUNNING","Codex remains running after API process exits");
  assert.equal((await fetch(`${coachUrl}/health`,{headers:{Authorization:`Bearer ${coachToken}`}})).status,200,"Coach remains online while API is down");
  api=await startApi(env,port);
  const restartedApiPid=api.pid!;
  const restartedHealth=await getJson(`${baseUrl}/healthz`);
  assert.notEqual(restartedHealth.bootId,initialHealth.bootId,"new API process has a new boot ID");
  assert.equal((await workerClient.health()).pid,workerPid,"the same Worker still owns the job");
  const guardianAfter=evidenceStore.getGuardian(workspaceId,operationId);assert.deepEqual(guardianAfter,guardianBefore,"API restart leaves the exact Guardian identity intact");
  const guardianProcessAfter=inspectProcessIdentity(guardianBefore.pid);assert.ok(guardianProcessAfter&&guardianProcessAfter.lstart===guardianBefore.lstart&&guardianProcessAfter.pgid===guardianBefore.pgid,"same Guardian process survives API restart");
  const resumed=await mcpCall(baseUrl,token.access_token,3,"tools/call",{name:"codex_agent_status",arguments:{workspaceId,operationId}});
  assert.ok(JSON.stringify(resumed).includes("RUNNING"),"new API can query the original operation");
  const coachRecovered=await mcpCall(baseUrl,token.access_token,15,"tools/call",{name:"coach_sidecar_status",arguments:{workspaceId}});
  assert.ok(JSON.stringify(coachRecovered).includes(String(coachPort)),"new API reconnects to the same Coach instance");
  assert.equal((await fetch(`${coachUrl}/health`,{headers:{Authorization:`Bearer ${coachToken}`}})).status,200,"same Coach token remains valid after API restart");
  const eventResult=await mcpCall(baseUrl,token.access_token,4,"tools/call",{name:"codex_agent_observe",arguments:{workspaceId,operationId,cursor:0,limit:100}});
  const firstCursor=findNumber(eventResult,"nextCursor")??0;

  const duplicate=await mcpCall(baseUrl,token.access_token,5,"tools/call",{name:"codex_agent_start",arguments:{workspaceId,operationId,prompt,model:"gpt-6-luna",reasoningEffort:"low",sandbox:"workspace-write",timeoutMs:180000}});
  assert.ok(JSON.stringify(duplicate).includes(operationId),"same-ID/same-request retry is idempotent");
  const conflict=await mcpCall(baseUrl,token.access_token,6,"tools/call",{name:"codex_agent_start",arguments:{workspaceId,operationId,prompt:prompt+" conflicting request",model:"gpt-6-luna",reasoningEffort:"low",sandbox:"workspace-write",timeoutMs:180000}});
  assert.ok(JSON.stringify(conflict).includes("CODEX_OPERATION_ID_CONFLICT"),"same ID/different request is rejected");

  const deadline=Date.now()+180_000;
  while(Date.now()<deadline){
    status=await workerClient.status(operationId,workspaceId);
    if(status.state!=="RUNNING")break;
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  assert.equal(status.state,"COMPLETED",`real Codex task must complete; state=${status.state}, reason=${status.reason??"none"}`);
  const contents=readFileSync(join(workspace,"result.txt"),"utf8");
  assert.equal(contents,"DEVSPACE_RELIABILITY_002_REAL_CODEX_OK\n");
  const evidence=await mcpCall(baseUrl,token.access_token,7,"tools/call",{name:"codex_agent_evidence",arguments:{workspaceId,operationId}});
  assert.ok(JSON.stringify(evidence).includes(status.evidenceSha256??"NO_EVIDENCE_SHA"),"MCP evidence matches Worker result hash");
  assert.equal(status.evidenceSha256?.length,64);
  const finalEvents=await mcpCall(baseUrl,token.access_token,8,"tools/call",{name:"codex_agent_observe",arguments:{workspaceId,operationId,cursor:firstCursor,limit:100}});
  const nextCursor=findNumber(finalEvents,"nextCursor")??0;
  assert.ok(nextCursor>=firstCursor,"event cursor is monotonic across API restart");

  const hardExitPrompt="Wait at least 25 seconds before changing files (use a shell sleep command so the supervisor has time to be restarted). Then create exactly one file named result-hard-exit.txt in the current workspace containing exactly this single line and newline: DEVSPACE_RELIABILITY_002_API_KILL_OK. Do not create or modify any other file. Verify result-hard-exit.txt contents.";
  await mcpCall(baseUrl,token.access_token,9,"tools/call",{name:"codex_agent_start",arguments:{workspaceId,operationId:hardExitOperationId,prompt:hardExitPrompt,model:"gpt-6-luna",reasoningEffort:"low",sandbox:"workspace-write",timeoutMs:180000}});
  let hardStatus=await workerClient.status(hardExitOperationId,workspaceId);assert.equal(hardStatus.state,"RUNNING");
  const hardGuardian=evidenceStore.getGuardian(workspaceId,hardExitOperationId);assert.ok(hardGuardian,"hard-exit run Guardian identity persisted");
  const hardApiPid=api.pid!;api.kill("SIGKILL");await once(api,"exit");api=undefined;
  assert.equal((await workerClient.status(hardExitOperationId,workspaceId)).state,"RUNNING","forced API exit does not stop Worker-owned Codex");
  api=await startApi(env,port);
  const afterHardExit=await mcpCall(baseUrl,token.access_token,10,"tools/call",{name:"codex_agent_status",arguments:{workspaceId,operationId:hardExitOperationId}});
  assert.ok(JSON.stringify(afterHardExit).includes("RUNNING"),"new API recovers original task after SIGKILL");
  assert.equal((await fetch(`${coachUrl}/health`,{headers:{Authorization:`Bearer ${coachToken}`}})).status,200,"Coach remains available through API SIGKILL");
  const hardGuardianAfter=evidenceStore.getGuardian(workspaceId,hardExitOperationId);assert.deepEqual(hardGuardianAfter,hardGuardian);
  const hardGuardianProcess=inspectProcessIdentity(hardGuardian!.pid);assert.ok(hardGuardianProcess&&hardGuardianProcess.lstart===hardGuardian!.lstart&&hardGuardianProcess.pgid===hardGuardian!.pgid,"Guardian identity survives forced API exit");
  const hardCursorStart=findNumber(await mcpCall(baseUrl,token.access_token,11,"tools/call",{name:"codex_agent_observe",arguments:{workspaceId,operationId:hardExitOperationId,cursor:0,limit:100}}),"nextCursor")??0;
  const hardDeadline=Date.now()+180_000;
  while(Date.now()<hardDeadline){hardStatus=await workerClient.status(hardExitOperationId,workspaceId);if(hardStatus.state!=="RUNNING")break;await new Promise(resolve=>setTimeout(resolve,1500));}
  assert.equal(hardStatus.state,"COMPLETED",`hard-exit run completes; state=${hardStatus.state}, reason=${hardStatus.reason??"none"}`);
  const hardContents=readFileSync(join(workspace,"result-hard-exit.txt"),"utf8");assert.equal(hardContents,"DEVSPACE_RELIABILITY_002_API_KILL_OK\n");
  const hardEvidence=await mcpCall(baseUrl,token.access_token,12,"tools/call",{name:"codex_agent_evidence",arguments:{workspaceId,operationId:hardExitOperationId}});
  assert.ok(JSON.stringify(hardEvidence).includes(hardStatus.evidenceSha256??"NO_EVIDENCE_SHA"));
  const hardEvents=await mcpCall(baseUrl,token.access_token,13,"tools/call",{name:"codex_agent_observe",arguments:{workspaceId,operationId:hardExitOperationId,cursor:hardCursorStart,limit:100}});
  const hardCursorEnd=findNumber(hardEvents,"nextCursor")??0;assert.ok(hardCursorEnd>=hardCursorStart);

  const workerCrashPrompt="Wait at least 40 seconds before changing files (use a shell sleep command). Then create exactly one file named result-worker-crash.txt containing exactly this single line and newline: MUST_NOT_BE_WRITTEN. Do not modify any other file.";
  await mcpCall(baseUrl,token.access_token,17,"tools/call",{name:"codex_agent_start",arguments:{workspaceId,operationId:workerCrashOperationId,prompt:workerCrashPrompt,model:"gpt-6-luna",reasoningEffort:"low",sandbox:"workspace-write",timeoutMs:180000}});
  const workerCrashStatus=await workerClient.status(workerCrashOperationId,workspaceId);assert.equal(workerCrashStatus.state,"RUNNING");
  const workerCrashGuardian=evidenceStore.getGuardian(workspaceId,workerCrashOperationId);assert.ok(workerCrashGuardian,"Guardian identity exists before Worker crash");
  const crashedWorkerPid=workerProcess.pid!;workerProcess.kill("SIGKILL");await once(workerProcess,"exit");workerProcess=undefined;
  const guardianGoneDeadline=Date.now()+15_000;
  let guardianAssessment=assessGuardian(workerCrashGuardian);
  while(guardianAssessment.kind!=="gone"&&Date.now()<guardianGoneDeadline){await new Promise(resolve=>setTimeout(resolve,250));guardianAssessment=assessGuardian(workerCrashGuardian);}
  assert.equal(guardianAssessment.kind,"gone",`Guardian must clean its process group after Worker death; assessment=${guardianAssessment.kind}`);
  assert.equal((await getJson(`${baseUrl}/healthz`)).ok,true,"API remains available while Worker is restarting");
  workerProcess=await startWorker(env);
  const recoveryHealth=await workerClient.health();assert.equal(recoveryHealth.generation,2);assert.notEqual(recoveryHealth.pid,crashedWorkerPid);
  const quarantined=await workerClient.status(workerCrashOperationId,workspaceId);assert.equal(quarantined.state,"INTERRUPTED");assert.equal(quarantined.reason,"unknown_outcome_no_automatic_replay");
  assert.equal((await fetch(`${coachUrl}/health`,{headers:{Authorization:`Bearer ${coachToken}`}})).status,200,"Coach restarts with the exact persisted token after Worker recovery");
  const noReplay=await mcpCall(baseUrl,token.access_token,18,"tools/call",{name:"codex_agent_start",arguments:{workspaceId,operationId:workerCrashOperationId,prompt:workerCrashPrompt,model:"gpt-6-luna",reasoningEffort:"low",sandbox:"workspace-write",timeoutMs:180000}});
  assert.ok(noReplay&&typeof noReplay==="object","MCP accepts idempotent recovery lookup");
  assert.equal((await workerClient.status(workerCrashOperationId,workspaceId)).state,"INTERRUPTED","same-ID start returns durable quarantine without replay");
  assert.deepEqual(evidenceStore.getGuardian(workspaceId,workerCrashOperationId),workerCrashGuardian,"no second Guardian was created for the uncertain operation");
  assert.equal((await import("node:fs")).existsSync(join(workspace,"result-worker-crash.txt")),false,"Guardian killed the in-flight task before its requested side effect");
  const recoveredCursor=findNumber(await mcpCall(baseUrl,token.access_token,19,"tools/call",{name:"codex_agent_observe",arguments:{workspaceId,operationId:workerCrashOperationId,cursor:0,limit:100}}),"nextCursor")??0;
  assert.ok(recoveredCursor>0,"observer events remain readable after Worker crash and recovery");
  await mcpCall(baseUrl,token.access_token,16,"tools/call",{name:"stop_coach_sidecar",arguments:{workspaceId}});
  console.log(JSON.stringify({result:"REAL_CODEX_API_AND_WORKER_FAILURE_RECOVERY_PASS",normalRestart:{operationId,workerPid,apiPidBefore:apiPid,apiPidAfter:restartedApiPid,bootIdBefore:initialHealth.bootId,bootIdAfter:restartedHealth.bootId,state:status.state,evidenceSha256:status.evidenceSha256,firstCursor,nextCursor,resultSha256:createHash("sha256").update(contents).digest("hex"),exactFileWrites:1},forcedExit:{operationId:hardExitOperationId,apiPidKilled:hardApiPid,apiPidAfterRestart:api.pid,workerPid,state:hardStatus.state,evidenceSha256:hardStatus.evidenceSha256,firstCursor:hardCursorStart,nextCursor:hardCursorEnd,resultSha256:createHash("sha256").update(hardContents).digest("hex"),exactFileWrites:1},workerCrash:{operationId:workerCrashOperationId,workerPidKilled:crashedWorkerPid,workerPidRecovered:recoveryHealth.pid,generation:recoveryHealth.generation,state:quarantined.state,reason:quarantined.reason,guardianRecovery:guardianAssessment.kind,noAutomaticReplay:true,CoachRecovered:true,cursor:recoveredCursor},coach:{port:coachPort,apiRestartSurvival:true,apiSigkillSurvival:true,forgedOriginRejected:true,missingTokenRejected:true}},null,2));
} finally {
  if(api)await stopApi(api).catch(()=>{});
  provider?.close();
  evidenceStore?.close();
  if(workerClient&&workspaceId)for(const id of [operationId,hardExitOperationId,workerCrashOperationId])try{if((await workerClient.status(id,workspaceId)).state==="RUNNING")await workerClient.stop(id,workspaceId);}catch{/* task may not have been created or Worker may have been crashed */}
  await workerClient?.close();
  if(workerProcess&&workerProcess.exitCode===null&&workerProcess.signalCode===null)await stopWorker(workerProcess).catch(()=>{});
  rmSync(root,{recursive:true,force:true});
}

async function freePort():Promise<number>{
  const net=await import("node:net");const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;
}
async function startApi(childEnv:NodeJS.ProcessEnv,listenPort:number):Promise<ChildProcess>{
  const child=spawn(process.execPath,["--import","tsx",join(process.cwd(),"src/cli.ts"),"serve"],{cwd:process.cwd(),env:childEnv,stdio:["ignore","ignore","pipe"]});
  let errors="";child.stderr?.on("data",chunk=>{errors=(errors+String(chunk)).slice(-4000);});
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error(`API exited early (${child.exitCode}): ${errors}`);
    try{await getJson(`http://127.0.0.1:${listenPort}/healthz`);return child;}catch{await new Promise(resolve=>setTimeout(resolve,200));}
  }
  throw new Error(`API did not become healthy: ${errors}`);
}
async function startWorker(childEnv:NodeJS.ProcessEnv):Promise<ChildProcess>{
  const child=spawn(process.execPath,["--import","tsx",join(process.cwd(),"src/codex-worker-test-child.test.ts")],{cwd:process.cwd(),env:childEnv,stdio:["ignore","ignore","pipe"]});
  let errors="";child.stderr?.on("data",chunk=>{errors=(errors+String(chunk)).slice(-4000);});
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
    if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Worker exited early: ${errors}`);
    try{const client=new CodexWorkerClient(defaultCodexWorkerSocket(stateDir),defaultCodexWorkerKey(stateDir));await client.health();await client.close();return child;}catch{await new Promise(resolve=>setTimeout(resolve,200));}
  }
  throw new Error(`Worker did not become healthy: ${errors}`);
}
async function stopWorker(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.kill("SIGTERM");await once(child,"exit");
}
async function stopApi(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null)return;
  child.kill("SIGTERM");
  const exit=once(child,"exit");
  const timer=new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("test API failed to stop gracefully")),20_000));
  await Promise.race([exit,timer]);
}
async function getJson(url:string):Promise<Record<string,unknown>>{const response=await fetch(url);if(!response.ok)throw new Error(`HTTP ${response.status}`);return await response.json() as Record<string,unknown>;}
async function mcpCall(base:string,bearer:string,id:number,method:string,params:unknown):Promise<unknown>{
  const response=await fetch(`${base}/mcp`,{method:"POST",headers:{Authorization:`Bearer ${bearer}`,Accept:"application/json, text/event-stream","Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
  const text=await response.text();if(!response.ok)throw new Error(`MCP HTTP ${response.status}: ${text.slice(0,300)}`);
  try{return JSON.parse(text);}catch{return text.split("\n").filter(line=>line.startsWith("data:")).map(line=>JSON.parse(line.slice(5).trim())).at(-1);}
}
function findString(value:unknown,key:string):string|undefined{if(!value||typeof value!=="object")return undefined;for(const [name,child]of Object.entries(value as Record<string,unknown>)){if(name===key&&typeof child==="string")return child;const found=findString(child,key);if(found)return found;}return undefined;}
function findNumber(value:unknown,key:string):number|undefined{if(!value||typeof value!=="object")return undefined;for(const [name,child]of Object.entries(value as Record<string,unknown>)){if(name===key&&typeof child==="number")return child;const found=findNumber(child,key);if(found!==undefined)return found;}return undefined;}
