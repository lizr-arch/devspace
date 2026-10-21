import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { TaskRunner } from "./task-runner.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSidecarTools } from "./server/tools-sidecar.js";
import type { ServerContext } from "./server/server-types.js";
import { JobResourceLocks, ResourceLockBusyError, requestsForCommand } from "./job-resource-locks.js";

async function listener(port = 0): Promise<Server> {
  const s = createServer((_req, res) => res.end("other"));
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve());
  });
  return s;
}
async function freePort(): Promise<number> {
  const s = await listener();
  const a = s.address();
  assert.ok(a && typeof a !== "string");
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return a.port;
}
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const root = mkdtempSync(join(tmpdir(), "coach006a2-"));
const workspace = join(root, "workspace");
mkdirSync(join(workspace, ".devspace"), { recursive: true });
const dbPath = join(workspace, ".devspace", "coach_loop_spike.sqlite");
const db = new Database(dbPath);
db.exec("create table events(event_id integer primary key, operation_id text, event_type text, created_at text, payload_json text);" +
  "create table review_decisions(event_id integer primary key);" +
  "insert into events values(1,'op-a','READY_FOR_GPT_REVIEW','2026-01-01','SENSITIVE_PROMPT');" +
  "insert into events values(2,'op-b','READY_FOR_GPT_REVIEW','2026-01-02','secret');" +
  "insert into review_decisions values(2)");
