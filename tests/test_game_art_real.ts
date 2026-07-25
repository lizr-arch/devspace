import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { probePublicExternalClientFlow } from "../src/doctor.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";
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
const godotFixture = join(process.cwd(), "tests", "fixtures", "godot_capture");
for (const name of ["project.godot", "capture.tscn", "capture.gd"]) {
  copyFileSync(join(godotFixture, name), join(workspaceRoot, name));
}
cpSync(join(godotFixture, ".devspace"), join(workspaceRoot, ".devspace"), {
  recursive: true,
});
execFileSync("git", ["init", "-q", workspaceRoot]);
execFileSync("git", ["-C", workspaceRoot, "config", "user.name", "DevSpace"]);
execFileSync("git", [
  "-C",
  workspaceRoot,
  "config",
  "user.email",
  "fixture@devspace.local",
]);
execFileSync("git", ["-C", workspaceRoot, "add", "."]);
execFileSync("git", ["-C", workspaceRoot, "commit", "-qm", "fixture baseline"]);
const sourceCommit = execFileSync(
  "git",
  ["-C", workspaceRoot, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();

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
let runningServer = await startDevSpace();

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
    publishArtifactPath: "artifacts/blender_fixture/preview_perspective.png",
  });
  if (!probe.ready) {
    console.error(JSON.stringify(probe, null, 2));
  }
  assert.equal(probe.ready, true);
  assert.deepEqual(probe.toolNames, [
    "devspace_info",
    "list_workspaces",
    "list_artifacts",
    "publish_artifact",
    "resume_workspace",
    "open_workspace",
    "project_memory_preflight",
    "read",
    "write",
    "import_png",
    "edit",
    "grep",
    "glob",
    "ls",
    "bash",
    "start_job",
    "start_capture",
    "poll_job",
    "cancel_job",
  ]);
  assert.equal(probe.runnerNames?.includes("blender"), true);
  assert.equal(probe.runnerNames?.includes("godot-mono"), true);
  assert.equal(probe.backgroundJobStatus, "succeeded");
  assert.equal(probe.artifactList?.ok, true);
  assert.equal(probe.artifactPublication?.ok, true);
  assert.ok((probe.publishedArtifactBytes ?? 0) > 0);
  assert.match(probe.publishedArtifactSha256 ?? "", /^[0-9a-f]{64}$/);
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

  const captureProbe = await probePublicExternalClientFlow(config, {
    workspacePath: workspaceRoot,
    resumeWorkspaceId: probe.workspaceId,
    resumeWorkspaceRoot: workspaceRoot,
    captureProfile: "fixture",
    publishArtifactPath: "artifacts/captures/game_capture.png",
  });
  if (!captureProbe.ready) {
    console.error(JSON.stringify(captureProbe, null, 2));
  }
  assert.equal(captureProbe.ready, true);
  assert.equal(captureProbe.backgroundJobStatus, "succeeded");
  assert.equal(captureProbe.backgroundArtifactStatus, "complete");
  assert.equal(captureProbe.artifactList?.ok, true);
  assert.equal(captureProbe.artifactPublication?.ok, true);
  assert.equal(captureProbe.artifactCount, 2);
  assert.deepEqual([...(captureProbe.artifactPaths ?? [])].sort(), [
    "artifacts/captures/capture_manifest.json",
    "artifacts/captures/game_capture.png",
  ]);
  assert.ok((captureProbe.publishedArtifactBytes ?? 0) > 0);
  assert.match(captureProbe.publishedArtifactSha256 ?? "", /^[0-9a-f]{64}$/);

  const captureManifest = JSON.parse(
    readFileSync(
      join(workspaceRoot, "artifacts", "captures", "capture_manifest.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(captureManifest.engine, "Godot");
  assert.equal(captureManifest.sourceCommit, sourceCommit);
  assert.equal(captureManifest.assetLoaded, true);
  assert.equal(
    captureManifest.imageSha256,
    captureProbe.publishedArtifactSha256,
  );
  assert.deepEqual(captureManifest.viewport, [640, 360]);

  const restoredLedger = new ArtifactLedger(stateDir);
  const restored = await restoredLedger.listArtifacts({
    workspaceId: probe.workspaceId ?? "",
    workspaceRoot,
    limit: 20,
  });
  assert.equal(restored.length, 6);
  assert.ok(restored.every((artifact) => artifact.presence === "present"));

  const firstPublicationUrl = captureProbe.publishedArtifactUrl;
  assert.ok(firstPublicationUrl);
  await stopDevSpace(runningServer);
  runningServer = await startDevSpace();

  assert.equal(await freshHttpStatus(firstPublicationUrl), 404);

  const recoveryProbe = await probePublicExternalClientFlow(config, {
    workspacePath: workspaceRoot,
    resumeWorkspaceId: probe.workspaceId,
    resumeWorkspaceRoot: workspaceRoot,
    inspectArtifactJobId: captureProbe.backgroundJobId,
    publishArtifactPath: "artifacts/captures/game_capture.png",
  });
  if (!recoveryProbe.ready) {
    console.error(JSON.stringify(recoveryProbe, null, 2));
  }
  assert.equal(recoveryProbe.ready, true);
  assert.equal(recoveryProbe.listWorkspaces.ok, true);
  assert.equal(recoveryProbe.resumeWorkspace.ok, true);
  assert.equal(recoveryProbe.artifactList?.ok, true);
  assert.equal(recoveryProbe.artifactPublication?.ok, true);
  assert.equal(recoveryProbe.artifactCount, 2);
  assert.equal(
    recoveryProbe.publishedArtifactSha256,
    captureProbe.publishedArtifactSha256,
  );
  assert.notEqual(recoveryProbe.publishedArtifactUrl, firstPublicationUrl);

  console.log(
    JSON.stringify(
      {
        ready: probe.ready,
        workspaceId: probe.workspaceId,
        blenderJobId: probe.backgroundJobId,
        captureJobId: captureProbe.backgroundJobId,
        blenderStatus: probe.backgroundJobStatus,
        captureStatus: captureProbe.backgroundJobStatus,
        capturePublication: {
          url: captureProbe.publishedArtifactUrl,
          sha256: captureProbe.publishedArtifactSha256,
          bytes: captureProbe.publishedArtifactBytes,
        },
        blenderPublication: {
          url: probe.publishedArtifactUrl,
          sha256: probe.publishedArtifactSha256,
          bytes: probe.publishedArtifactBytes,
        },
        restartRecovery: {
          oldPublicationInvalidated: true,
          workspaceResumed: recoveryProbe.resumeWorkspace.ok,
          artifactCount: recoveryProbe.artifactCount,
          republishedSha256: recoveryProbe.publishedArtifactSha256,
        },
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
  await stopDevSpace(runningServer);
  rmSync(root, { recursive: true, force: true });
}

interface RunningDevSpace {
  httpServer: import("node:http").Server;
  close: () => void;
  stopped: boolean;
}

async function startDevSpace(): Promise<RunningDevSpace> {
  const { app, close } = createServer(config);
  const httpServer = await new Promise<import("node:http").Server>(
    (resolvePromise) => {
      const server = app.listen(config.port, config.host, () =>
        resolvePromise(server),
      );
    },
  );
  return { httpServer, close, stopped: false };
}

async function stopDevSpace(server: RunningDevSpace): Promise<void> {
  if (server.stopped) return;
  server.stopped = true;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.httpServer.close((error) =>
      error ? rejectPromise(error) : resolvePromise(),
    );
  });
  server.close();
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

async function freshHttpStatus(url: string): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      url,
      { agent: false, headers: { Connection: "close" } },
      (response) => {
        response.resume();
        response.once("end", () => resolvePromise(response.statusCode ?? 0));
      },
    );
    request.once("error", rejectPromise);
    request.end();
  });
}
