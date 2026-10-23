import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {registerSharedCodexAppTools} from "./server/tools-codex-app.js";
import type {ServerContext} from "./server/server-types.js";
const dir=mkdtempSync(join(tmpdir(),"app-bridge-mcp-")),root=join(dir,"workspace");
mkdirSync(root);
const fakeContext=(readOnly:boolean)=>({config:{readOnly,stateDir:join(dir,"state")},
  workspaces:{getWorkspace(id:string){if(id!=="own_workspace")throw Error("WORKSPACE_NOT_AUTHORIZED");return{root};}},
  coachReviewEvents:{hasInterruptedRun(){return false;}}
} as unknown as ServerContext);
async function pair(readOnly:boolean){
 const server=new McpServer({name:"app-bridge-mcp-test",version:"1.0"});
 registerSharedCodexAppTools(server,fakeContext(readOnly));
 const client=new Client({name:"app-bridge-test-client",version:"1.0"});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 return{server,client};
}
try{
 const ro=await pair(true);
 const namesRo=(await ro.client.listTools()).tools.map(t=>t.name).sort();
 assert.deepEqual(namesRo,["codex_app_shared_status","codex_app_thread_current","codex_app_thread_read","codex_app_turn_receipt"].sort());
 const blocked=await ro.client.callTool({name:"codex_app_thread_read",arguments:{workspaceId:"other_workspace",threadId:"01a16969-677a-7033-9acd-a77503a7aeaf"}});
 assert.equal(blocked.isError,true);
 await ro.client.close();await ro.server.close();
 const rw=await pair(false);
 const namesRw=(await rw.client.listTools()).tools.map(t=>t.name);
 for(const name of ["codex_app_thread_bind","codex_app_thread_create","codex_app_thread_send"])
   assert.ok(namesRw.includes(name));
 const unauthorized=await rw.client.callTool({name:"codex_app_thread_send",arguments:{
   workspaceId:"other_workspace",threadId:"01a16969-677a-7033-9acd-a77503a7aeaf",operationId:"test",
   prompt:"do not send",sandbox:"read-only"
 }});
 assert.equal(unauthorized.isError,true);
 const missingTask=await rw.client.callTool({name:"codex_app_thread_send",arguments:{
   workspaceId:"own_workspace",threadId:"01a16969-677a-7033-9acd-a77503a7aeaf",operationId:"test",
   prompt:"edit",sandbox:"workspace-write"
 }});
 assert.equal(missingTask.isError,true,"workspace-write must reject absent frozen TASK before socket access");
 const noBinding=await rw.client.callTool({name:"codex_app_thread_current",arguments:{workspaceId:"own_workspace"}});
 assert.equal(noBinding.isError??false,false);
 const receipt=await rw.client.callTool({name:"codex_app_turn_receipt",arguments:{workspaceId:"own_workspace",operationId:"not_found"}});
 assert.equal(receipt.isError??false,false);
 await rw.client.close();await rw.server.close();
 console.log("CODEX_APP_SHARED_MCP_AUTH_TEST_PASS",namesRo.length,namesRw.length);
}finally{rmSync(dir,{recursive:true,force:true});}