db.close();
const locks = new JobResourceLocks();
const manager = new ManagedCoachSidecar(locks);
const id = "bapcebjlgncogfpgbhllioaichcldkbl";
let port = await freePort();
try {
  // All denial paths must leave the resource registry untouched.
  for (const bad of [0, 65536, -1, true, "9000", 3.14, NaN]) {
    await assert.rejects(manager.start({ workspaceId: "w", workspaceRoot: workspace, port: bad as number }));
    assert.equal(locks.snapshot().length, 0);
  }
  await assert.rejects(manager.start({ workspaceId: "w", workspaceRoot: workspace, port, pairedExtensionId: "Z".repeat(32) }));
  assert.equal(locks.snapshot().length, 0);
  await assert.rejects(manager.start({ workspaceId: "missing", workspaceRoot: join(root, "missing"), port }));
  assert.equal(locks.snapshot().length, 0);

  const invalidSchemaRoot = join(root, "invalid-schema");
  mkdirSync(join(invalidSchemaRoot, ".devspace"), { recursive: true });
  const invalidDb = new Database(join(invalidSchemaRoot, ".devspace", "coach_loop_spike.sqlite"));
  invalidDb.exec("create table events (event_id integer)");
  invalidDb.close();
  await assert.rejects(manager.start({ workspaceId: "invalid-schema", workspaceRoot: invalidSchemaRoot, port }));
  assert.equal(locks.snapshot().length, 0);

  const outsideRoot = join(root, "outside");
  mkdirSync(join(outsideRoot, ".devspace"), { recursive: true });
  symlinkSync(dbPath, join(outsideRoot, ".devspace", "coach_loop_spike.sqlite"));
  await assert.rejects(manager.start({ workspaceId: "external-db", workspaceRoot: outsideRoot, port }));
  assert.equal(locks.snapshot().length, 0);

  const occupied = await listener(port);
  try {
    await assert.rejects(manager.start({ workspaceId: "w", workspaceRoot: workspace, port }));
    assert.equal(locks.snapshot().length, 0);
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }

  // Existing coding lock MUST remain held during sidecar lifetime.
  const ordinary = requestsForCommand({ argv: ["/usr/bin/python3", "task.py"], workspaceRoot: workspace });
  locks.acquire({ jobId: "writer", runner: "npm", workspaceRoot: workspace, requests: ordinary });
  const started = await manager.start({ workspaceId: "w", workspaceRoot: workspace, port, pairedExtensionId: id });
  assert.equal(started.state, "running");
  assert.ok(started.startedAt);
  assert.match(started.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(manager.activeServiceIdsForRoot(workspace).length, 1);
  assert.equal(locks.snapshot().length, 3);
  assert.equal(manager.status("w")?.port, port);
  assert.equal(JSON.stringify(manager.status("w")).includes(started.token), false);
  assert.throws(() => locks.acquire({ jobId: "writer2", runner: "npm", workspaceRoot: workspace, requests: ordinary }), ResourceLockBusyError);
  await assert.rejects(manager.start({ workspaceId: "w", workspaceRoot: workspace, port }), /already running/);
  await assert.rejects(new ManagedCoachSidecar(locks).start({ workspaceId: "other", workspaceRoot: workspace, port: await freePort() }));
  assert.equal(locks.snapshot().length, 3);

  const url = "http://127.0.0.1:" + port;
  const auth = { Authorization: "Bearer " + started.token };
  assert.equal((await fetch(url + "/health")).status, 401);
  assert.equal((await fetch(url + "/health", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const health = await fetch(url + "/health", { headers: auth });
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { ok: boolean }).ok, true);
  // Use Node HTTP directly: fetch implementations can replace a custom Host.
  const invalidHostStatus = await new Promise<number>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/health", method: "GET",
      headers: { Authorization: auth.Authorization, Host: "other.example" } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject); req.end();
  });
  assert.equal(invalidHostStatus, 400);
  assert.equal((await fetch(url + "/health", { headers: { ...auth, Origin: "https://evil.test" } })).status, 403);
  assert.equal((await fetch(url + "/health", { headers: { ...auth, Origin: "chrome-extension://" + "b".repeat(32) } })).status, 403);
  const origin = "chrome-extension://" + id;
  // One-click binding is initiated only by the paired extension and is
  // incomplete until Web GPT independently claims the exact workspace.
  const nonce="0123456789abcdef0123456789abcdef";
  const chatUrl="https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc";
  const bindingRequest={method:"POST",headers:{...auth,Origin:origin,
    "Content-Type":"application/json"},body:JSON.stringify({nonce,url:chatUrl})};
  assert.equal((await fetch(url+"/bind/start",{
    ...bindingRequest,headers:{...bindingRequest.headers,Origin:"https://evil.test"}
  })).status,403);
  assert.equal((await fetch(url+"/bind/start",{
    ...bindingRequest,headers:{...bindingRequest.headers,Authorization:"Bearer wrong"}
  })).status,403);
  const created=await fetch(url+"/bind/start",bindingRequest);
  assert.equal(created.status,200);
  const endpoint=url+"/bind/status?nonce="+nonce;
  assert.equal((await (await fetch(endpoint,{headers:auth})).json() as {state:string}).state,"pending");
  assert.equal(manager.claimBrowserRoute("w",nonce,chatUrl+"/wrong"),false);
  assert.equal(manager.claimBrowserRoute("unauthorized",nonce,chatUrl),false);
  assert.equal(manager.claimBrowserRoute("w",nonce,chatUrl),true);
  assert.equal(manager.claimBrowserRoute("w",nonce,chatUrl),false,"claim must be one-shot");
  const confirmed=await (await fetch(endpoint,{headers:auth})).json() as {
    state:string;workspaceId:string;url:string};
  assert.equal(confirmed.state,"claimed");
  assert.equal(confirmed.workspaceId,"w");
  assert.equal(confirmed.url,chatUrl);
  assert.equal((await fetch(url+"/bind/start",bindingRequest)).status,409);
  const nonce2="abcdef0123456789abcdef0123456789";
  const chatUrl2="https://chatgpt.com/c/87654321-abcd-1234-abcd-123456789abc";
  assert.equal((await fetch(url+"/bind/start",{...bindingRequest,
    body:JSON.stringify({nonce:nonce2,url:chatUrl2})})).status,200);
  assert.equal(manager.claimBrowserRoute("w-new",nonce2,chatUrl2),false,
    "scope must not expand without durable explicit consent");
  assert.equal(manager.claimBrowserRoute("w-new",nonce2,chatUrl2,()=>{throw Error("disk full");}),false);
  let capturedScope:string[]=[];
  assert.equal(manager.claimBrowserRoute("w-new",nonce2,chatUrl2,ids=>{capturedScope=ids;}),true);
  assert.deepEqual(capturedScope,["w","w-new"]);
  assert.equal((await fetch(url+"/events?workspaceId=w-new",{headers:auth})).status,200);
  assert.equal((await fetch(url+"/events?workspaceId=not-authorized",{headers:auth})).status,403);
  assert.equal((await fetch(url+"/bind/status?nonce=bad",{headers:auth})).status,404);
  const feed = await fetch(url + "/events", { headers: { ...auth, Origin: origin } });
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get("access-control-allow-origin"), origin);
  const body = await feed.text();
  const data = JSON.parse(body) as { pending_count: number; events: { event_id: number; operation_id: string }[] };
  assert.equal(data.pending_count, 1);
  assert.deepEqual(data.events.map((e) => e.operation_id), ["op-a"]);
  assert.equal(data.events[0]?.event_id, 1);
  assert.doesNotMatch(body, /SENSITIVE_PROMPT|secret|op-b/);
  assert.ok(!body.includes(started.token));
  const oldHash = sha(dbPath);
  assert.equal((await fetch(url + "/events", { method: "POST", headers: auth })).status, 405);
  assert.equal((await fetch(url + "/events", { method: "PUT", headers: auth })).status, 405);
  assert.equal(sha(dbPath), oldHash);
  assert.equal((await fetch(url + "/events?token=invalid", { headers: auth })).status, 400,
    "unknown feed selectors must fail closed before database access");
  const preflight = await fetch(url + "/events", { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal((await fetch(url + "/events", { method: "OPTIONS", headers: { Origin: "https://evil.test" } })).status, 403);

  const reviewer = new Database(dbPath);
  reviewer.exec("insert into review_decisions values(1)");
  reviewer.close();
  const empty = await fetch(url + "/events", { headers: auth });
  assert.equal((await empty.json() as { pending_count: number }).pending_count, 0);
  // Bound responses even when the event table holds many unreviewed records.
  const flood = new Database(dbPath);
  const insert = flood.prepare("insert into events values (?, ?, ?, ?, ?)");
  flood.transaction(() => {
    for (let i = 0; i < 60; i++) {
      insert.run(i + 100, "x".repeat(250) + i, "READY_FOR_GPT_REVIEW", "2026-02-01", "TOP_SECRET");
    }
  })();
  flood.close();
  const limited = await fetch(url + "/events", { headers: auth });
  const bounded = await limited.text();
  const list = JSON.parse(bounded) as { pending_count: number; events: { operation_id: string }[] };
  assert.equal(list.pending_count, 60);
  assert.equal(list.events.length, 50);
  assert.ok(list.events.every((row) => row.operation_id.length <= 128));
  assert.doesNotMatch(bounded, /TOP_SECRET/);

  locks.release("writer");
  assert.equal(locks.snapshot().length, 2);
  await manager.stop("w");
  await manager.stop("w");
  assert.equal(locks.snapshot().length, 0);
  assert.deepEqual(manager.activeServiceIdsForRoot(workspace), []);
  const restarted = await manager.start({ workspaceId: "w", workspaceRoot: workspace, port });
  assert.notEqual(restarted.token, started.token);
  // Recreate the TCP connection after a closed/rebound listener; Undici may
  // otherwise reuse a stale pooled socket and produce an unrelated ECONNRESET.
  const staleTokenStatus = await new Promise<number>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/health", method: "GET",
      agent: false, headers: auth }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject); req.end();
  });
  assert.equal(staleTokenStatus, 401);
  assert.equal((await fetch(url + "/health", { headers: { Authorization: "Bearer " + restarted.token,
    Origin: "chrome-extension://" + id } })).status, 403);
  await manager.close();
  assert.equal(manager.status("w"), undefined);
  assert.equal(locks.snapshot().length, 0);

  // Integration: actual TaskRunner and Sidecar share the same production lock
  // registry, but the readonly HTTP listener MUST NOT block a finite task.
  writeFileSync(join(workspace, ".devspace", "tasks.yaml"), JSON.stringify({
    version: 1, tasks: { probe: { mode: "run", runtime: "system", timeout_seconds: 20,
      command: [process.execPath, "-e", "process.stdout.write(\"same-workspace-task-ok\")"] } },
  }));
  const integrated = new ManagedCoachSidecar();
  const integrationPort = await freePort();
  await integrated.start({ workspaceId: "w", workspaceRoot: workspace, port: integrationPort });
  try {
    const runner = new TaskRunner();
    const task = await runner.runTask({ workspaceId: "w", workspaceRoot: workspace,
      taskId: "probe", params: {}, additionalRoots: [] });
    assert.equal(task.status, "succeeded", JSON.stringify(task));
    assert.match(task.mode === "run" ? task.stdout : "", /same-workspace-task-ok/);
    assert.equal(integrated.status("w")?.state, "running");
  } finally { await integrated.close(); }

  // Stop/close called during a pending TCP listen must wait for that start,
  // then release every claim. Never replay work automatically.
  const raceLocks = new JobResourceLocks();
  const racing = new ManagedCoachSidecar(raceLocks);
  const racePort = await freePort();
  const starting = racing.start({ workspaceId: "race", workspaceRoot: workspace, port: racePort });
  await assert.rejects(racing.start({ workspaceId: "race", workspaceRoot: workspace, port: racePort }), /in progress|already running/);
  const stopping = racing.stop("race");
  await starting;
  await stopping;
  assert.equal(racing.status("race"), undefined);
  assert.equal(raceLocks.snapshot().length, 0);
  await racing.close();
  await assert.rejects(racing.start({ workspaceId: "race", workspaceRoot: workspace, port: racePort }), /closed/);

  // Actual MCP SDK round-trip: tool listing, owner-scoped start/status/stop,
  // denial for unknown workspace and a read-only MCP server's tool inventory.
  const toolLocks = new JobResourceLocks();
  const toolManager = new ManagedCoachSidecar(toolLocks);
  const toolEvents=new CoachReviewEventStore(join(root,"tool-state"));
  const fakeWorkspace = { getWorkspace: (workspaceId: string) => {
    if (workspaceId !== "w") throw new Error("Unknown workspace");
    return { root: workspace };
  }};
  const createContext = (readOnly: boolean) => ({
    config: { readOnly }, workspaces: fakeWorkspace,
    managedCoachSidecar: toolManager, coachReviewEvents:toolEvents,
  }) as unknown as ServerContext;
  const toolServer = new McpServer({ name: "coach-a2-tool-test", version: "1.0.0" });
  registerSidecarTools(toolServer, createContext(false));
  const client = new Client({ name: "coach-a2-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await toolServer.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const advertised = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(advertised.includes("start_coach_sidecar"));
    assert.ok(advertised.includes("coach_sidecar_status"));
    assert.ok(advertised.includes("stop_coach_sidecar"));
    const denied = await client.callTool({
      name: "start_coach_sidecar", arguments: { workspaceId: "not-owned", port: await freePort() },
    });
    assert.equal(denied.isError, true);
    const pairPort = await freePort();
    const startResponse = await client.callTool({
      name: "start_coach_sidecar",
      arguments: { workspaceId: "w", port: pairPort, pairedExtensionId: id },
    });
    assert.equal(startResponse.isError ?? false, false);
    const startData = startResponse.structuredContent as Record<string, unknown>;
    const pairedToken = startData.token as string;
    assert.match(pairedToken, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(toolEvents.coachFeedConfig()?.authorizedWorkspaceIds,["w"],
      "explicit Sidecar tool start persists only the selected workspace");
    const statusResponse = await client.callTool({
      name: "coach_sidecar_status", arguments: { workspaceId: "w" },
    });
    assert.equal(statusResponse.isError ?? false, false);
    assert.equal(JSON.stringify(statusResponse).includes(pairedToken), false);
    const pairedHttp = await fetch("http://127.0.0.1:" + pairPort + "/health",
      { headers: { Authorization: "Bearer " + pairedToken } });
    assert.equal(pairedHttp.status, 200);
    const stopResponse = await client.callTool({
      name: "stop_coach_sidecar", arguments: { workspaceId: "w" },
    });
    assert.equal(stopResponse.isError ?? false, false);
    assert.equal(toolEvents.coachFeedConfig(),undefined,
      "explicit stop must revoke the automatic restart consent");
    assert.equal(toolLocks.snapshot().length, 0);
  } finally {
    await toolManager.close();
    await client.close();
    await toolServer.close();
  }
  const readonlyServer = new McpServer({ name: "coach-a2-readonly", version: "1.0.0" });
  registerSidecarTools(readonlyServer, createContext(true));
  const readonlyClient = new Client({ name: "coach-a2-readonly-client", version: "1.0.0" });
  const [roc, ros] = InMemoryTransport.createLinkedPair();
  await readonlyServer.connect(ros);
  await readonlyClient.connect(roc);
  try {
    const advertised = (await readonlyClient.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(advertised, ["coach_delivery_receipt","coach_sidecar_status"]);
  } finally {
    await readonlyClient.close();
    await readonlyServer.close();
    toolEvents.close();
  }

  // Native (DevSpace stateDir) event source: scope all rows to this exact workspace.
  const native = new CoachReviewEventStore(join(root, "state"));
  const eventA = native.recordCompleted({ workspaceId: "native-ws", operationId: "native-completed", evidenceSha256: "a".repeat(64) });
  const eventB=native.recordCompleted({ workspaceId: "other-ws", operationId: "cross-workspace-secret", evidenceSha256: "b".repeat(64) });
  const nativeLocks = new JobResourceLocks();
  const nativeSidecar = new ManagedCoachSidecar(nativeLocks, native.path);
  const nativePort = await freePort();
  const pair = await nativeSidecar.start({ workspaceId: "native-ws", workspaceRoot: workspace, port: nativePort, pairedExtensionId:id });
  const handoffPath=join(dirname(native.path),"coach-current-pairing.json");
  assert.equal(existsSync(handoffPath),true);
  assert.equal(lstatSync(handoffPath).mode&0o777,0o600);
  assert.equal(JSON.parse(readFileSync(handoffPath,"utf8")).token,pair.token);
  try {
    const headers = { Authorization: "Bearer " + pair.token };
    const response = await fetch("http://127.0.0.1:" + nativePort + "/events", { headers });
    assert.equal(response.status, 200);
    const text = await response.text();
    const data = JSON.parse(text) as { pending_count: number; events: { event_id: number; operation_id: string }[] };
    assert.equal(data.pending_count, 1);
    assert.equal(data.events[0]?.event_id, eventA.event_id);
    assert.equal(data.events[0]?.operation_id, "native-completed");
    assert.ok(!text.includes("cross-workspace-secret"));
    const endpoint="http://127.0.0.1:"+nativePort+"/delivery-receipt";
    const receiptPayload={workspace_id:"native-ws",event_id:eventA.event_id,operation_id:"native-completed"};
    const payloadHeaders={...headers,Origin:"chrome-extension://"+id,"Content-Type":"application/json"};
    assert.equal((await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(receiptPayload)})).status,403,
      "The bearer alone cannot produce a browser-origin receipt");
    assert.equal((await fetch(endpoint,{method:"POST",headers:{...payloadHeaders,Origin:"https://evil.invalid"},
      body:JSON.stringify(receiptPayload)})).status,403);
    assert.equal((await fetch(endpoint,{method:"POST",headers:{...payloadHeaders,Authorization:"Bearer wrong"},
      body:JSON.stringify(receiptPayload)})).status,401);
    assert.equal((await fetch(endpoint,{method:"POST",headers:payloadHeaders,
      body:JSON.stringify({...receiptPayload,workspace_id:"other-ws"})})).status,400);
    assert.equal((await fetch(endpoint,{method:"POST",headers:payloadHeaders,
      body:JSON.stringify({...receiptPayload,operation_id:"different"})})).status,404);
    assert.equal((await fetch(endpoint,{method:"POST",headers:payloadHeaders,
      body:JSON.stringify({...receiptPayload,unexpected:"forged"})})).status,400);
    const accepted=await fetch(endpoint,{method:"POST",headers:payloadHeaders,body:JSON.stringify(receiptPayload)});
    assert.equal(accepted.status,200);
    assert.equal((await accepted.json() as {receipt:{result:string}}).receipt.result,"dom_submitted");
    const durableReceipt=nativeSidecar.getDeliveryReceipt("native-ws",eventA.event_id);
    assert.equal(durableReceipt?.operation_id,"native-completed");
    const replay=await fetch(endpoint,{method:"POST",headers:payloadHeaders,body:JSON.stringify(receiptPayload)});
    assert.equal(replay.status,200);
    assert.equal((await replay.json() as {receipt:{recorded_at:string}}).receipt.recorded_at,
      durableReceipt?.recorded_at,"duplicate POST must never create a new delivery claim");
    assert.equal(nativeSidecar.getDeliveryReceipt("other-ws",eventA.event_id),undefined);
    native.submitReview({ workspaceId: "native-ws", eventId: eventA.event_id, decision: "APPROVED", evidenceSha256: "a".repeat(64) });
    const post = await fetch("http://127.0.0.1:" + nativePort + "/events", { headers });
    assert.equal((await post.json() as { pending_count:number }).pending_count, 0);
    // Authorizations are persisted as an exact consent set, never
    // silently widened to all workspaces registered in the event database.
    native.saveCoachFeedConfig({workspaceId:"native-ws",workspaceRoot:workspace,
      port:nativePort,pairedExtensionId:id,observeAllNativeAgents:false,
      authorizedWorkspaceIds:["native-ws","other-ws"]});
    assert.deepEqual(native.coachFeedConfig()?.authorizedWorkspaceIds,["native-ws","other-ws"]);
    assert.throws(()=>native.saveCoachFeedConfig({workspaceId:"native-ws",
      workspaceRoot:workspace,port:nativePort,observeAllNativeAgents:false,
      authorizedWorkspaceIds:["other-ws"]}),/COACH_FEED_CONFIG_INVALID/);
    assert.deepEqual(native.coachFeedConfig()?.authorizedWorkspaceIds,["native-ws","other-ws"]);
    native.clearCoachFeedConfig();
    assert.equal(native.coachFeedConfig(),undefined);
  } finally { await nativeSidecar.close(); native.close(); }
  assert.equal(existsSync(handoffPath),false,"stop revokes current pairing handoff");
  assert.equal(nativeLocks.snapshot().length, 0);
  // A newly started sidecar must recover the already acknowledged identity,
  // not create a second delivery claim or require the old bearer token.
  const restartedSidecar=new ManagedCoachSidecar(new JobResourceLocks(),native.path);
  const restartedPort=await freePort();
  const multi=await restartedSidecar.start({workspaceId:"native-ws",workspaceRoot:workspace,
    port:restartedPort,pairedExtensionId:id,
    authorizedWorkspaceIds:["native-ws","other-ws"]});
  try {
    const base="http://127.0.0.1:"+restartedPort;
    const headers={Authorization:"Bearer "+multi.token};
    const union=await fetch(base+"/events",{headers});
    assert.equal(union.status,200);
    const body=await union.json() as {pending_count:number;events:{event_id:number;workspace_id:string}[]};
    assert.equal(body.pending_count,1);
    assert.equal(body.events[0]?.workspace_id,"other-ws");
    assert.equal(body.events[0]?.event_id,eventB.event_id);
    const filtered=await fetch(base+"/events?workspaceId=native-ws",{headers});
    assert.equal((await filtered.json() as {pending_count:number}).pending_count,0);
    assert.equal((await fetch(base+"/events?workspaceId=unauthorized",{headers})).status,403);
    assert.equal((await fetch(base+"/events?workspaceId=other-ws&workspaceId=native-ws",{headers})).status,400);
    const scopeReceipt={workspace_id:"other-ws",event_id:eventB.event_id,operation_id:"cross-workspace-secret"};
    const posted=await fetch(base+"/delivery-receipt",{method:"POST",body:JSON.stringify(scopeReceipt),
      headers:{...headers,Origin:"chrome-extension://"+id,"Content-Type":"application/json"}});
    assert.equal(posted.status,200);
    assert.equal(restartedSidecar.getDeliveryReceipt("other-ws",eventB.event_id)?.operation_id,
      "cross-workspace-secret");
    assert.equal(restartedSidecar.getDeliveryReceipt("unapproved-ws",eventB.event_id),undefined);
    assert.equal(restartedSidecar.getDeliveryReceipt("native-ws",eventA.event_id)?.result,
      "dom_submitted");
    assert.equal(restartedSidecar.getDeliveryReceipt("native-ws",eventA.event_id)?.operation_id,
      "native-completed");
  } finally {await restartedSidecar.close();}
  console.log("managed coach sidecar + native events + TaskRunner + MCP gates PASS");
} finally {
  await manager.close();
  locks.release("writer");
  rmSync(root, { force: true, recursive: true });
}
