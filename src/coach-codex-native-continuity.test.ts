import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
 readNativeCodexThread,findCodexRollout,openNativeCodexThread,verifyThreadWriterOwnership,type ProcessInfo,
} from "./coach-codex-native-continuity.js";

const uid=process.getuid?.()??501;
const base=mkdtempSync(join(tmpdir(),"codex-native-history-"));
const root=join(base,"workspace"),fake=join(base,"different"),home=join(base,".codex");
const folder=join(home,"sessions","2026","10","24");
const idA="01a16cef-0e26-7660-99f9-03caac52cfdf";
const idB="01a16cf8-9102-7102-8fc9-9b925b1f1a21";
mkdirSync(root,{recursive:true});mkdirSync(fake);mkdirSync(folder,{recursive:true,mode:0o700});

const fileA=join(folder,"rollout-2026-10-24T16-02-48-"+idA+".jsonl");
const fileB=join(folder,"rollout-2026-10-24T16-13-11-"+idB+".jsonl");
const write=(file:string,records:unknown[],trailingNewline=true)=>writeFileSync(file,records.map(r=>JSON.stringify(r)).join("\n")+(trailingNewline?"\n":""),{mode:0o600});

/**
 * Fixtures reproduce the real rollout shapes observed in threads A and B:
 * session_meta with session_id/source=vscode/cwd/runtime_workspace_roots,
 * response_item developer/user/assistant messages (including synthesized
 * AGENTS.md and environment_context user records), and event_msg
 * task_started/task_complete plus item_completed UserMessage/AgentMessage
 * records whose content items use "text"/"Text" type tags.
 */
const metaA={timestamp:"2026-10-24T08:02:48.977Z",ordinal:0,type:"session_meta",payload:{
 creator_user_id:"user-5ydQq88g63kBXxkMv42zrVIU",creator_account_id:"4ec1eedd-1d42-44da-a77a-1756650b5503",
 session_id:idA,id:idA,timestamp:"2026-10-24T08:02:48.659Z",cwd:root,runtime_workspace_roots:[root],
 originator:"devspace-coach-readonly",cli_version:"0.164.0",source:"vscode",model_provider:"openai"}};
const developerRecord={type:"response_item",payload:{type:"message",id:"msg_dev_1",role:"developer",
 content:[{type:"input_text",text:"You are Codex, an agent based on GPT-6."}]}};
const agentsRecord={type:"response_item",payload:{type:"message",id:"msg_user_agents",role:"user",
 content:[{type:"input_text",text:"# AGENTS.md instructions for "+root+"\n\n<INSTRUCTIONS>\n# DevSpace"}]}};
const envRecord={type:"response_item",payload:{type:"message",id:"msg_user_env",role:"user",
 content:[{type:"input_text",text:"<environment_context>\n  <current_date>2026-10-24</current_date>\n</environment_context>"}]}};
const responseUser=(id:string,text:string)=>({type:"response_item",payload:{type:"message",id,role:"user",content:[{type:"input_text",text}]}});
const responseAssistant=(id:string,text:string)=>({type:"response_item",payload:{type:"message",status:"completed",id,role:"assistant",content:[{type:"output_text",text}]}});
const userItem=(turn:string,id:string,text:string)=>({type:"event_msg",payload:{type:"item_completed",thread_id:idA,turn_id:turn,item:{type:"UserMessage",id,content:[{type:"text",text}]}}});
const agentItem=(turn:string,id:string,text:string)=>({type:"event_msg",payload:{type:"item_completed",thread_id:idA,turn_id:turn,item:{type:"AgentMessage",id,content:[{type:"Text",text}],phase:"final_answer"}}});
const taskStarted=(turn:string)=>({type:"event_msg",payload:{type:"task_started",turn_id:turn,root_turn_id:turn,
 turn_attribution:{turn_id:turn,turn_trigger:null,parent_turn_id:null,initiating_agent_path:null,root_turn_id:turn},started_at:1792828990}});
const taskComplete=(turn:string)=>({type:"event_msg",payload:{type:"task_complete",turn_id:turn,root_turn_id:turn,
 last_agent_message:"ok",started_at:1792828990,completed_at:1792828994}});
