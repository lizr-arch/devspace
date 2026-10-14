import assert from "node:assert/strict";
import { mcpDiagnosticsSnapshot, recordMcpDiagnostic, withMcpRequest } from "./mcp-diagnostics.js";

withMcpRequest({requestId:"req-1",traceId:"trace-1",rpcMethod:"tools/call",rpcId:7},()=>{
  recordMcpDiagnostic("request_received");
  recordMcpDiagnostic("tool_started",{toolName:"read_file",operationId:"op-1",workspaceRef:"0123456789abcdef"});
  recordMcpDiagnostic("tool_finished",{toolName:"read_file",operationId:"op-1",workspaceRef:"0123456789abcdef"});
  recordMcpDiagnostic("client_abort",{errorClass:"CLIENT_ABORT",statusCode:200});
});
const snap=mcpDiagnosticsSnapshot(100);
assert.equal(snap.events.at(-1)?.requestId,"req-1");
assert.equal(snap.events.at(-1)?.traceId,"trace-1");
assert.equal(snap.events.at(-1)?.errorClass,"CLIENT_ABORT");
assert.equal(snap.countsByStage.tool_started,1);
assert.equal(snap.toolCalls.count,1);
assert.equal(snap.toolCalls.successRate,1);
assert.equal(snap.toolCalls.serverSuccessRate,1);
assert.equal(snap.toolCalls.connectorReceipt,"not_observable");
assert.equal(snap.events.find((event)=>event.stage==="tool_started")?.workspaceRef,"0123456789abcdef");
assert.equal(typeof snap.toolCalls.p50Ms,"number");
assert.equal(snap.events.some((event)=>JSON.stringify(event).includes("prompt")),false);
assert.equal(mcpDiagnosticsSnapshot(0).events.length,1);

for(let index=0;index<520;index++)withMcpRequest({requestId:"r"+index,traceId:"t"+index},()=>recordMcpDiagnostic("parsed"));
const bounded=mcpDiagnosticsSnapshot(100);
assert.equal(bounded.retained,512);
assert.equal(bounded.events.length,100);
assert.equal(bounded.events[0]?.requestId,"r420");

withMcpRequest({requestId:"timeout",traceId:"trace-timeout",rpcMethod:"tools/call",rpcId:8},()=>{
  recordMcpDiagnostic("request_received");recordMcpDiagnostic("tool_started",{toolName:"slow_tool"});
  recordMcpDiagnostic("tool_finished",{toolName:"slow_tool",errorClass:"TOOL_TIMEOUT"});
});
withMcpRequest({requestId:"write-fail",traceId:"trace-write",rpcMethod:"tools/call",rpcId:9},()=>{
  recordMcpDiagnostic("request_received");recordMcpDiagnostic("http_response_error",{statusCode:200,errorClass:"HTTP_RESPONSE_ERROR"});
});
withMcpRequest({requestId:"lost-result",traceId:"trace-lost",rpcMethod:"tools/call",rpcId:10},()=>{
  recordMcpDiagnostic("request_received");recordMcpDiagnostic("tool_started",{toolName:"write_file",operationId:"op-lost"});
  recordMcpDiagnostic("tool_finished",{toolName:"write_file",operationId:"op-lost"});
  recordMcpDiagnostic("client_abort",{errorClass:"CLIENT_ABORT"});
});
const faultEvents=mcpDiagnosticsSnapshot(100).events;
assert.equal(faultEvents.find((event)=>event.requestId==="timeout"&&event.stage==="tool_finished")?.errorClass,"TOOL_TIMEOUT");
assert.equal(faultEvents.find((event)=>event.requestId==="write-fail"&&event.stage==="http_response_error")?.errorClass,"HTTP_RESPONSE_ERROR");
assert.equal(faultEvents.find((event)=>event.requestId==="lost-result"&&event.stage==="tool_finished")?.errorClass,undefined);
assert.equal(faultEvents.find((event)=>event.requestId==="lost-result"&&event.stage==="client_abort")?.errorClass,"CLIENT_ABORT");
assert.equal(mcpDiagnosticsSnapshot(100).toolCalls.connectorReceipt,"not_observable");
console.log("mcp diagnostics bounded correlation and redaction PASS");
