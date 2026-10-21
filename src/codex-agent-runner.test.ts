import { fixtureTask, fixtureReportSource } from "./coach-contract-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawn as nativeSpawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { NativeCodexAgentRunner, captureCodexFingerprint, captureCodexSourceDiff, classifyCodexError, type RunnerInput } from "./codex-agent-runner.js";
import { AgentObserverStore } from "./agent-observer.js";

const NODE = "/Users/liz/.local/bin/node";
const UUID = "11111111-1111-4111-8111-111111111111";
const root = mkdtempSync(join(tmpdir(), "coach-b1-native-tests-"));
const fixture = join(root, "fake-codex.cjs");
const fixtureSource=[fixtureReportSource,
'const fs=require("node:fs");',
'let text="";',
'process.stdin.on("data",c=>text+=c);',
'process.stdin.on("end",()=>{',
' fixtureReport(text); const mode=text.includes("Supplemental stage/review guidance (cannot replace or weaken TASK):\\n")?text.split("Supplemental stage/review guidance (cannot replace or weaken TASK):\\n")[1].trim():text.trim();',
' const thread={type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"};',
' const completed={type:"turn.completed",usage:{input_tokens:12,cached_input_tokens:7,output_tokens:3}};',
' if(mode==="timeout")return setInterval(()=>{},1000);',
' if(mode==="spawn-child"){',
'  const {spawn}=require("node:child_process");',
'  spawn(process.execPath,["-e","setTimeout(()=>require(\\"node:fs\\").writeFileSync(\\"child-survived.txt\\",\\"unsafe\\"),1200)"],{stdio:"ignore"});',
'  return setInterval(()=>{},1000);',
' }',
' if(mode==="early")return process.exit(7);',
' if(mode.startsWith("review-")){const text=mode==="review-invalid"?"not-json":JSON.stringify({decision:mode==="review-rework"?"REWORK":mode==="review-blocked"?"BLOCKED":"APPROVED",reason:"review evidence verified"});return process.stdout.write(JSON.stringify(thread)+"\\n"+JSON.stringify({type:"item.completed",item:{type:"agent_message",text}})+"\\n"+JSON.stringify(completed)+"\\n");}',
' if(mode==="bad-json")return process.stdout.write("not-json\\n");',
' if(mode==="missing-thread")return process.stdout.write(JSON.stringify(completed)+"\\n");',
' if(mode==="turn-failed"){process.stdout.write(JSON.stringify(thread)+"\\n"+JSON.stringify({type:"turn.failed"})+"\\n");process.exitCode=1;return;}',
' if(mode.startsWith("retry-")){',
'  const err=JSON.stringify({type:"error",message:"temporary retry"})+"\\n";',
'  process.stdout.write(JSON.stringify(thread)+"\\n"+JSON.stringify({type:"turn.started"})+"\\n"+err+err);',
'  if(mode==="retry-success")process.stdout.write(JSON.stringify(completed)+"\\n");',
'  if(mode==="retry-nonzero"){process.stdout.write(JSON.stringify(completed)+"\\n");process.exitCode=7;}',
'  if(mode==="retry-turn-failed"){process.stdout.write(JSON.stringify({type:"turn.failed"})+"\\n"+JSON.stringify(completed)+"\\n");}',
'  if(mode==="retry-after-completion"){process.stdout.write(JSON.stringify(completed)+"\\n"+err);}',
'  return;',
' }',
' if(mode==="large-valid"){const big={type:"item.completed",content:"X".repeat(350000)};return process.stdout.write(JSON.stringify(thread)+"\\n"+JSON.stringify(big)+"\\n"+JSON.stringify(completed)+"\\n");}',
' if(mode==="huge")return process.stdout.write("X".repeat(400000));',
' if(mode==="edit")fs.writeFileSync("edited-result.txt","changes-from-agent");',
' if(mode==="large-file")fs.writeFileSync("large-agent-output.txt","x".repeat(140_000));',
' if(mode==="edit-sensitive")fs.writeFileSync("credentials-placeholder.txt","changed-secret-placeholder");',
' if(mode==="restore-sensitive")fs.writeFileSync("credential-track.txt","tracked baseline secret placeholder\\n");',
' if(mode==="pathspec-injection")fs.writeFileSync(":(glob)**","MAGIC_PATH_ONLY");',
' if(mode==="restore-tracked")fs.writeFileSync("tracked.txt","base\\n");',
' if(mode==="restore-proto")fs.writeFileSync("__proto__","proto baseline\\n");',
' const lines=JSON.stringify(thread)+"\\n"+JSON.stringify(completed)+"\\n";',
' process.stdout.write(lines.slice(0,19));',
' setTimeout(()=>process.stdout.write(lines.slice(19)),5);',
'});',
].join("\n");
writeFileSync(fixture,fixtureSource,{mode:0o700});
chmodSync(fixture,0o700);
const runners:NativeCodexAgentRunner[]=[];
const stores:CoachReviewEventStore[]=[];
const fakeSpawn=(file:string,args:string[],opts:any)=>nativeSpawn(file,args,opts);
function create(locks = new JobResourceLocks(), workspace?:string) {
  const space=workspace ?? mkdtempSync(join(root,"workspace-"));
  const state=mkdtempSync(join(root,"state-"));
  const events=new CoachReviewEventStore(state);
  stores.push(events);
  const observer=new AgentObserverStore();
  const runner=new NativeCodexAgentRunner({
    events,observer,heartbeatIntervalMs:20,nodePath:NODE,codexPath:fixture,locks,spawn:fakeSpawn,
  });
  runners.push(runner);
  return {space,events,runner,locks,observer};
}
function makeInput(operationId:string,space:string,prompt="success",extra:Partial<RunnerInput>={}):RunnerInput {
  return {workspaceId:"workspace-one",workspaceRoot:space,operationId,prompt,
    model:"gpt-6-luna",reasoningEffort:"none",sandbox:"workspace-write",timeoutMs:3000,...extra,
    ...(extra.internalReview?{sandbox:"read-only",task:undefined}:{task:existsSync(space)?fixtureTask(space,extra.workspaceId??"workspace-one"):undefined})};
}
async function gates(){
  // Only categorical error metadata may cross the trust boundary. No message text.
  assert.equal(classifyCodexError({type:"error",message:"HTTP 401 secret_example_key"}),
    "authentication");
  assert.equal(classifyCodexError({type:"error",message:"unsupported model gpt-6"}),
    "model_unavailable");
  assert.equal(classifyCodexError({type:"error",message:"request rejected: 429 rate limit"}),
    "rate_or_quota");
  assert.equal(classifyCodexError({type:"error",message:"HTTP 503"}),
    "provider_5xx");
  assert.equal(classifyCodexError({type:"error",message:"stream disconnected"}),
    "transport");
  assert.equal(classifyCodexError({type:"error",message:"deadline exceeded"}),
    "timeout");
  assert.equal(classifyCodexError({type:"error",message:"private text goes here"}),
    "unclassified");
  // A real (non-Git) file-change changes the actual snapshot hash.
  const scratch=mkdtempSync(join(root,"snapshot-"));
  writeFileSync(join(scratch,"sample.txt"),"original");
  const h1=await captureCodexFingerprint(scratch);
  writeFileSync(join(scratch,"sample.txt"),"changed-content");
  const h2=await captureCodexFingerprint(scratch);
  assert.notEqual(h1.sha,h2.sha,"file content changes must change evidence hash");
  mkdirSync(join(scratch,".devspace"));
  writeFileSync(join(scratch,".devspace","tasks.yaml"),"version: 1\n");
  const adminA=await captureCodexFingerprint(scratch);
  writeFileSync(join(scratch,".devspace","tasks.yaml"),"version: 2\n");
  const adminB=await captureCodexFingerprint(scratch);
  assert.notEqual(adminA.sha,adminB.sha,"administrative manifest modification escaped fingerprint");
  // New Git repos with no initial commit must still capture real untracked
  // file bytes, not regress to hashing only the workspace path.
  const gitScratch=mkdtempSync(join(root,"unborn-git-"));
  execFileSync("/usr/bin/git",["init","-q",gitScratch],{stdio:"ignore"});
  writeFileSync(join(gitScratch,"new-feature.ts"),"export const n=1;");
  const gh1=await captureCodexFingerprint(gitScratch);
  writeFileSync(join(gitScratch,"new-feature.ts"),"export const n=2;");
  const gh2=await captureCodexFingerprint(gitScratch);
  assert.notEqual(gh1.sha,gh2.sha,"unborn Git repo edit did not change digest");

  // Real geoterrain regression: a nested, intentionally non-repository
  // workspace can sit beneath an ancestor Git repo. The snapshot/evidence
  // must be confined to the scoped child; never include the ancestor's files.
  const ancestor=mkdtempSync(join(root,"ancestor-git-"));
  execFileSync("/usr/bin/git",["init","-q",ancestor],{stdio:"ignore"});
  writeFileSync(join(ancestor,"parent-owner-private.txt"),"PARENT_OWNER_SENTINEL");
  const child=join(ancestor,"scoped-batch");
  mkdirSync(child);
  writeFileSync(join(child,"rivergraph.py"),"print('SCOPED_SOURCE_OK')\\n");
  const scopedBefore=await captureCodexFingerprint(child);
  assert.match(scopedBefore.gitSummary??"",/non-git snapshot/);
  const scopedSource=captureCodexSourceDiff(child);
  assert.ok(scopedSource.includes("rivergraph.py"));
  assert.match(scopedSource,/SCOPED_SOURCE_OK/);
  assert.doesNotMatch(scopedSource,/PARENT_OWNER_SENTINEL|parent-owner-private/);
  const scopedActual=create(undefined,child);
  const scopedRun=await scopedActual.runner.run(makeInput(
    "nested-nongit-parent-git",child,"success"));
  assert.equal(scopedRun.state,"COMPLETED",JSON.stringify(scopedRun));
  assert.ok(scopedActual.runner.getEvidence("nested-nongit-parent-git"));
  assert.equal(scopedRun.exitCode,0);
  assert.match(scopedRun.evidenceSha256??"",/^[0-9a-f]{64}$/);
  writeFileSync(join(child,".env"),"SHOULD_NOT_LEAK");
  assert.throws(()=>captureCodexSourceDiff(child),/CODEX_EVIDENCE_SENSITIVE_PATH/);
  rmSync(join(child,".env"));
  // Real geojson is larger than a safe plaintext evidence packet. Every
  // file is still represented by full per-path SHA, with no silent dropping.
  writeFileSync(join(child,"large-rivergraph.geojson"),"x".repeat(140_000));
  writeFileSync(join(child,"water-tile.bin"),Buffer.from([0,1,2,255]));
  const hashed=captureCodexSourceDiff(child);
  assert.match(hashed,/CODEX_SCOPED_NON_GIT_SHA256_MANIFEST_V1/);
  const manifest=JSON.parse(hashed.slice(hashed.indexOf("\n")+1));
  assert.equal(manifest.fullInventory,true);
  assert.equal(manifest.files.length,4);
  assert.ok(manifest.files.some((f:{path:string;bytes:number;sha256:string})=>
    f.path==="large-rivergraph.geojson" && f.bytes===140_000 &&
    /^[a-f0-9]{64}$/.test(f.sha256)));
  const mapRun=create(undefined,child);
  const verifiedMap=await mapRun.runner.run(makeInput(
    "nested-bulk-map-evidence",child,"success"));
  assert.equal(verifiedMap.state,"COMPLETED",JSON.stringify(verifiedMap));
  assert.equal(mapRun.runner.getEvidence("nested-bulk-map-evidence")?.sourceDiff,"",
    "unchanged pre-existing bulk files are covered by fingerprints, not misreported as this run's diff");
  assert.equal(mapRun.runner.getEvidence("nested-bulk-map-evidence")?.operationProofs?.length,1);

  // A dirty workspace's unrelated pre-run files must not enter a successful
  // run's diff or make an unchanged sensitive file fail evidence capture.
  const dirtyGit=mkdtempSync(join(root,"dirty-git-baseline-"));
  execFileSync("/usr/bin/git",["init","-q"],{cwd:dirtyGit});
  execFileSync("/usr/bin/git",["config","user.email","test@example.invalid"],{cwd:dirtyGit});
  execFileSync("/usr/bin/git",["config","user.name","Test"],{cwd:dirtyGit});
  writeFileSync(join(dirtyGit,"tracked.txt"),"base\n");
  writeFileSync(join(dirtyGit,"credential-track.txt"),"tracked baseline secret placeholder\n");
  writeFileSync(join(dirtyGit,":(glob)**"),"magic path baseline\n");
  writeFileSync(join(dirtyGit,"__proto__"),"proto baseline\n");
  execFileSync("/usr/bin/git",["--literal-pathspecs","add","--","tracked.txt","credential-track.txt",":(glob)**","__proto__"],{cwd:dirtyGit});
  execFileSync("/usr/bin/git",["commit","-qm","baseline"],{cwd:dirtyGit});
  writeFileSync(join(dirtyGit,"credential-track.txt"),"pre-existing tracked credential change\n");
  writeFileSync(join(dirtyGit,"credentials-placeholder.txt"),"pre-existing secret placeholder");
  writeFileSync(join(dirtyGit,"old-large.txt"),"old".repeat(50_000));
  const dirty=create(undefined,dirtyGit);
  const unchangedDirtyStatus=await dirty.runner.run(makeInput("unchanged-dirty-baseline",dirtyGit,"success"));
  assert.equal(unchangedDirtyStatus.state,"COMPLETED",JSON.stringify(unchangedDirtyStatus));
  assert.match(dirty.runner.getEvidence("unchanged-dirty-baseline")?.sourceDiff??"",/fixture-test-output/);
  assert.doesNotMatch(dirty.runner.getEvidence("unchanged-dirty-baseline")?.sourceDiff??"",/credential-track|credentials-placeholder|old-large/);
  const dirtyStatus=await dirty.runner.run(makeInput("dirty-worktree-clean-evidence",dirtyGit,"edit"));
  assert.equal(dirtyStatus.state,"COMPLETED",JSON.stringify(dirtyStatus));
  assert.equal(dirtyStatus.reviewState,"READY_FOR_GPT_REVIEW");
  const dirtyEvidence=dirty.runner.getEvidence("dirty-worktree-clean-evidence");
  assert.match(dirtyEvidence?.sourceDiff??"",/edited-result\.txt/);
  assert.doesNotMatch(dirtyEvidence?.sourceDiff??"",/credentials-placeholder|old-large\.txt|pre-existing secret/);
  assert.doesNotMatch(dirtyEvidence?.sourceDiff??"",/credential-track\.txt|pre-existing tracked/);

  const pathspec=create(undefined,dirtyGit);
  const pathspecStatus=await pathspec.runner.run(makeInput("literal-pathspec-evidence",dirtyGit,"pathspec-injection"));
  assert.equal(pathspecStatus.state,"COMPLETED",JSON.stringify(pathspecStatus));
  const pathspecEvidence=pathspec.runner.getEvidence("literal-pathspec-evidence")?.sourceDiff??"";
  assert.match(pathspecEvidence,/\:\(glob\)\*\*/);
  assert.match(pathspecEvidence,/MAGIC_PATH_ONLY/);
  assert.doesNotMatch(pathspecEvidence,/credential-track\.txt|pre-existing tracked/,
    "Git pathspec magic must not expand the diff into unrelated sensitive workspace changes");

  const largeOutput=create(undefined,dirtyGit);
  const largeStatus=await largeOutput.runner.run(makeInput("oversized-source-manifest",dirtyGit,"large-file"));
  assert.equal(largeStatus.state,"COMPLETED",JSON.stringify(largeStatus));
  const largeEvidence=largeOutput.runner.getEvidence("oversized-source-manifest");
  assert.match(largeEvidence?.sourceDiff??"",/CODEX_SCOPED_GIT_SHA256_MANIFEST_V1/);
  assert.match(largeEvidence?.sourceDiff??"",/large-agent-output\.txt/);
  assert.doesNotMatch(largeEvidence?.sourceDiff??"",/x{100}/);

  const sensitive=create(undefined,dirtyGit);
  const sensitiveStatus=await sensitive.runner.run(makeInput("changed-sensitive-file",dirtyGit,"edit-sensitive"));
  assert.equal(sensitiveStatus.state,"FAILED");
  assert.equal(sensitiveStatus.executionCompleted,true);
  assert.equal(sensitiveStatus.evidenceState,"FAILED");
  assert.equal(sensitiveStatus.failureStage,"evidence");
  assert.equal(sensitiveStatus.reason,"CODEX_EVIDENCE_SENSITIVE_PATH");
  assert.equal(sensitive.events.listPending("workspace-one").pending_count,0);

  const restored=create(undefined,dirtyGit);
  const restoredSensitiveStatus=await restored.runner.run(makeInput("restored-sensitive-baseline",dirtyGit,"restore-sensitive"));
  assert.equal(restoredSensitiveStatus.state,"FAILED");
  assert.equal(restoredSensitiveStatus.executionCompleted,true);
  assert.equal(restoredSensitiveStatus.evidenceState,"FAILED");
  assert.equal(restoredSensitiveStatus.failureStage,"evidence");
  assert.equal(restoredSensitiveStatus.reason,"CODEX_EVIDENCE_SENSITIVE_PATH",
    "restoring a pre-run tracked sensitive edit to HEAD must still be detected");

  writeFileSync(join(dirtyGit,"tracked.txt"),"pre-run ordinary dirty change\n");
  const restoredOrdinary=create(undefined,dirtyGit);
  const restoredOrdinaryStatus=await restoredOrdinary.runner.run(makeInput("restored-ordinary-baseline",dirtyGit,"restore-tracked"));
  assert.equal(restoredOrdinaryStatus.state,"COMPLETED",JSON.stringify(restoredOrdinaryStatus));
  const restoredManifest=restoredOrdinary.runner.getEvidence("restored-ordinary-baseline")?.sourceDiff??"";
  assert.match(restoredManifest,/CODEX_SCOPED_GIT_SHA256_MANIFEST_V1/);
  const restoredFile=JSON.parse(restoredManifest.slice(restoredManifest.indexOf("\n")+1)).files
    .find((f:{path:string})=>f.path==="tracked.txt");
  assert.equal(restoredFile.state,"file");
  assert.equal(restoredFile.bytes,5);
  assert.equal(restoredFile.afterSha256,createHash("sha256").update("base\n").digest("hex"));

  writeFileSync(join(dirtyGit,"__proto__"),"pre-run proto dirty change\n");
  const restoredProto=create(undefined,dirtyGit);
  const restoredProtoStatus=await restoredProto.runner.run(makeInput("restored-proto-baseline",dirtyGit,"restore-proto"));
  assert.equal(restoredProtoStatus.state,"COMPLETED",JSON.stringify(restoredProtoStatus));
  const protoManifest=restoredProto.runner.getEvidence("restored-proto-baseline")?.sourceDiff??"";
  assert.match(protoManifest,/CODEX_SCOPED_GIT_SHA256_MANIFEST_V1/);
  const protoFile=JSON.parse(protoManifest.slice(protoManifest.indexOf("\n")+1)).files
    .find((f:{path:string})=>f.path==="__proto__");
  assert.equal(protoFile.state,"file");
  assert.equal(protoFile.afterSha256,createHash("sha256").update("proto baseline\n").digest("hex"));

  const a=create();
  const input=makeInput("successful-edit",a.space,"edit");
  const first=await a.runner.run(input);
  assert.equal(first.state,"COMPLETED",JSON.stringify(first));
  assert.equal(first.evidenceState,"VERIFIED");
  assert.equal(first.threadId,UUID);
  assert.ok(first.evidenceSha256?.match(/^[0-9a-f]{64}$/));
  assert.ok(existsSync(join(a.space,"edited-result.txt")));
  assert.equal(a.events.listPending("workspace-one").pending_count,1);
  const evidence=a.runner.getEvidence("successful-edit");
  assert.ok(evidence);
  assert.notEqual(evidence.inputFingerprint,evidence.finalFingerprint);
  assert.equal(evidence.evidenceSha256,first.evidenceSha256);
  assert.ok(evidence.eventTypes.includes("turn.completed"));
  assert.equal((await a.runner.run(input)).eventId,first.eventId);
  assert.equal(a.events.listPending("workspace-one").pending_count,1);
  assert.throws(()=>a.runner.run({...input,prompt:"different"}),/CODEX_OPERATION_ID_CONFLICT/);
  assert.equal(a.runner.status("successful-edit").state,"COMPLETED");
  assert.equal(a.locks.snapshot().length,0);

  // A valid Codex transcript above the old 256 KiB cap must retain completion evidence.
  const verbose=create();
  const longRun=await verbose.runner.run(makeInput("large-valid-stream",verbose.space,"large-valid"));
  assert.equal(longRun.state,"COMPLETED",JSON.stringify(longRun));
  const longProof=verbose.events.getEvidence("workspace-one","large-valid-stream") as {stdoutSha256:string;eventTypes:string[]}|undefined;
  assert.match(longProof?.stdoutSha256??"",/^[0-9a-f]{64}$/);
  assert.ok(longProof?.eventTypes.includes("turn.completed"));

  // A real-world Codex session may retry several transient errors and STILL
  // finish turn.completed with exitCode 0 (both Luna and Sol did so).
  const retryRecovered=create();
  const recoveredStatus=await retryRecovered.runner.run(makeInput(
    "recoverable-transport-retry",retryRecovered.space,"retry-success"));
  assert.equal(recoveredStatus.state,"COMPLETED",JSON.stringify(recoveredStatus));
  assert.equal(recoveredStatus.exitCode,0);
  assert.equal(recoveredStatus.errorEventCount,2);
  assert.equal(recoveredStatus.lastErrorCategory,"unclassified");
  assert.equal(JSON.stringify(recoveredStatus).includes("temporary retry"),false);
  const recoveredEvidence=retryRecovered.events.getEvidence("workspace-one","recoverable-transport-retry") as {eventTypes:string[]}|undefined;
  assert.ok(recoveredEvidence,"recovered run did not persist immutable evidence");
  assert.ok(recoveredEvidence.eventTypes.includes("error"),"retry events must remain auditable");
  assert.ok(recoveredEvidence.eventTypes.includes("turn.completed"));
  const retryEvents=retryRecovered.observer.read("workspace-one",0,50).events;
  assert.equal(retryEvents.filter(x=>x.phase==="error").length,2);
  assert.ok(retryEvents.filter(x=>x.phase==="error").every(x=>x.status==="RETRYING"));
  assert.ok(retryEvents.some(x=>x.phase==="runner.finalized" && x.status==="COMPLETED"));

  // No terminal failures, early termination, output corruption, or timeout
  // are permitted to pass merely because some success-looking event exists.
  for(const mode of ["turn-failed","early","missing-thread","bad-json","huge","timeout",
    "retry-no-completion","retry-nonzero","retry-turn-failed","retry-after-completion"]){
    const item=create();
    const failed=await item.runner.run(makeInput("fail-"+mode,item.space,mode));
    assert.ok(["FAILED","STOPPED"].includes(failed.state),
      mode+" returned "+JSON.stringify(failed));
    assert.equal(item.events.listPending("workspace-one").pending_count,0,mode);
    assert.equal(item.locks.snapshot().length,0,mode);
  }
  const cancelled=create();
  const pending=cancelled.runner.run(makeInput("cancel-operation",cancelled.space,"timeout"));
  await new Promise(resolve=>setTimeout(resolve,65));
  const runningStatus=cancelled.runner.status("cancel-operation");
  assert.equal(runningStatus.state,"RUNNING");
  assert.equal(runningStatus.activeSelection?.model,"gpt-6-luna");
  assert.equal(runningStatus.configRevision,0);
  assert.ok(cancelled.observer.read("workspace-one",0,100).events.some(
    e=>e.phase==="runner.heartbeat"),"no real running-loop heartbeat was observed");
  const revised=cancelled.runner.queueNextSelection({
    workspaceId:"workspace-one",operationId:"cancel-operation",expectedRevision:0,
    selection:{model:"gpt-6.1-sol",reasoningEffort:"high"},
  });
  assert.equal(revised.revision,1);
  assert.equal(cancelled.runner.status("cancel-operation").nextSelection?.model,"gpt-6.1-sol");
  assert.equal(cancelled.runner.status("cancel-operation").activeSelection?.model,"gpt-6-luna");
  assert.throws(()=>cancelled.runner.queueNextSelection({
    workspaceId:"workspace-one",operationId:"cancel-operation",expectedRevision:0,
    selection:{model:"gpt-6-luna",reasoningEffort:"medium"},
  }),/STALE_REVISION/);
  assert.throws(()=>cancelled.runner.queueNextSelection({
    workspaceId:"other-workspace",operationId:"cancel-operation",expectedRevision:1,
    selection:{model:"gpt-6-luna",reasoningEffort:"medium"},
  }),/WORKSPACE_MISMATCH/);
  assert.equal(await cancelled.runner.stop("cancel-operation"),true);
  assert.equal((await pending).state,"STOPPED");
  assert.equal(cancelled.events.listPending("workspace-one").pending_count,0);
  assert.equal(cancelled.locks.snapshot().length,0);

  // A grandchild inherited from Codex must be killed along with its parent.
  // A parent-only SIGTERM would leave a delayed child write behind.
  const descendants=create();
  const childRun=descendants.runner.run(makeInput("descendant-stop",descendants.space,"spawn-child"));
  await new Promise(resolve=>setTimeout(resolve,230));
  assert.equal(await descendants.runner.stop("descendant-stop"),true);
  assert.equal((await childRun).state,"STOPPED");
  await new Promise(resolve=>setTimeout(resolve,1330));
  assert.equal(existsSync(join(descendants.space,"child-survived.txt")),false,
    "agent grandchild survived process-group cancellation");
  assert.equal(descendants.locks.snapshot().length,0);

  // Rework rechecks the parent fingerprint AFTER acquiring its workspace
  // lease and BEFORE spawning any process, closing an edit/launch race.
  const stale=create();
  let launched=false;
  const staleRunner=new NativeCodexAgentRunner({events:stale.events,
    nodePath:NODE,codexPath:fixture,locks:new JobResourceLocks(),
    spawn:(file,args,opts)=>{launched=true;return nativeSpawn(file,args,opts);},
    fingerprint:async()=>({sha:"b".repeat(64),gitSummary:null}),
  });
  runners.push(staleRunner);
  const blocked=await staleRunner.run(makeInput("rework-race",stale.space,"success",{
    parentOperationId:"previous-rework",sessionId:UUID,expectedFingerprint:"a".repeat(64),
  }));
  assert.equal(blocked.state,"FAILED");
  assert.match(blocked.reason??"",/STALE_WORKTREE/);
  assert.equal(launched,false);
  assert.equal(stale.events.listPending("workspace-one").pending_count,0);

  // Same-workspace conflict, and retry with a NEW operation id after unlock.
  const locks=new JobResourceLocks();
  const firstOwner=create(locks);
  const secondOwner=create(locks,firstOwner.space);
  const running=firstOwner.runner.run(makeInput("first-lock",firstOwner.space,"timeout"));
  await new Promise(resolve=>setTimeout(resolve,80));
  const denied=await secondOwner.runner.run(makeInput("second-lock",secondOwner.space,"success"));
  assert.equal(denied.state,"FAILED");
  assert.match(denied.reason ?? "",/JOB_RESOURCE_BUSY/);
  await firstOwner.runner.stop("first-lock");
  await running;
  assert.equal(locks.snapshot().length,0);
  const recovered=await secondOwner.runner.run(makeInput("after-lock",secondOwner.space,"success"));
  assert.equal(recovered.state,"COMPLETED");
  assert.equal(secondOwner.events.listPending("workspace-one").pending_count,1);

  const independentLocks=new JobResourceLocks();
  const p=create(independentLocks),q=create(independentLocks);
  const [pa,qa]=await Promise.all([
    p.runner.run(makeInput("parallel-A",p.space,"success")),
    q.runner.run(makeInput("parallel-B",q.space,"success",{workspaceId:"workspace-two"})),
  ]);
  assert.equal(pa.state,"COMPLETED");assert.equal(qa.state,"COMPLETED");
  assert.equal(p.events.listPending("workspace-one").pending_count,1);
  assert.equal(q.events.listPending("workspace-two").pending_count,1);

  const durableRetry=create();
  const firstResult=await durableRetry.runner.run(makeInput("same-after-restart",durableRetry.space,"success"));
  assert.equal(firstResult.state,"COMPLETED");
  let relaunches=0;
  const restartedRunner=new NativeCodexAgentRunner({events:durableRetry.events,nodePath:NODE,codexPath:fixture,
    spawn:(file,args,opts)=>{relaunches++;return nativeSpawn(file,args,opts);}});
  runners.push(restartedRunner);
  assert.equal(restartedRunner.start(makeInput("same-after-restart",durableRetry.space,"success")).state,"COMPLETED");
  assert.equal(relaunches,0,"a durable duplicate must return its receipt without a second process");
  assert.throws(()=>restartedRunner.start(makeInput("same-after-restart",durableRetry.space,"different prompt")),
    /DURABLE_IDENTITY_CONFLICT/);

  // Web GPT's persisted decision must supersede the runner's in-memory
  // READY_FOR_GPT_REVIEW, including after a process restart.
  const webReview=create();
  const webOperation="external-webgpt-review-status";
  const webDone=await webReview.runner.run(makeInput(webOperation,webReview.space,"success"));
  assert.equal(webDone.reviewState,"READY_FOR_GPT_REVIEW");
  assert.ok(webDone.eventId && webDone.evidenceSha256);
  assert.equal(webReview.runner.status(webOperation,"workspace-one").reviewState,
    "READY_FOR_GPT_REVIEW");
  assert.throws(()=>webReview.runner.status(webOperation,"other-workspace"),
    /CODEX_WORKSPACE_MISMATCH/);
  const webReceipt=webReview.events.submitReview({workspaceId:"workspace-one",
    eventId:webDone.eventId!,decision:"BLOCKED",evidenceSha256:webDone.evidenceSha256!});
  assert.equal(webReceipt.decision,"BLOCKED");
  assert.equal(webReview.runner.status(webOperation,"workspace-one").reviewState,
    "REVIEW_BLOCKED","persisted decision must invalidate cached runner review state");
  let accidentalRestart=0;
  const recoveredWebRunner=new NativeCodexAgentRunner({
    events:webReview.events,nodePath:NODE,codexPath:fixture,
    spawn:(file,args,opts)=>{accidentalRestart++;return nativeSpawn(file,args,opts);}
  });
  runners.push(recoveredWebRunner);
  assert.equal(recoveredWebRunner.status(webOperation,"workspace-one").reviewState,
    "REVIEW_BLOCKED","after restart, the decision must come from durable SQLite");
  assert.equal(accidentalRestart,0);

  const reviewState=mkdtempSync(join(root,"review-state-"));
  const reviewWorkspace=mkdtempSync(join(root,"review-workspace-"));
  const reviewStore=new CoachReviewEventStore(reviewState);
  const reviewRunner=new NativeCodexAgentRunner({events:reviewStore,nodePath:NODE,codexPath:fixture,spawn:fakeSpawn});
  runners.push(reviewRunner);
  const reviewResult=await reviewRunner.run(makeInput("persisted-review",reviewWorkspace,"review-approved",{internalReview:true}));
  assert.equal(reviewResult.state,"COMPLETED");
  assert.deepEqual(reviewRunner.getReviewRecommendation("persisted-review","workspace-one"),
    {decision:"APPROVED",reason:"review evidence verified"});
  assert.equal(reviewResult.reviewState,"APPROVED");
  const blockedReview=await reviewRunner.run(makeInput("persisted-blocked-review",reviewWorkspace,
    "review-blocked",{internalReview:true}));
  assert.equal(blockedReview.state,"COMPLETED");
  assert.equal(blockedReview.executionCompleted,true);
  assert.equal(blockedReview.evidenceState,"VERIFIED");
  assert.equal(blockedReview.reviewState,"REVIEW_BLOCKED");
  const invalidReview=await reviewRunner.run(makeInput("persisted-invalid-review",reviewWorkspace,
    "review-invalid",{internalReview:true}));
  assert.equal(invalidReview.state,"COMPLETED");
  assert.equal(invalidReview.executionCompleted,true);
  assert.equal(invalidReview.evidenceState,"VERIFIED");
  assert.equal(invalidReview.reviewState,"REVIEW_BLOCKED",
    "missing or invalid internal review verdict must stay blocked after execution completes");
  await reviewRunner.close();reviewStore.close();
  stores.splice(stores.indexOf(reviewStore),1);
  const recoveredReviewStore=new CoachReviewEventStore(reviewState);stores.push(recoveredReviewStore);
  const recoveredReviewRunner=new NativeCodexAgentRunner({events:recoveredReviewStore,nodePath:NODE,codexPath:fixture,spawn:fakeSpawn});
  runners.push(recoveredReviewRunner);
  assert.deepEqual(recoveredReviewRunner.getReviewRecommendation("persisted-review","workspace-one"),
    {decision:"APPROVED",reason:"review evidence verified"},"Worker restart restores the bounded decision from SQLite");

  const invalid=create();
  for(const [name,extra] of [
    ["bad-id",{operationId:"bad op"}],
    ["bad-prompt",{prompt:"x".repeat(10001)}],
    ["bad-model",{model:"arbitrary-agent"}],
    ["bad-session",{sessionId:"not-a-uuid"}],
    ["bad-timeout",{timeoutMs:100}],
    ["bad-sandbox",{sandbox:"danger-full-access"}],
    ["bad-workspace",{workspaceRoot:join(root,"not-a-directory")}],
  ] as Array<[string,Partial<RunnerInput>]>){
    assert.throws(()=>invalid.runner.run(makeInput(name,invalid.space,"success",extra)));
  }
  console.log("COACH006B1_NATIVE_CODEX_RUNNER_CORE_GATES_PASS");
}
try { await gates(); }
finally {
  await Promise.all(runners.map(async r=>r.close()));
  stores.forEach(s=>s.close());
  rmSync(root,{recursive:true,force:true});
}
