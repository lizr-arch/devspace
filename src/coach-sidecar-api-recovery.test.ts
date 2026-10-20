import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer as createListener} from "node:net";
import {createServer} from "./server.js";
import {loadConfig} from "./config.js";
import {SqliteWorkspaceStore} from "./workspace-store.js";
const root=mkdtempSync(join(tmpdir(),"coach-api-autorestore-"));
const state=join(root,"state"),workspace=join(root,"project");
mkdirSync(workspace,{recursive:true});
const workspaces=new SqliteWorkspaceStore(state);
workspaces.createSession({id:"ws-recover",root:workspace});
workspaces.close();
const config=loadConfig({DEVSPACE_CONFIG_DIR:join(root,"cfg"),
  DEVSPACE_ALLOWED_ROOTS:root,DEVSPACE_OAUTH_OWNER_TOKEN:"devspace-coach-native-recover-authorization-token",
  DEVSPACE_PUBLIC_BASE_URL:"https://devspace.example.com",DEVSPACE_STATE_DIR:state,
  DEVSPACE_WORKTREE_ROOT:join(root,"worktrees"),DEVSPACE_LOG_LEVEL:"silent",
  DEVSPACE_LOG_REQUESTS:"0",DEVSPACE_LOG_TOOL_CALLS:"0",DEVSPACE_WIDGETS:"off"});
const socket=createListener();
const port=await new Promise<number>((resolve,reject)=>{
  socket.once("error",reject);
  socket.listen(0,"127.0.0.1",()=>{
    const a=socket.address();if(!a||typeof a==="string")reject(Error("no_port"));
    else resolve(a.port);
  });
});
await new Promise<void>(resolve=>socket.close(()=>resolve()));
let api:ReturnType<typeof createServer>|undefined;
try{
  api=createServer(config);
  const consent={workspaceId:"ws-recover",workspaceRoot:workspace,port,
    pairedExtensionId:"bapcebjlgncogfpgbhllioaichcldkbl",
    observeAllNativeAgents:false,authorizedWorkspaceIds:["ws-recover"]};
  const started=await api.ctx.managedCoachSidecar.start(consent);
  api.ctx.coachReviewEvents.saveCoachFeedConfig(consent);
  assert.equal((await api.ctx.managedCoachSidecar.status("ws-recover"))?.state,"running");
  await api.close();api=undefined;
  // Simulated API process restart; no user calls to start Sidecar.
  api=createServer(config);
  const deadline=Date.now()+3000;
  let status=await api.ctx.managedCoachSidecar.status("ws-recover");
  while(status?.state!=="running"&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,40));
    status=await api.ctx.managedCoachSidecar.status("ws-recover");
  }
  assert.equal(status?.state,"running","explicit consent auto-restores without an MCP click");
  const newHandoff=await fetch("http://127.0.0.1:"+port+"/health",{
    headers:{Authorization:"Bearer "+started.token}});
  assert.equal(newHandoff.status,401,"non-worker restart rotates the short-lived browser bearer");
  await api.ctx.managedCoachSidecar.stop("ws-recover");
  api.ctx.coachReviewEvents.clearCoachFeedConfig();
  assert.equal(api.ctx.coachReviewEvents.coachFeedConfig(),undefined);
  await api.close();api=undefined;
  api=createServer(config);
  await new Promise(resolve=>setTimeout(resolve,90));
  assert.equal(await api.ctx.managedCoachSidecar.status("ws-recover"),undefined,
    "explicit stop must prevent future automatic Sidecar startup");
  console.log("COACH_SIDECAR_REAL_API_RESTART_AND_EXPLICIT_STOP_PASS");
}finally{
  await api?.close();
  rmSync(root,{recursive:true,force:true});
}
