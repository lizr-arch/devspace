import assert from "node:assert/strict";
import { fetchText, postMcpJsonRpc } from "./doctor-http.js";

const original=globalThis.fetch;
try{
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    throw new TypeError("fetch failed",{cause:Object.assign(new Error("reset"),{code:"ECONNRESET"})});
  };
  const failed=await fetchText("https://connector.invalid/mcp",{method:"POST",body:"{}"});
  assert.equal(calls,1,"a failed POST must never be replayed by the diagnostics wrapper");
  assert.equal(failed.ok,false);
  assert.equal(failed.errorClass,"NETWORK_OR_TUNNEL_ERROR");
  assert.equal(failed.mcpResponsePresent,false);
  assert.match(failed.probeSampleId??"",/^[0-9a-f-]{36}$/);
  assert.match(failed.error??"",/ECONNRESET/);

  globalThis.fetch=async(_input,init)=>{
    const headers=new Headers((init as RequestInit).headers);
    assert.match(headers.get("x-devspace-trace-id")??"",/^[0-9a-f-]{36}$/);
    return new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:{ok:true}}),{
      status:200,headers:{"content-type":"application/json","x-devspace-request-id":"server-req-1","x-devspace-trace-id":headers.get("x-devspace-trace-id")!},
    });
  };
  const response=await postMcpJsonRpc("https://connector.invalid/mcp","secret-token",{jsonrpc:"2.0",id:1,method:"initialize"});
  assert.equal(response.requestId,"server-req-1");
  assert.match(response.traceId??"",/^[0-9a-f-]{36}$/);
  assert.equal(response.mcpResponsePresent,true);
  assert.equal(response.errorClass,undefined);
  assert.equal(typeof response.durationMs,"number");
  console.log("probe metadata, error retention, and non-replay guard PASS");
}finally{globalThis.fetch=original;}