const reasoning=(turn:string)=>({type:"event_msg",payload:{type:"item_completed",item:{type:"Reasoning",id:"rs_1",summary_text:[],raw_content:[]},turn_id:turn}});
const noise=[
 {type:"event_msg",payload:{type:"thread_settings_applied",thread_id:idA,thread_settings:{model:"gpt-6-luna",cwd:root}}},
 {type:"response_item",payload:{type:"reasoning",id:"rs_0",summary:[]}},
 {type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{input_tokens:10}}}},
 {type:"token_usage_record",payload:{input_tokens:10}},
 {type:"turn_context",payload:{turn_id:"t0",root_turn_id:"t0",cwd:root}},
];
const t1="01a16cef-65fa-7161-a6bb-c1b9eb0dd03d",t2="01a16cf1-a80d-7200-9c2b-d9fb52289a93",t3="01a16cfd-bfbd-7540-9745-69d82f29c398";
const userText1="Web GPT → ChatGPT App Codex 原生共享对话握手检查：这是 Web GPT 通过 DevSpace codex_app_thread_send 发送的消息，非 Codex CLI。";
const replyText1="DEVSPACE_LONGCALL_APP_ACK\n\n当前工作目录：`"+root+"`。";
const userText2="Authorized frozen development TASK: .devspace/coach/tasks/DEVSPACE-LONG-CALL-RESILIENCE-001";
const replyText2="已核实冻结 TASK 哈希一致。dirty diff 正好是 8 个 tracked 文件。";
const userText3="Authorized frozen development TASK: .devspace/coach/tasks/DEVSPACE-LONG-CALL-RESILIENCE-001 (REWORK)";
const replyText3="收到 R1 的 REWORK。我会先复核 frozen TASK 哈希和当前未提交 diff。";
write(fileA,[metaA,...noise,
 developerRecord,agentsRecord,envRecord,
 taskStarted(t1),userItem(t1,"01a16cef-6d07-7351-8529-89b07fa998f3",userText1),
 responseAssistant("msg_0452a6daf2bbb5e1016adc664228888194b9e18df7cb7b306d",replyText1),
 agentItem(t1,"msg_0452a6daf2bbb5e1016adc664228888194b9e18df7cb7b306d",replyText1),
 responseUser("msg_01a16cf1_user",userText2),reasoning(t1),taskComplete(t1),
 taskStarted(t2),userItem(t2,"01a16cf1_user_item",userText2),agentItem(t2,"msg_01a16cf1_agent",replyText2),
 {type:"compacted",payload:{message:"",replacement_history:[{type:"additional_tools",role:"developer",tools:[]}]}},
 taskComplete(t2),
 taskStarted(t3),userItem(t3,"01a16cfd_user_item",userText3),agentItem(t3,"msg_01a16cfd_agent",replyText3),taskComplete(t3),
] as any[]);

/* B mirrors thread B: a third started turn never completed at the snapshot,
   so its status must be UNKNOWN, never IDLE. */
