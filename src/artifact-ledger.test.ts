import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactLedger,
  MAX_HASHABLE_ARTIFACT_BYTES,
  validateArtifactRoots,
} from "./artifact-ledger.js";

const root = mkdtempSync(join(tmpdir(), "devspace-artifact-ledger-"));
const stateDir = join(root, "state");
const workspaceRoot = join(root, "workspace");
const outputRoot = join(workspaceRoot, "artifacts", "blender");
mkdirSync(outputRoot, { recursive: true });

const ledger = new ArtifactLedger(stateDir);
const workspaceId = "ws_artifact_test";

try {
  const baseline = ledger.captureBaseline(workspaceRoot, ["artifacts/blender"]);
  const blend = Buffer.concat([
    Buffer.from("BLENDER-v305"),
    Buffer.from("fixture blend"),
  ]);
  const glb = Buffer.concat([
    Buffer.from("glTF"),
    Buffer.from([2, 0, 0, 0, 16, 0, 0, 0]),
    Buffer.from("fixture glb"),
  ]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("fixture png"),
  ]);
  writeFileSync(join(outputRoot, "source.blend"), blend);
  writeFileSync(join(outputRoot, "ship.glb"), glb);
  writeFileSync(join(outputRoot, "preview.png"), png);
  writeFileSync(
    join(outputRoot, "asset_manifest.json"),
    JSON.stringify({ vertexCount: 24, triangleCount: 12 }),
  );

  const first = await ledger.discoverArtifacts({
    workspaceId,
    workspaceRoot,
    jobId: "job_11111111-1111-1111-1111-111111111111",
    runner: "blender",
    runnerVersion: "Blender 5.2.0",
    status: "succeeded",
    artifactRoots: ["artifacts/blender"],
    baseline,
  });
  assert.equal(first.errors.length, 0);
  assert.equal(first.artifacts.length, 4);
  assert.ok(
    first.artifacts.every((artifact) => artifact.completion === "complete"),
  );
  assert.equal(
    first.artifacts.find((artifact) =>
      artifact.relativePath.endsWith("preview.png"),
    )?.sha256,
    createHash("sha256").update(png).digest("hex"),
  );

  const restored = new ArtifactLedger(stateDir);
  const restoredList = await restored.listArtifacts({
    workspaceId,
    workspaceRoot,
    limit: 10,
  });
  assert.equal(restoredList.length, 4);
  assert.ok(restoredList.every((artifact) => artifact.presence === "present"));

  const houdiniOutputRoot = join(workspaceRoot, "artifacts", "houdini");
  mkdirSync(houdiniOutputRoot, { recursive: true });
  const houdiniBaseline = restored.captureBaseline(workspaceRoot, [
    "artifacts/houdini",
  ]);
  const houdiniFixtures: Record<string, Buffer | string> = {
    "source.hip": "houdini hip fixture",
    "source.hiplc": "houdini hip limited commercial fixture",
    "source.hipnc": "houdini hip non-commercial fixture",
    "tool.hda": "houdini digital asset fixture",
    "tool.hdalc": "houdini digital asset limited commercial fixture",
    "tool.hdanc": "houdini digital asset non-commercial fixture",
    "pieces.bgeo.sc": "compressed bgeo fixture",
    "cache.abc": "Ogawa alembic fixture",
    "cache_hdf5.abc": Buffer.concat([
      Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("alembic fixture"),
    ]),
    "stage.usd": "#usda 1.0\n",
    "stage.usda": "#usda 1.0\n",
    "stage.usdc": "PXR-USDC fixture",
  };
  for (const [name, contents] of Object.entries(houdiniFixtures)) {
    writeFileSync(join(houdiniOutputRoot, name), contents);
  }
  const houdiniDiscovery = await restored.discoverArtifacts({
    workspaceId,
    workspaceRoot,
    jobId: "job_88888888-8888-8888-8888-888888888888",
    runner: "hython",
    runnerVersion: "20.5.410",
    status: "succeeded",
    artifactRoots: ["artifacts/houdini"],
    baseline: houdiniBaseline,
  });
  assert.equal(houdiniDiscovery.errors.length, 0);
  assert.equal(
    houdiniDiscovery.artifacts.length,
    Object.keys(houdiniFixtures).length,
  );
  assert.equal(
    houdiniDiscovery.artifacts.find((artifact) =>
      artifact.relativePath.endsWith(".bgeo.sc"),
    )?.format,
    "BGEO.SC",
  );
  assert.equal(
    houdiniDiscovery.artifacts.find((artifact) =>
      artifact.relativePath.endsWith(".bgeo.sc"),
    )?.artifactType,
    "geometry",
  );
  assert.ok(
    houdiniDiscovery.artifacts
      .filter((artifact) =>
        /\.(?:hip|hiplc|hipnc|hda|hdalc|hdanc)$/.test(artifact.relativePath),
      )
      .every((artifact) => artifact.artifactType === "houdini"),
  );

  const secondBaseline = restored.captureBaseline(workspaceRoot, [
    "artifacts/blender",
  ]);
  const replacementPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("replacement png version"),
  ]);
  writeFileSync(join(outputRoot, "preview.png"), replacementPng);
  const second = await restored.discoverArtifacts({
    workspaceId,
    workspaceRoot,
    jobId: "job_22222222-2222-2222-2222-222222222222",
    runner: "blender",
    runnerVersion: "Blender 5.2.0",
    status: "succeeded",
    artifactRoots: ["artifacts/blender"],
    baseline: secondBaseline,
  });
  assert.equal(second.artifacts.length, 1);
  assert.equal(second.artifacts[0]?.change, "modified");
  assert.notEqual(
    second.artifacts[0]?.sha256,
    first.artifacts.find((artifact) =>
      artifact.relativePath.endsWith("preview.png"),
    )?.sha256,
  );
  const versions = await restored.listArtifacts({
    workspaceId,
    workspaceRoot,
    pathPrefix: "artifacts/blender/preview.png",
    limit: 10,
  });
  assert.equal(versions.length, 2);
  assert.equal(versions[0]?.presence, "present");
  assert.equal(versions[1]?.presence, "superseded");

  unlinkSync(join(outputRoot, "asset_manifest.json"));
  const missing = await restored.listArtifacts({
    workspaceId,
    workspaceRoot,
    type: "json",
    limit: 10,
  });
  assert.equal(missing[0]?.presence, "missing");

  const partialBaseline = restored.captureBaseline(workspaceRoot, [
    "artifacts/blender",
  ]);
  writeFileSync(join(outputRoot, "partial.log"), "partial output");
  const partial = await restored.discoverArtifacts({
    workspaceId,
    workspaceRoot,
    jobId: "job_33333333-3333-3333-3333-333333333333",
    runner: "blender",
    status: "failed",
    artifactRoots: ["artifacts/blender"],
    baseline: partialBaseline,
  });
  assert.equal(partial.artifacts[0]?.completion, "incomplete");

  assert.throws(
    () => validateArtifactRoots(workspaceRoot, ["../outside"]),
    /Invalid workspace-relative path/,
  );
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(workspaceRoot, "artifact-link"));
  assert.throws(
    () => validateArtifactRoots(workspaceRoot, ["artifact-link"]),
    /WORKSPACE_ESCAPE/,
  );

  const symlinkBaseline = restored.captureBaseline(workspaceRoot, [
    "artifacts/blender",
  ]);
  symlinkSync(outside, join(outputRoot, "escaped"));
  await assert.rejects(
    () =>
      restored.discoverArtifacts({
        workspaceId,
        workspaceRoot,
        jobId: "job_44444444-4444-4444-4444-444444444444",
        runner: "blender",
        status: "succeeded",
        artifactRoots: ["artifacts/blender"],
        baseline: symlinkBaseline,
      }),
    /WORKSPACE_ESCAPE/,
  );
  unlinkSync(join(outputRoot, "escaped"));

  const invalidBaseline = restored.captureBaseline(workspaceRoot, [
    "artifacts/blender",
  ]);
  writeFileSync(join(outputRoot, "invalid.png"), "not a png");
  const invalid = await restored.discoverArtifacts({
    workspaceId,
    workspaceRoot,
    jobId: "job_55555555-5555-5555-5555-555555555555",
    runner: "blender",
    status: "succeeded",
    artifactRoots: ["artifacts/blender"],
    baseline: invalidBaseline,
  });
  assert.equal(invalid.artifacts.length, 0);
  assert.match(invalid.errors[0] ?? "", /ARTIFACT_MIME_REJECTED/);

  const largeBaseline = restored.captureBaseline(workspaceRoot, [
    "artifacts/blender",
  ]);
  const largePath = join(outputRoot, "too-large.blend");
  writeFileSync(largePath, "BLENDER");
  truncateSync(largePath, MAX_HASHABLE_ARTIFACT_BYTES + 1);
  const large = await restored.discoverArtifacts({
    workspaceId,
    workspaceRoot,
    jobId: "job_66666666-6666-6666-6666-666666666666",
    runner: "blender",
    status: "succeeded",
    artifactRoots: ["artifacts/blender"],
    baseline: largeBaseline,
  });
  assert.match(large.errors[0] ?? "", /ARTIFACT_TOO_LARGE/);

  const legacyWorkspaceId = "ws_legacy";
  const legacyPath = join(workspaceRoot, "legacy.png");
  writeFileSync(legacyPath, png);
  const legacyLedgerDir = join(stateDir, "artifacts", legacyWorkspaceId);
  mkdirSync(legacyLedgerDir, { recursive: true });
  writeFileSync(
    join(legacyLedgerDir, "ledger.json"),
    JSON.stringify({
      schemaVersion: 1,
      workspaceId: legacyWorkspaceId,
      artifacts: [
        {
          artifactId: "artifact_77777777-7777-7777-7777-777777777777",
          relativePath: "legacy.png",
          artifactType: "image",
          mimeType: "image/png",
          format: "PNG",
          size: png.length,
          sha256: createHash("sha256").update(png).digest("hex"),
          change: "created",
          completion: "complete",
          jobId: "job_77777777-7777-7777-7777-777777777777",
          runner: "blender",
          workspaceId: legacyWorkspaceId,
          createdAt: new Date().toISOString(),
          gitStatus: "untracked",
        },
      ],
    }),
  );
  const migrated = await new ArtifactLedger(stateDir).listArtifacts({
    workspaceId: legacyWorkspaceId,
    workspaceRoot,
  });
  assert.equal(migrated[0]?.origin.kind, "job");

  console.log("artifact ledger tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
