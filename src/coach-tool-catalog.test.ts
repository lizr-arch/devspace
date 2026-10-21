import assert from "node:assert/strict";
import {exposedToolNames,requiredCapabilityForTool,toolNamesFor} from "./server/server-helpers.js";
import {TOOL_SCHEMA_REVISION} from "./server/server-types.js";
import type {ServerConfig} from "./config.js";
function config(readOnly:boolean):ServerConfig{
 return {readOnly,minimalTools:false,toolNaming:"short",widgets:"off",
   gitRemoteWrite:{enabled:false},godotImport:{enabled:false}} as unknown as ServerConfig;
}
const regular=config(false);
const names=exposedToolNames(regular,toolNamesFor(regular));
assert.equal(names.filter(n=>n==="codex_agent_observe").length,1);
assert.equal(names.filter(n=>n==="codex_agent_update_config").length,1);
for(const tool of ["coach_realtime_status","coach_realtime_register","coach_realtime_pause","coach_realtime_resume","coach_webgpt_claim_browser_route"])
 assert.equal(names.filter(n=>n===tool).length,1);
for(const tool of ["coach_realtime_register","coach_realtime_pause","coach_realtime_resume","coach_webgpt_claim_browser_route"])
 assert.equal(requiredCapabilityForTool(tool),"runner.execute");
assert.equal(requiredCapabilityForTool("coach_realtime_status"),"workspace.read");
assert.equal(requiredCapabilityForTool("codex_agent_update_config"),"runner.execute");
assert.equal(requiredCapabilityForTool("codex_agent_observe"),"workspace.read");
const readOnly=config(true);
const ro=exposedToolNames(readOnly,toolNamesFor(readOnly));
assert.ok(ro.includes("codex_agent_observe"));
assert.ok(ro.includes("coach_realtime_status"));
assert.ok(!ro.includes("coach_realtime_register"));
assert.ok(!ro.includes("coach_realtime_pause"));
assert.ok(!ro.includes("coach_realtime_resume"));
assert.ok(!ro.includes("coach_webgpt_claim_browser_route"));
assert.ok(!ro.includes("codex_agent_update_config"));
assert.ok(!ro.includes("codex_agent_start"));
assert.match(TOOL_SCHEMA_REVISION,/coach-webgpt-loop-001\+delivery-receipt-001\+coach-tool-catalog-v037\+coach-sidecar-scope-v1\+coach-oneclick-v0310$/);
console.log("COACH_PUBLIC_TOOL_CATALOG_V2_PASS",names.length,"tools");