const metaB={...metaA,payload:{...metaA.payload,session_id:idB,id:idB,cwd:root,timestamp:"2026-10-24T08:13:11.857Z"}};
const b1="01a16cf9-1475-7260-9097-c3a9e31035f9",b2="01a16d48-b782-7600-b3cd-17b19046f880",b3="01a16d60-8be5-7cf3-b870-43e9931e9f80";
write(fileB,[metaB,
 taskStarted(b1),{type:"event_msg",payload:{type:"item_completed",turn_id:b1,item:{type:"UserMessage",id:"b1u",content:[{type:"text",text:"Authorized frozen development TASK: .devspace/coach/tasks/TRIAREGNA-SIEGE-S1"}]}}},
 {type:"event_msg",payload:{type:"item_completed",turn_id:b1,item:{type:"AgentMessage",id:"b1a",content:[{type:"Text",text:"我先核对冻结合同的 SHA 和工作树状态。"}]}}},
 taskComplete(b1),
 taskStarted(b2),{type:"event_msg",payload:{type:"item_completed",turn_id:b2,item:{type:"UserMessage",id:"b2u",content:[{type:"text",text:"Authorized frozen development TASK: .devspace/coach/tasks/TRIAREGNA-SIEGE-S1 (REWORK)"}]}}},
 {type:"event_msg",payload:{type:"item_completed",turn_id:b2,item:{type:"AgentMessage",id:"b2a",content:[{type:"Text",text:"当前状态已核实：HEAD 是 Web GPT 的保全审核提交。"}]}}},
 taskComplete(b2),
 taskStarted(b3),{type:"event_msg",payload:{type:"item_completed",turn_id:b3,item:{type:"UserMessage",id:"b3u",content:[{type:"text",text:"Authorized frozen development TASK: .devspace/coach/tasks/TRIAREGNA-SIEGE-S2"}]}}},
 {type:"event_msg",payload:{type:"item_completed",turn_id:b3,item:{type:"AgentMessage",id:"b3a",content:[{type:"Text",text:"已收到 S1 的独立批准和 S2 授权。"}]}}},
] as any[]);

/* Legacy rollout: only model-visible response_item messages, no item/task records. */
const legacyFile=join(folder,"rollout-2026-10-24T15-00-00-01a16969-677a-7033-9acd-a77503a7aeaf.jsonl");
write(legacyFile,[{type:"session_meta",payload:{id:"01a16969-677a-7033-9acd-a77503a7aeaf",source:"vscode",cwd:root}},
 agentsRecord,envRecord,responseUser("legacy_u1","Hello legacy"),responseAssistant("legacy_a1","Legacy reply")] as any[]);

