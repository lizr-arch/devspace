import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";

const root = mkdtempSync(join(tmpdir(), "devspace-pi-tools-"));
const context = { cwd: root, root };

try {
  writeFileSync(join(root, "source.txt"), "alpha\nbeta\n", "utf8");

  const read = await readFileTool({ path: "source.txt" }, context);
  assert.equal(read.isError, undefined);
  assert.match(textContent(read.content), /alpha/);

  const write = await writeFileTool(
    { path: "written.txt", content: "before\n" },
    context,
  );
  assert.equal(write.isError, undefined);
  assert.equal(readFileSync(join(root, "written.txt"), "utf8"), "before\n");

  const edit = await editFileTool(
    {
      path: "written.txt",
      edits: [{ oldText: "before", newText: "after" }],
    },
    context,
  );
  assert.equal(edit.isError, undefined);
  assert.equal(readFileSync(join(root, "written.txt"), "utf8"), "after\n");

  const grep = await grepFilesTool({ pattern: "beta", path: "." }, context);
  assert.equal(grep.isError, undefined);
  assert.match(textContent(grep.content), /source\.txt/);

  const find = await findFilesTool({ pattern: "*.txt", path: "." }, context);
  assert.equal(find.isError, undefined);
  assert.match(textContent(find.content), /written\.txt/);

  const list = await listDirectoryTool({ path: "." }, context);
  assert.equal(list.isError, undefined);
  assert.match(textContent(list.content), /source\.txt/);

  const shell = await runShellTool({ command: "pwd", timeout: 5 }, context);
  assert.equal(shell.isError, undefined);
  assert.match(textContent(shell.content), new RegExp(escapeRegExp(root)));

  await assert.rejects(
    () => readFileTool({ path: "../outside.txt" }, context),
    /outside allowed roots/i,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Pi coding primitive tests passed");

function textContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((item) => (item.type === "text" ? (item.text ?? "") : ""))
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
