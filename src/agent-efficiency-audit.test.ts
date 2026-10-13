import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeAgentEfficiency, stableInputHash } from "./agent-efficiency-audit.js";
import { normalizeCodexNativeEvent, AgentObserverStore } from "./agent-observer.js";

const base={
  workspaceId:"ws-audit", operationId:"op-audit", status:"COMPLETED",
  start:"2026-10-13T00:00:00.000Z", finish:"2026-10-13T00:00:02.000Z",
  tokenUsage:{input_tokens:4,output_tokens:2,cached_input_tokens:1,unknown_key:123},
  sourceChange:true,
};
function project(type:string,id:string,command="echo SECRET_DO_NOT_EXPOSE"){
  return normalizeCodexNativeEvent(base.workspaceId,base.operationId,{
    type,item:{type:"command_execution",id,command,status:"completed"}
  });
}
function trace(events: ReturnType<typeof project>[]) {
  return events.filter((x):x is NonNullable<typeof x>=>Boolean(x))
    .map((x,i)=>({id:String(i+10),at:base.start,...x}));
}
test("native item id pairs distinct event cursor IDs; no false unfinished",()=>{
  const events=trace([project("item.started","item_1"),project("item.completed","item_1")]);
  const a=analyzeAgentEfficiency({...base,trace:events});
  assert.equal(a.elapsedMs,2000);
  assert.equal(a.confirmedToolStarts,1);
  assert.equal(a.confirmedToolCompletions,1);
  assert.equal(a.observations.some(x=>x.id==="unfinished-steps"),false);
  assert.equal(a.sourceChange,"yes");
  assert.deepEqual(a.tokenUsage,{input_tokens:4,cached_input_tokens:1,output_tokens:2});
  assert.equal(a.dataCoverage.complete,false,"lossy evidence is never fully explanatory");
  assert.ok(a.dataCoverage.missingEvidence.includes("agent_intent_unavailable"));
  const json=JSON.stringify(a);
  assert.doesNotMatch(json,/SECRET_DO_NOT_EXPOSE|\.ssh|chain.of.thought/);
  assert.equal(a.evidenceTimeline.length,2);
});
test("a genuine unmatched native tool start is reported",()=>{
  const a=analyzeAgentEfficiency({...base,trace:trace([project("item.started","item_2")])});
  assert.equal(a.confirmedToolStarts,1);
  assert.equal(a.confirmedToolCompletions,0);
  assert.equal(a.observations.find(x=>x.id==="unfinished-steps")?.evidenceEventIds[0],"10");
});
test("duplicate input is only a low-confidence observation with evidence",()=>{
  const events=trace([
    project("item.started","tool_1","node --test focused.test"),
    project("item.completed","tool_1","node --test focused.test"),
    project("item.started","tool_2","node --test focused.test"),
    project("item.completed","tool_2","node --test focused.test"),
  ]);
  const a=analyzeAgentEfficiency({...base,trace:events});
  const finding=a.observations.find(x=>x.id==="possibly-repeated-input");
  assert.ok(finding);
  assert.equal(finding.confidence,"low");
  assert.deepEqual(finding.evidenceEventIds,["10","12"]);
  assert.equal(a.confirmedToolCompletions,2);
});
test("observed file-change boundary prevents false identical-input flag",()=>{
  const file=normalizeCodexNativeEvent(base.workspaceId,base.operationId,{
    type:"item.completed",item:{id:"patch_1",type:"file_change",status:"completed"}
  });
  const events=trace([
    project("item.started","tool_1","node --test focused.test"),
    project("item.completed","tool_1","node --test focused.test"),
    file,
    project("item.started","tool_2","node --test focused.test"),
    project("item.completed","tool_2","node --test focused.test"),
  ]);
  const a=analyzeAgentEfficiency({...base,trace:events});
  assert.equal(a.observations.some(x=>x.id==="possibly-repeated-input"),false);
});
test("failure, redacted output, missing evidence, and 512-event truncation",()=>{
  const bad=analyzeAgentEfficiency({...base,status:"FAILED",tokenUsage:undefined,sourceChange:undefined,trace:[]});
  assert.equal(bad.observations[0].id,"unfinished-task");
  assert.ok(bad.dataCoverage.missingEvidence.includes("native_trace"));
  const long=Array.from({length:513},(_,i)=>({
    id:String(i),kind:"status",at:base.start,phase:"turn.started"
  }));
  const cut=analyzeAgentEfficiency({...base,trace:long});
  assert.equal(cut.dataCoverage.truncated,true);
  assert.equal(cut.dataCoverage.traceEvents,512);
  assert.equal(cut.observations.some(x=>x.id==="partial-trace"),true);
  assert.ok(cut.dataCoverage.missingEvidence.includes("trace_truncated"));
});
test("browser live projection drops private action identity, hash and raw input",()=>{
  const observer=new AgentObserverStore();
  const event=project("item.started","item_123","ssh -i /home/private/id_rsa");
  assert.ok(event);
  observer.emit(event);
  const publicData=JSON.stringify(observer.readGlobal().events);
  assert.doesNotMatch(publicData,/ssh|private|item_123|inputHash|actionId|id_rsa/);
  assert.equal(stableInputHash({command:"secret"}).length,64);
});
