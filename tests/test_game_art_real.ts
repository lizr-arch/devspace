import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { probePublicExternalClientFlow } from "../src/doctor.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { ArtifactLedger } from "../src/artifact-ledger.js";

const root = mkdtempSync(join(tmpdir(), "devspace-game-art-real-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
const worktreeRoot = join(root, "worktrees");
mkdirSync(join(workspaceRoot, "tools"), { recursive: true });
copyFileSync(
  join(process.cwd(), "tests", "fixtures", "blender_asset", "create_asset.py"),
  join(workspaceRoot, "tools", "create_asset.py"),
);

const port = await freePort();
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_OAUTH_OWNER_TOKEN: "real-game-art-test-owner-token",
  DEVSPACE_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_WORKTREE_ROOT: worktreeRoot,
  DEVSPACE_TOOL_MODE: "full",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_LOG_REQUESTS: "0",
  DEVSPACE_LOG_TOOL_CALLS: "0",
  HOST: "127.0.0.1",
  PORT: String(port),
});
const { app, close } = createServer(config);
const httpServer = await new Promise<import("node:http").Server>((resolve) => {
  const server = app.listen(config.port, config.host, () => resolve(server));
});

try {
  const probe = await probePublicExternalClientFlow(config, {
    workspacePath: workspaceRoot,
    backgroundJob: {
      runner: "blender",
      args: [
        "--background",
        "--factory-startup",
        "--offline-mode",
        "--disable-autoexec",
        "--python-exit-code",
        "23",
        "--python",
        "tools/create_asset.py",
      ],
      artifactRoots: ["artifacts/blender_fixture"],
      timeoutSeconds: 120,
    },
  });
  if (!probe.ready) {
    console.error(JSON.stringify(probe, null, 2));
  }
  assert.equal(probe.ready, true);
  assert.equal(probe.backgroundJobStatus, "succeeded");
  assert.equal(probe.artifactList?.ok, true);
  if (probe.artifactCount !== 4) {
    console.error(
      JSON.stringify(
        {
          artifactCount: probe.artifactCount,
          artifactPaths: probe.artifactPaths,
          artifactStatus: probe.backgroundArtifactStatus,
          artifactErrors: probe.backgroundArtifactErrors,
          output: probe.backgroundJobOutput,
        },
        null,
        2,
      ),
    );
  }
  assert.equal(probe.artifactCount, 4);
  assert.deepEqual([...(probe.artifactPaths ?? [])].sort(), [
    "artifacts/blender_fixture/asset_manifest.json",
    "artifacts/blender_fixture/preview_perspective.png",
    "artifacts/blender_fixture/ship.glb",
    "artifacts/blender_fixture/source.blend",
  ]);
  assert.ok(probe.artifactSha256s?.every((value) => value.length === 64));
  assert.ok(probe.artifactSizes?.every((value) => value > 0));

  const restoredLedger = new ArtifactLedger(stateDir);
  const restored = await restoredLedger.listArtifacts({
    workspaceId: probe.workspaceId ?? "",
    workspaceRoot,
    limit: 10,
  });
  assert.equal(restored.length, 4);
  assert.ok(restored.every((artifact) => artifact.presence === "present"));

  console.log(
    JSON.stringify(
      {
        ready: probe.ready,
        workspaceId: probe.workspaceId,
        jobId: probe.backgroundJobId,
        runner: "blender",
        status: probe.backgroundJobStatus,
        artifacts: restored.map((artifact) => ({
          relativePath: artifact.relativePath,
          type: artifact.artifactType,
          size: artifact.size,
          sha256: artifact.sha256,
          jobId: artifact.jobId,
          presence: artifact.presence,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    httpServer.close((error) =>
      error ? rejectPromise(error) : resolvePromise(),
    );
  });
  close();
  rmSync(root, { recursive: true, force: true });
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  return port;
}