let passed=0;
function check(name:string,fn:()=>void){fn();passed++;process.stdout.write("PASS "+name+"\n");}
try{
 check("real-A-shape: user/assistant turns, idle, no synthetic preamble",()=>{
  const result=readNativeCodexThread({threadId:idA,root,codexHome:home,limit:10});
  assert.equal(result.thread.threadId,idA);
  assert.equal(result.thread.source,"vscode");
  assert.equal(result.thread.cwd,root);
  assert.equal(result.thread.turns,3);
  assert.equal(result.thread.status,"idle");
  assert.equal(result.origin,"local_rollout");
  assert.equal(result.historyAvailable,true);
  assert.deepEqual(result.messages,[
   {role:"user",text:userText1},{role:"assistant",text:replyText1},
   {role:"user",text:userText2},{role:"assistant",text:replyText2},
   {role:"user",text:userText3},{role:"assistant",text:replyText3},
  ]);
  assert.ok(!JSON.stringify(result.messages).includes("AGENTS.md"));
  assert.ok(!JSON.stringify(result.messages).includes("environment_context"));
  assert.equal(findCodexRollout(idA,home),fileA);
 });
 check("real-B-shape: complete message parse but unfinished turn stays UNKNOWN",()=>{
  const result=readNativeCodexThread({threadId:idB,root,codexHome:home,limit:10});
  assert.equal(result.thread.turns,3);
  assert.equal(result.thread.status,"unknown");
  assert.equal(result.messages.filter(m=>m.role==="user").length,3);
  assert.equal(result.messages.filter(m=>m.role==="assistant").length,3);
 });
 check("response_item fallback for legacy rollouts (never reports IDLE)",()=>{
  const result=readNativeCodexThread({threadId:"01a16969-677a-7033-9acd-a77503a7aeaf",root,codexHome:home,limit:10});
  assert.equal(result.thread.turns,1);
  assert.equal(result.thread.status,"unknown");
  assert.deepEqual(result.messages,[{role:"user",text:"Hello legacy"},{role:"assistant",text:"Legacy reply"}]);
 });
 check("limit keeps most recent messages",()=>{
  const result=readNativeCodexThread({threadId:idA,root,codexHome:home,limit:2});
  assert.deepEqual(result.messages,[{role:"user",text:userText3},{role:"assistant",text:replyText3}]);
 });
 check("partial in-flight tail line is ignored, corrupt middle line refused",()=>{
  const path=join(folder,"rollout-2026-10-24T17-00-00-01a16969-677a-7033-9acd-a77503a7aead.jsonl");
  writeFileSync(path,[JSON.stringify({type:"session_meta",payload:{id:"01a16969-677a-7033-9acd-a77503a7aead",source:"vscode",cwd:root}}),
   JSON.stringify(responseUser("u1","Hi")),'{"type":"response_item","payload":{"type":"mess'].join("\n"),{mode:0o600});
  const result=readNativeCodexThread({threadId:"01a16969-677a-7033-9acd-a77503a7aead",root,codexHome:home});
  assert.deepEqual(result.messages,[{role:"user",text:"Hi"}]);
  writeFileSync(path,[JSON.stringify({type:"session_meta",payload:{id:"01a16969-677a-7033-9acd-a77503a7aead",source:"vscode",cwd:root}}),
   '{"broken":',JSON.stringify(responseUser("u1","Hi"))].join("\n")+"\n",{mode:0o600});
  assert.throws(()=>readNativeCodexThread({threadId:"01a16969-677a-7033-9acd-a77503a7aead",root,codexHome:home}),/HISTORY_INVALID/);
  writeFileSync(path,"",{mode:0o600});
  assert.throws(()=>readNativeCodexThread({threadId:"01a16969-677a-7033-9acd-a77503a7aead",root,codexHome:home}),/HISTORY_INVALID/);
  writeFileSync(path,JSON.stringify({type:"not_session_meta",payload:{}})+"\n",{mode:0o600});
  assert.throws(()=>readNativeCodexThread({threadId:"01a16969-677a-7033-9acd-a77503a7aead",root,codexHome:home}),/HISTORY_INVALID/);
 });
 check("identity/source/workspace/missing validation",()=>{
  assert.throws(()=>readNativeCodexThread({threadId:idA,root:fake,codexHome:home}),/WORKSPACE_MISMATCH/);
  assert.throws(()=>readNativeCodexThread({threadId:"invalid",root,codexHome:home}),/THREAD_ID_INVALID/);
  assert.throws(()=>readNativeCodexThread({threadId:"01a16cf8-0000-0000-0000-000000000000",root,codexHome:home}),/HISTORY_MISSING/);
  const path=fileA;
  const saved=readNativeCodexThread({threadId:idA,root,codexHome:home});
  assert.ok(saved.messages.length>0);
  const records=[{type:"session_meta",payload:{id:idA,source:"exec",cwd:root}},responseUser("u","x")];
  write(path,records as any[]);
  assert.throws(()=>readNativeCodexThread({threadId:idA,root,codexHome:home}),/IDENTITY_INVALID/);
  write(path,[{type:"session_meta",payload:{id:idA,source:"vscode",session_id:"01a16cf8-9102-7102-8fc9-9b925b1f1a21",cwd:root}}] as any[]);
  assert.throws(()=>readNativeCodexThread({threadId:idA,root,codexHome:home}),/IDENTITY_INVALID/);
  write(path,[{type:"session_meta",payload:{id:idA,source:"vscode",cwd:fake}}] as any[]);
  assert.throws(()=>readNativeCodexThread({threadId:idA,root,codexHome:home}),/WORKSPACE_MISMATCH/);
  // Restore the real-A fixture for the owner/open checks below.
  write(fileA,[metaA,taskStarted(t1),userItem(t1,"u1",userText1),agentItem(t1,"a1",replyText1),taskComplete(t1)]);
 });

 const daemonPid=46163;
 const daemonCmd=(codexHome:string)=>join(codexHome,"packages","app-server-daemon","releases","0.164.0-aarch64-apple-darwin","bin","codex")+
  " app-server --remote-control --listen unix:// --analytics-default-enabled --managed-daemon";
 const appProc:ProcessInfo={pid:900,ppid:1,uid,cmd:"/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"};
 const daemonProc:ProcessInfo={pid:daemonPid,ppid:1,uid,cmd:daemonCmd(home)};
 const lockDir=join(home,"thread-writer-locks");
 mkdirSync(lockDir,{recursive:true,mode:0o700});
 const lockPath=join(lockDir,idA+".lock");
 writeFileSync(lockPath,"",{mode:0o600});
 check("owner judgment accepts the current App-owned managed app-server daemon",()=>{
  const hold=verifyThreadWriterOwnership({threadId:idA,codexHome:home,processes:[appProc,daemonProc],lockOwnerPids:[daemonPid]});
  assert.deepEqual(hold,{state:"APP_OWNED",pid:daemonPid});
 });
 check("owner judgment rejects a genuinely different writer (CLI stdio app-server)",()=>{
  const cli:ProcessInfo={pid:777,ppid:1,uid,cmd:"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server --listen stdio://"};
  assert.throws(()=>verifyThreadWriterOwnership({threadId:idA,codexHome:home,processes:[appProc,daemonProc,cli],lockOwnerPids:[cli.pid]}),/HELD_BY_OTHER_APP/);
 });
 check("owner judgment rejects unmanaged/mis-uid writers and two holders",()=>{
  const unmanaged:ProcessInfo={...daemonProc,pid:778,cmd:daemonCmd(home).replace(" --managed-daemon","")};
  assert.throws(()=>verifyThreadWriterOwnership({threadId:idA,codexHome:home,processes:[appProc,unmanaged],lockOwnerPids:[778]}),/HELD_BY_OTHER_APP/);
  const foreign:ProcessInfo={...daemonProc,pid:779,uid:uid+1};
  assert.throws(()=>verifyThreadWriterOwnership({threadId:idA,codexHome:home,processes:[appProc,foreign],lockOwnerPids:[779]}),/HELD_BY_OTHER_APP/);
  assert.throws(()=>verifyThreadWriterOwnership({threadId:idA,codexHome:home,processes:[appProc,daemonProc,{...daemonProc,pid:780}],lockOwnerPids:[daemonPid,780]}),/HELD_BY_OTHER_APP/);
 });
 check("stale/absent lock is not treated as a writer; unsafe lock refused",()=>{
  assert.deepEqual(verifyThreadWriterOwnership({threadId:idA,codexHome:home,processes:[appProc],lockOwnerPids:[]}),{state:"UNLOCKED"});
  const missing=join(lockDir,idB+".lock");
  assert.deepEqual(verifyThreadWriterOwnership({threadId:idB,codexHome:home,processes:[appProc],lockPath:missing}),{state:"UNLOCKED"});
  const link=join(lockDir,"01a16cf8-0000-0000-0000-000000000001.lock");
  symlinkSync(lockPath,link);
  assert.throws(()=>verifyThreadWriterOwnership({threadId:"01a16cf8-0000-0000-0000-000000000001",codexHome:home,processes:[appProc],lockPath:link}),/LOCK_UNSAFE/);
 });
 check("open navigates with App-owned lock but still rejects different writer/no App",()=>{
  const links:string[]=[];
  const opened=openNativeCodexThread({threadId:idA,root,codexHome:home},{processes:[appProc,daemonProc],lockOwnerPids:[daemonPid],navigate:url=>links.push(url)});
  assert.deepEqual(opened,{state:"NAVIGATION_REQUESTED",threadId:idA});
  assert.deepEqual(links,["codex://threads/"+idA]);
  assert.throws(()=>openNativeCodexThread({threadId:idA,root,codexHome:home},{processes:[daemonProc],lockOwnerPids:[daemonPid],navigate:()=>{}}),/APP_NOT_UNIQUE_OR_RUNNING/);
  const cli:ProcessInfo={pid:777,ppid:1,uid,cmd:"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server --listen stdio://"};
  assert.throws(()=>openNativeCodexThread({threadId:idA,root,codexHome:home},{processes:[appProc,cli],lockOwnerPids:[cli.pid],navigate:()=>{}}),/HELD_BY_OTHER_APP/);
 });
 process.stdout.write("CODEX_NATIVE_CONTINUITY_TEST_PASS ("+passed+" checks)\n");
}finally{rmSync(base,{recursive:true,force:true});}
