import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AgentObserverStore } from "./agent-observer.js";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import { JobResourceLocks } from "./job-resource-locks.js";

async function availablePort():Promise<number>{
  const server=createServer();
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve());});
  const addr=server.address();
  assert.ok(addr && typeof addr!=="string");
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  return addr.port;
}
test("local observer API is paired, bounded, cross-worktree and leak-free",async()=>{
  const root=mkdtempSync(join(tmpdir(),"coach008-observer-"));
  const work=join(root,"workspace");mkdirSync(join(work,".devspace"),{recursive:true});
  const db=new Database(join(work,".devspace","coach_loop_spike.sqlite"));
  db.exec("create table events(event_id integer primary key, operation_id text,event_type text,created_at text,payload_json text);create table review_decisions(event_id integer primary key)");
  db.close();
  const observer=new AgentObserverStore(3);
  observer.emit({workspaceId:"tria-worktree-a",operationId:"op-1",kind:"start",phase:"thread.started",status:"RUNNING"});
  observer.emit({workspaceId:"tria-worktree-b",operationId:"op-2",kind:"command",phase:"item.started",status:"RUNNING",
    tool:"rm -rf /private/credentials",basename:"/Users/private/.ssh/id_rsa"});
  observer.emit({workspaceId:"tria-worktree-a",operationId:"op-1",kind:"end",phase:"runner.finalized",status:"COMPLETED"});
  observer.emit({workspaceId:"tria-worktree-b",operationId:"op-2",kind:"end",phase:"runner.finalized",status:"FAILED"});
  const manager=new ManagedCoachSidecar(new JobResourceLocks(),undefined,observer);
  const port=await availablePort();
  const origin="chrome-extension://"+ "a".repeat(32);
  try{
    const url="http://127.0.0.1:"+port+"/agent/events?cursor=0";
    const oldPair=await manager.start({workspaceId:"coach-main",workspaceRoot:work,port,pairedExtensionId:"a".repeat(32)});
    const oldHeaders={Authorization:"Bearer "+oldPair.token,Origin:origin};
    let denied=await fetch(url,{headers:oldHeaders});
    assert.equal(denied.status,403,"v0.2 pairing must not silently grant cross-worktree admin scope");
    await manager.stop("coach-main");
    const pair=await manager.start({workspaceId:"coach-main",workspaceRoot:work,port,pairedExtensionId:"a".repeat(32),observeAllNativeAgents:true});
    const okHeaders={Authorization:"Bearer "+pair.token,Origin:origin};
    denied=await fetch(url,{headers:oldHeaders});
    assert.equal(denied.status,401,"old token must not authorize newly enabled admin feed");
    let r=await fetch(url);assert.equal(r.status,401);
    r=await fetch(url,{headers:{...okHeaders,Origin:"https://chatgpt.com"}});assert.equal(r.status,403);
    // Node fetch normalizes the Host header; use raw HTTP to test host rejection.
    const badHost=await new Promise<number>((resolve,reject)=>{
      const q=request({hostname:"127.0.0.1",port,path:"/agent/events?cursor=0",
        headers:{...okHeaders,Host:"evil.invalid"}},res=>{res.resume();resolve(res.statusCode??0);});
      q.once("error",reject);q.end();
    });
    assert.equal(badHost,400);
    r=await fetch(url.replace("cursor=0","cursor=-2"),{headers:okHeaders});assert.equal(r.status,400);
    r=await fetch(url.replace("cursor=0","cursor=not-a-number"),{headers:okHeaders});assert.equal(r.status,400);
    r=await fetch(url.replace("/agent/events","/agent/eventsX"),{headers:okHeaders});assert.equal(r.status,404);
    r=await fetch(url,{method:"POST",headers:okHeaders});assert.equal(r.status,405);
    r=await fetch(url,{headers:okHeaders});assert.equal(r.status,200);
    assert.equal(r.headers.get("cache-control"),"no-store");
    assert.equal(r.headers.get("access-control-allow-origin"),origin);
    const data=await r.json() as {gap:number;events:{cursor:number;workspaceId:string;operationId:string;kind:string;status:string}[];nextCursor:number};
    assert.equal(data.gap,1);
    assert.equal(data.events.length,3);
    assert.ok(data.events.some(x=>x.workspaceId==="tria-worktree-a"));
    assert.ok(data.events.some(x=>x.workspaceId==="tria-worktree-b"));
    assert.equal(data.events.at(-1)?.status,"FAILED");
    assert.ok(data.nextCursor>0);
    const body=JSON.stringify(data);
    assert.doesNotMatch(body,/credentials|\.ssh|id_rsa|private\//i);
    r=await fetch("http://127.0.0.1:"+port+"/agent/events?cursor="+data.nextCursor,{headers:okHeaders});
    const after=await r.json() as {gap:number;events:unknown[];nextCursor:number};
    assert.equal(after.gap,0);assert.deepEqual(after.events,[]);
    assert.equal(after.nextCursor,data.nextCursor);
    // A sidecar restart resets the in-memory sequence; a previously larger
    // browser cursor must not strand the UI with permanently empty pages.
    const nextGeneration=new AgentObserverStore();
    nextGeneration.emit({workspaceId:"tria-worktree-c",operationId:"op-3",kind:"start",status:"RUNNING"});
    const replay=nextGeneration.readGlobal(data.nextCursor);
    assert.equal(replay.reset,true);
    assert.equal(replay.events.length,1);
    assert.equal(replay.nextCursor,1);
  }finally{await manager.stop("coach-main");rmSync(root,{recursive:true,force:true});}
});
