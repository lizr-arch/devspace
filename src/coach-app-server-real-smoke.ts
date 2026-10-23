/** Explicit billable real Codex smoke, NEVER import from routine unit test suites. */
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {bindSharedThread,boundSharedThread,createSharedThread,readSharedThread,sendSharedTurn,sharedAppStatus} from "./coach-app-server-bridge.js";
const index=process.argv.indexOf("--existing");
const existingId=index>=0?process.argv[index+1]:undefined;
const root=index>=0?process.argv[index+2]:process.cwd();
const tmp=mkdtempSync(join(tmpdir(),"devspace-app-smoke-"));
const workspaceId="ws_codex_app_smoke";
const marker="COACH_APP_BRIDGE_001_REAL_ACK";
try {
 const status=await sharedAppStatus();
 if(!status.connected)throw Error("SHARED_APP_UNAVAILABLE:"+status.error);
 const thread=existingId?{threadId:existingId,source:"vscode"}:await createSharedThread({root});
 const pinned=await bindSharedThread({root,workspaceId,threadId:thread.threadId,stateDir:tmp});
 if(pinned!==thread.threadId||boundSharedThread(tmp,workspaceId)!==pinned)throw Error("APP_BIND_FAILED");
 const input={root,workspaceId,threadId:pinned,operationId:"smoke_real_20261024_1",
   prompt:"只读 DevSpace Coach Mac 共享 Codex App 正式桥接测试。请只回复 COACH_APP_BRIDGE_001_REAL_ACK，不运行任何工具，不修改文件。",
   sandbox:"read-only" as const,stateDir:tmp,timeoutMs:200000};
 console.log("APP_BRIDGE_THREAD_ID",pinned,"SOURCE",thread.source);
 const answer=await sendSharedTurn(input);
 const repeat=await sendSharedTurn(input);
 if(answer.reply!==marker||repeat.turnId!==answer.turnId)throw Error("APP_ACK_OR_IDEMPOTENCY_FAILED");
 const history=await readSharedThread({root,threadId:pinned,limit:5});
 if(history.historyAvailable && !history.messages.some(m=>m.role==="assistant"&&m.text===marker))throw Error("APP_REPLY_NOT_PERSISTED");
 console.log("CODEX_APP_BRIDGE_REAL_SMOKE_PASS",JSON.stringify({threadId:pinned,turnId:answer.turnId,historyAvailable:history.historyAvailable,historyTurns:history.thread.turns,replayed:false}));
}finally{
 rmSync(tmp,{recursive:true,force:true});
}
