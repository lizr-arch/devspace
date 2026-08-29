import { createHash } from "node:crypto";
import { loadConfig } from "./config.js";
import {
  exposedToolNames,
  toolNamesFor,
  requiredCapabilityForTool,
} from "./server/server-helpers.js";
import { JOB_RUNNERS } from "./background-jobs.js";
import {
  PACKAGE_VERSION,
  TOOL_SCHEMA_REVISION,
  type ToolCapability,
} from "./server/server-types.js";
import {
  probeLocalChatGptFlow,
  probePublicExternalClientFlow,
} from "./doctor.js";

export interface SchemaProbeReport {
  consistent: boolean;
  runtime: {
    schemaRevision: string;
    schemaFingerprint: string;
    toolCount: number;
    tools: string[];
  };
  localHealthz?: {
    ok: boolean;
    bootId?: string;
    schemaFingerprint?: string;
    toolCount?: number;
  };
  publicEndpoint?: {
    ok: boolean;
    schemaFingerprint?: string;
    toolCount?: number;
    tools?: string[];
  };
  drift?: {
    missingInPublic?: string[];
    unexpectedInPublic?: string[];
  };
}

export async function runSchemaProbe(args: string[] = []): Promise<SchemaProbeReport> {
  const isJson = args.includes("--json");
  const checkPublic = args.includes("--public") || args.includes("--full");
  const config = loadConfig();

  const toolNames = toolNamesFor(config);
  const runtimeTools = exposedToolNames(config, toolNames);
  const requiredCapabilities = Object.fromEntries(
    runtimeTools.map((tool) => [tool, requiredCapabilityForTool(tool)]),
  ) as Record<string, ToolCapability>;

  const runtimeFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        packageVersion: PACKAGE_VERSION,
        schemaRevision: TOOL_SCHEMA_REVISION,
        tools: runtimeTools,
        readOnly: config.readOnly,
        minimalTools: config.minimalTools,
        widgets: config.widgets,
        toolNaming: config.toolNaming,
        requiredCapabilities,
        runnerNames: JOB_RUNNERS,
        gitRemoteWrite: config.gitRemoteWrite,
        workspaceApp: undefined,
      }),
    )
    .digest("hex");

  const report: SchemaProbeReport = {
    consistent: true,
    runtime: {
      schemaRevision: TOOL_SCHEMA_REVISION,
      schemaFingerprint: runtimeFingerprint,
      toolCount: runtimeTools.length,
      tools: runtimeTools,
    },
  };

  // 1. Probe local healthz
  try {
    const localProbe = await probeLocalChatGptFlow(config);
    if (localProbe.healthz.ok) {
      const healthzRes = await fetch(`http://${config.host}:${config.port}/healthz`);
      if (healthzRes.ok) {
        const data = (await healthzRes.json()) as {
          bootId?: string;
          schemaFingerprint?: string;
          tools?: number;
        };
        report.localHealthz = {
          ok: true,
          bootId: data.bootId,
          schemaFingerprint: data.schemaFingerprint,
          toolCount: data.tools,
        };
      }
    }
  } catch {
    // Local server not running or unreachable
  }

  // 2. Probe public endpoint
  if (checkPublic) {
    try {
      const external = await probePublicExternalClientFlow(config, {
        workspacePath: config.allowedRoots[0],
      });
      if (external.toolsList.ok && external.toolNames) {
        const publicTools = external.toolNames;
        const missingInPublic = runtimeTools.filter(
          (t) => !publicTools.includes(t),
        );
        const unexpectedInPublic = publicTools.filter(
          (t) => !runtimeTools.includes(t),
        );

        report.publicEndpoint = {
          ok: true,
          schemaFingerprint: external.schemaFingerprint,
          toolCount: publicTools.length,
          tools: publicTools,
        };

        if (
          missingInPublic.length > 0 ||
          unexpectedInPublic.length > 0 ||
          (external.schemaFingerprint &&
            report.localHealthz?.schemaFingerprint &&
            external.schemaFingerprint !== report.localHealthz.schemaFingerprint)
        ) {
          report.consistent = false;
          report.drift = {
            missingInPublic:
              missingInPublic.length > 0 ? missingInPublic : undefined,
            unexpectedInPublic:
              unexpectedInPublic.length > 0 ? unexpectedInPublic : undefined,
          };
        }
      }
    } catch {
      // Public probe failed
    }
  }

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== DevSpace End-to-End Schema Probe ===`);
    console.log(`Runtime Tools Count: ${report.runtime.toolCount}`);
    console.log(`Runtime Fingerprint: ${report.runtime.schemaFingerprint}`);
    console.log(`Query Operation Present: ${report.runtime.tools.includes("query_operation") ? "YES" : "NO"}`);
    console.log(`Git Push Present: ${report.runtime.tools.includes("git_push") ? "YES" : "NO"}`);

    if (report.localHealthz) {
      console.log(`\nLocal Healthz:`);
      console.log(`  Boot ID: ${report.localHealthz.bootId}`);
      console.log(`  Server Fingerprint: ${report.localHealthz.schemaFingerprint}`);
      console.log(`  Tools Count: ${report.localHealthz.toolCount}`);
    }

    if (report.publicEndpoint) {
      console.log(`\nPublic Cloudflare Endpoint:`);
      console.log(`  Discovered Tools: ${report.publicEndpoint.toolCount}`);
      console.log(`  Discovered Fingerprint: ${report.publicEndpoint.schemaFingerprint}`);
    }

    if (!report.consistent && report.drift) {
      console.log(`\n[!] SCHEMA DRIFT DETECTED:`);
      if (report.drift.missingInPublic) {
        console.log(`  Missing in Public: ${report.drift.missingInPublic.join(", ")}`);
      }
      if (report.drift.unexpectedInPublic) {
        console.log(`  Unexpected in Public: ${report.drift.unexpectedInPublic.join(", ")}`);
      }
    } else {
      console.log(`\n[OK] SCHEMA CONSISTENT: Runtime, Local, and Public endpoints are in sync.`);
    }
  }

  return report;
}
