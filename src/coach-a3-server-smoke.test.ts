import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.js";
import { createServer, createMcpServer } from "./server.js";
import { CoachReviewEventStore } from "./coach-review-events.js";

const root=mkdtempSync(join(tmpdir(),"coach-a3-server-smoke-"));
const state=join(root,"state");
let running:ReturnType<typeof createServer>|undefined;
let mcp:ReturnType<typeof createMcpServer>|undefined;
try {
 const config=loadConfig({
   DEVSPACE_CONFIG_DIR:join(root,"config"),
   DEVSPACE_ALLOWED_ROOTS:root,
   DEVSPACE_OAUTH_OWNER_TOKEN:"devspace-coach-native-event-smoke-token-long-enough",
   DEVSPACE_PUBLIC_BASE_URL:"https://devspace.example.com",
   DEVSPACE_STATE_DIR:state,
   DEVSPACE_WORKTREE_ROOT:join(root,"worktrees"),
   DEVSPACE_LOG_LEVEL:"silent",
   DEVSPACE_LOG_REQUESTS:"0",
   DEVSPACE_LOG_TOOL_CALLS:"0",
   DEVSPACE_WIDGETS:"off",
 });
 running=createServer(config);
 assert.ok(existsSync(join(state,"coach-review-events.sqlite")),
    "native coach event store not created by actual createServer");
 assert.ok(running.ctx.runtime.tools.includes("coach_sidecar_status"));
 if (!config.readOnly) {
   assert.ok(running.ctx.runtime.tools.includes("start_coach_sidecar"));
   assert.ok(running.ctx.runtime.tools.includes("stop_coach_sidecar"));
 }
 mcp=createMcpServer(running.ctx);
 const probe=new CoachReviewEventStore(state);
 const recorded=probe.recordCompleted({workspaceId:"ws-a",operationId:"persisted",evidenceSha256:"f".repeat(64)});
 assert.equal(probe.listPending("ws-a").events[0]?.event_id,recorded.event_id);
 probe.close();
 console.log("COACH006A3_ACTUAL_DEVSPACE_CREATE_SERVER_PASS");
} finally {
 running?.close();
 if (mcp) await mcp.close();
 await new Promise(resolve=>setTimeout(resolve,80));
 rmSync(root,{recursive:true,force:true});
}
// Exercise the actual API restart, not just the in-memory Sidecar unit.
await import("./coach-sidecar-api-recovery.test.js");
