import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPng } from "./png-import.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const root = await mkdtemp(join(tmpdir(), "devspace-png-import-"));
try {
  const first = join(root, "raw", "candidate.png");
  const imported = await importPng({
    destination: first,
    workspaceRoot: root,
    base64Data: PNG.toString("base64"),
  });
  assert.equal(imported.bytes, PNG.length);
  assert.equal(imported.source, "base64");
  assert.deepEqual(await readFile(first), PNG);
  assert.match(imported.sha256, /^[0-9a-f]{64}$/);

  await assert.rejects(
    importPng({
      destination: first,
      workspaceRoot: root,
      base64Data: PNG.toString("base64"),
    }),
    /already exists/,
  );

  const replacement = Buffer.concat([PNG, Buffer.from("replacement")]);
  await importPng({
    destination: first,
    workspaceRoot: root,
    base64Data: replacement.toString("base64"),
    overwrite: true,
  });
  assert.deepEqual(await readFile(first), replacement);

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "not-png.png"),
      workspaceRoot: root,
      base64Data: Buffer.from("not png").toString("base64"),
    }),
    /not a PNG/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "wrong.txt"),
      workspaceRoot: root,
      base64Data: PNG.toString("base64"),
    }),
    /ending in .png/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "hash.png"),
      workspaceRoot: root,
      base64Data: PNG.toString("base64"),
      expectedSha256: "0".repeat(64),
    }),
    /SHA-256 mismatch/,
  );

  const outside = await mkdtemp(join(tmpdir(), "devspace-png-outside-"));
  try {
    await mkdir(join(root, "linked"), { recursive: true });
    await symlink(outside, join(root, "linked", "escape"));
    await assert.rejects(
      importPng({
        destination: join(root, "linked", "escape", "escaped.png"),
        workspaceRoot: root,
        base64Data: PNG.toString("base64"),
      }),
      /outside the workspace root/,
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }

  await writeFile(join(root, "raw", "link-target.png"), PNG);
  await symlink(
    join(root, "raw", "link-target.png"),
    join(root, "raw", "link.png"),
  );
  await assert.rejects(
    importPng({
      destination: join(root, "raw", "link.png"),
      workspaceRoot: root,
      base64Data: PNG.toString("base64"),
      overwrite: true,
    }),
    /symbolic-link/,
  );

  console.log("png import tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
