import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyWorkspacePath,
  createWorkspaceDirectory,
  moveWorkspacePath,
  moveWorkspacePathToTrash,
  restoreWorkspaceFileFromTrash,
  snapshotWorkspaceFileToTrash,
} from "./workspace-files.js";

const root = await mkdtemp(join(tmpdir(), "devspace-files-"));
const additionalRoot = await mkdtemp(
  join(tmpdir(), "devspace-files-additional-"),
);
const stateDir = await mkdtemp(join(tmpdir(), "devspace-files-state-"));
try {
  assert.equal(
    (await createWorkspaceDirectory(root, "assets/raw")).created,
    true,
  );
  assert.equal(
    (await createWorkspaceDirectory(root, "assets/raw")).created,
    false,
  );
  await writeFile(join(root, "assets/raw/a.txt"), "alpha");
  const copied = await copyWorkspacePath({
    workspaceRoot: root,
    stateDir,
    workspaceId: "ws_files",
    sourcePath: "assets/raw/a.txt",
    destinationPath: "assets/copy.txt",
  });
  assert.equal(copied.bytes, 5);
  assert.equal(await readFile(join(root, "assets/copy.txt"), "utf8"), "alpha");
  await copyWorkspacePath({
    workspaceRoot: root,
    sourceRoot: root,
    destinationRoot: additionalRoot,
    stateDir,
    workspaceId: "ws_files",
    sourcePath: "assets/raw/a.txt",
    destinationPath: "from-workspace.txt",
  });
  assert.equal(
    await readFile(join(additionalRoot, "from-workspace.txt"), "utf8"),
    "alpha",
  );
  await writeFile(join(additionalRoot, "from-additional.txt"), "beta");
  await copyWorkspacePath({
    workspaceRoot: root,
    sourceRoot: additionalRoot,
    destinationRoot: root,
    stateDir,
    workspaceId: "ws_files",
    sourcePath: "from-additional.txt",
    destinationPath: "assets/from-additional.txt",
  });
  assert.equal(
    await readFile(join(root, "assets/from-additional.txt"), "utf8"),
    "beta",
  );
  await assert.rejects(
    copyWorkspacePath({
      workspaceRoot: root,
      stateDir,
      workspaceId: "ws_files",
      sourcePath: "assets/raw/a.txt",
      destinationPath: "assets/copy.txt",
    }),
    /PATH_EXISTS/,
  );
  const outside = await mkdtemp(join(tmpdir(), "devspace-files-outside-"));
  try {
    await symlink(outside, join(root, "assets", "escape"));
    await assert.rejects(
      copyWorkspacePath({
        workspaceRoot: root,
        stateDir,
        workspaceId: "ws_files",
        sourcePath: "assets/raw/a.txt",
        destinationPath: "assets/escape/a.txt",
      }),
      /WORKSPACE_ESCAPE/,
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
  const moved = await moveWorkspacePath({
    workspaceRoot: root,
    stateDir,
    workspaceId: "ws_files",
    sourcePath: "assets/copy.txt",
    destinationPath: "assets/moved.txt",
  });
  assert.equal(moved.destinationPath, "assets/moved.txt");
  await writeFile(join(root, "assets/raw/replacement.txt"), "replacement");
  const replaced = await copyWorkspacePath({
    workspaceRoot: root,
    stateDir,
    workspaceId: "ws_files",
    sourcePath: "assets/raw/replacement.txt",
    destinationPath: "assets/moved.txt",
    overwrite: true,
  });
  assert.match(replaced.displacedTrashId ?? "", /^trash_/);
  assert.equal(
    await readFile(
      join(
        stateDir,
        "trash",
        "ws_files",
        replaced.displacedTrashId!,
        "payload",
      ),
      "utf8",
    ),
    "alpha",
  );
  const trash = await moveWorkspacePathToTrash({
    workspaceRoot: root,
    stateDir,
    workspaceId: "ws_files",
    path: "assets/moved.txt",
  });
  assert.match(trash.trashId, /^trash_/);
  await assert.rejects(lstat(join(root, "assets/moved.txt")));
  assert.equal(
    await readFile(
      join(stateDir, "trash", "ws_files", trash.trashId, "payload"),
      "utf8",
    ),
    "replacement",
  );
  await writeFile(join(root, "snapshot.txt"), "before");
  const snapshot = await snapshotWorkspaceFileToTrash({
    workspaceRoot: root,
    stateDir,
    workspaceId: "ws_files",
    path: "snapshot.txt",
  });
  assert.equal(await readFile(join(root, "snapshot.txt"), "utf8"), "before");
  await writeFile(join(root, "snapshot.txt"), "after");
  await restoreWorkspaceFileFromTrash({
    workspaceRoot: root,
    stateDir,
    workspaceId: "ws_files",
    trashId: snapshot.trashId,
    path: "snapshot.txt",
  });
  assert.equal(await readFile(join(root, "snapshot.txt"), "utf8"), "before");
  await mkdir(join(root, "tree"), { recursive: true });
  await writeFile(join(root, "tree", "x.txt"), "x");
  await assert.rejects(
    moveWorkspacePath({
      workspaceRoot: root,
      stateDir,
      workspaceId: "ws_files",
      sourcePath: "tree",
      destinationPath: "tree/nested",
    }),
    /Cannot move a directory inside itself/,
  );
  await symlink(join(root, "tree", "x.txt"), join(root, "tree", "link.txt"));
  await assert.rejects(
    copyWorkspacePath({
      workspaceRoot: root,
      stateDir,
      workspaceId: "ws_files",
      sourcePath: "tree",
      destinationPath: "tree-copy",
    }),
    /symbolic.?link/i,
  );
  console.log("workspace file tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(additionalRoot, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}
