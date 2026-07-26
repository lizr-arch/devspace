import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { ArtifactLedger } from "./artifact-ledger.js";
import {
  ArtifactPublisher,
  MAX_TEXT_PUBLISH_BYTES,
  type ArtifactPublicationAudit,
} from "./artifact-publisher.js";

const root = mkdtempSync(join(tmpdir(), "devspace-artifact-publisher-"));
const workspaceRoot = join(root, "workspace");
const outputRoot = join(workspaceRoot, "artifacts", "publish");
const stateDir = join(root, "state");
mkdirSync(outputRoot, { recursive: true });
const ledger = new ArtifactLedger(stateDir);
const workspaceId = "ws_publish_test";
let now = Date.now();
const audits: ArtifactPublicationAudit[] = [];
const port = await freePort();
const publisher = new ArtifactPublisher(`http://127.0.0.1:${port}`, ledger, {
  now: () => now,
  audit: (event) => audits.push(event),
});
const app = express();
app.get("/artifacts/:token", async (request, response) => {
  await publisher.serve(String(request.params.token ?? ""), response);
});
const server = await new Promise<import("node:http").Server>(
  (resolvePromise) => {
    const value = app.listen(port, "127.0.0.1", () => resolvePromise(value));
  },
);

try {
  const baseline = ledger.captureBaseline(workspaceRoot, ["artifacts/publish"]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("published png"),
  ]);
  writeFileSync(join(outputRoot, "preview.png"), png);
  const discovered = await ledger.discoverArtifacts({
    workspaceId,
    workspaceRoot,
    jobId: "job_11111111-1111-1111-1111-111111111111",
    runner: "blender",
    status: "succeeded",
    artifactRoots: ["artifacts/publish"],
    baseline,
  });
  const record = discovered.artifacts[0];
  assert.ok(record);

  const publication = await publisher.publish({
    workspaceId,
    workspaceRoot,
    artifactId: record.artifactId,
    ttlSeconds: 30,
    purpose: "review",
  });
  assert.equal(publication.previewType, "image");
  assert.equal(publication.contentType, "image/png");
  assert.equal(publication.size, png.length);
  assert.equal(publication.artifact.presence, "present");
  assert.equal(publication.url.includes(workspaceRoot), false);

  const response = await fetch(publication.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("content-disposition") ?? "", /^inline/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  writeFileSync(join(outputRoot, "fake.png"), "not a png");
  await assert.rejects(
    publisher.preview({
      workspaceId,
      workspaceRoot,
      path: "artifacts/publish/fake.png",
    }),
    /ASSET_(?:SIGNATURE_MISMATCH|FORMAT_REJECTED)/,
  );
  await assert.rejects(
    publisher.preview({
      workspaceId,
      workspaceRoot,
      artifactId: record.artifactId,
      path: "artifacts/publish/preview.png",
    }),
    /ASSET_INPUT_INVALID/,
  );

  const guessed = await fetch(
    `http://127.0.0.1:${port}/artifacts/${"A".repeat(43)}`,
  );
  assert.equal(guessed.status, 404);

  const expiring = await publisher.publish({
    workspaceId,
    workspaceRoot,
    path: "artifacts/publish/preview.png",
    ttlSeconds: 30,
  });
  now += 30_001;
  const expired = await fetch(expiring.url);
  assert.equal(expired.status, 410);
  assert.deepEqual(await expired.json(), { error: "PUBLISH_TOKEN_EXPIRED" });

  now += 1;
  const changed = await publisher.publish({
    workspaceId,
    workspaceRoot,
    artifactId: record.artifactId,
    ttlSeconds: 30,
  });
  writeFileSync(join(outputRoot, "preview.png"), "<html>changed</html>");
  const changedResponse = await fetch(changed.url);
  assert.equal(changedResponse.status, 409);
  assert.equal((await changedResponse.json()).error, "ARTIFACT_MIME_REJECTED");

  await assert.rejects(
    () =>
      publisher.publish({
        workspaceId,
        workspaceRoot,
        path: "../outside.png",
      }),
    /Invalid workspace-relative path/,
  );
  await assert.rejects(
    () =>
      publisher.publish({
        workspaceId,
        workspaceRoot,
        path: "artifacts/publish/unregistered.png",
      }),
    /ARTIFACT_NOT_FOUND/,
  );

  const largeBaseline = ledger.captureBaseline(workspaceRoot, [
    "artifacts/publish",
  ]);
  writeFileSync(
    join(outputRoot, "too-large.log"),
    Buffer.alloc(MAX_TEXT_PUBLISH_BYTES + 1, 0x61),
  );
  const largeDiscovery = await ledger.discoverArtifacts({
    workspaceId,
    workspaceRoot,
    jobId: "job_22222222-2222-2222-2222-222222222222",
    runner: "godot-mono",
    status: "succeeded",
    artifactRoots: ["artifacts/publish"],
    baseline: largeBaseline,
  });
  const largeRecord = largeDiscovery.artifacts.find((artifact) =>
    artifact.relativePath.endsWith("too-large.log"),
  );
  assert.ok(largeRecord);
  await assert.rejects(
    () =>
      publisher.publish({
        workspaceId,
        workspaceRoot,
        artifactId: largeRecord.artifactId,
      }),
    /ARTIFACT_TOO_LARGE/,
  );

  writeFileSync(join(outputRoot, "preview.png"), png);
  const symlinkGrant = await publisher.publish({
    workspaceId,
    workspaceRoot,
    artifactId: record.artifactId,
    ttlSeconds: 30,
  });
  const outsidePng = join(root, "outside.png");
  writeFileSync(outsidePng, png);
  unlinkSync(join(outputRoot, "preview.png"));
  symlinkSync(outsidePng, join(outputRoot, "preview.png"));
  const symlinkResponse = await fetch(symlinkGrant.url);
  assert.equal(symlinkResponse.status, 409);
  unlinkSync(join(outputRoot, "preview.png"));
  writeFileSync(join(outputRoot, "preview.png"), png);

  const restartGrant = await publisher.publish({
    workspaceId,
    workspaceRoot,
    artifactId: record.artifactId,
    ttlSeconds: 30,
  });
  publisher.close();
  const invalidated = await fetch(restartGrant.url);
  assert.equal(invalidated.status, 404);

  assert.ok(audits.some((event) => event.event === "artifact_published"));
  assert.ok(audits.some((event) => event.event === "artifact_accessed"));
  assert.ok(audits.some((event) => event.event === "artifact_access_rejected"));
  assert.ok(
    audits.every(
      (event) =>
        event.tokenHashPrefix.length === 0 ||
        /^[0-9a-f]{12}$/.test(event.tokenHashPrefix),
    ),
  );

  console.log("artifact publisher tests passed");
} finally {
  publisher.close();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
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
