import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from "./pi-tools.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "devspace-pi-workspace-"));
const additionalRoot = await mkdtemp(join(tmpdir(), "devspace-pi-additional-"));

try {
  const sourcePath = join(additionalRoot, "reference.txt");
  await writeFile(sourcePath, "needle before\n");
  const readContext = {
    cwd: workspaceRoot,
    root: workspaceRoot,
    readRoots: [workspaceRoot, additionalRoot],
  };
  const read = await readFileTool({ path: sourcePath }, readContext);
  assert.equal(read.isError, undefined);
  assert.match(
    read.content[0]?.type === "text" ? read.content[0].text : "",
    /needle/,
  );

  const listed = await listDirectoryTool({ path: additionalRoot }, readContext);
  assert.equal(listed.isError, undefined);
  assert.match(
    listed.content[0]?.type === "text" ? listed.content[0].text : "",
    /reference\.txt/,
  );

  const grepped = await grepFilesTool(
    { pattern: "needle", path: additionalRoot },
    readContext,
  );
  assert.equal(grepped.isError, undefined);
  assert.match(
    grepped.content[0]?.type === "text" ? grepped.content[0].text : "",
    /needle/,
  );

  const found = await findFilesTool(
    { pattern: "*.txt", path: additionalRoot },
    readContext,
  );
  assert.equal(found.isError, undefined);
  assert.match(
    found.content[0]?.type === "text" ? found.content[0].text : "",
    /reference\.txt/,
  );

  await assert.rejects(() =>
    writeFileTool(
      { path: join(additionalRoot, "denied.txt"), content: "denied" },
      {
        cwd: workspaceRoot,
        root: workspaceRoot,
        writeRoots: [workspaceRoot],
      },
    ),
  );

  const writeContext = {
    cwd: workspaceRoot,
    root: workspaceRoot,
    writeRoots: [workspaceRoot, additionalRoot],
  };
  assert.equal(
    (
      await writeFileTool(
        { path: join(additionalRoot, "created.txt"), content: "created\n" },
        writeContext,
      )
    ).isError,
    undefined,
  );
  assert.equal(
    (
      await editFileTool(
        {
          path: sourcePath,
          edits: [{ oldText: "before", newText: "after" }],
        },
        writeContext,
      )
    ).isError,
    undefined,
  );
  assert.equal(await readFile(sourcePath, "utf8"), "needle after\n");

  console.log("PASS: Pi file tools operate across authorized additional roots");
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(additionalRoot, { recursive: true, force: true });
}
