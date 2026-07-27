import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  BackgroundJobManager,
  resolveWorkspacePytestInvocation,
} from "./background-jobs.js";
import { RunnerRegistry } from "./runner-registry.js";

const root = mkdtempSync(join(tmpdir(), "devspace-pytest-venv-"));

try {
  const parentVenv = join(root, ".venv", "bin");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(parentVenv, { recursive: true });
  mkdirSync(workspaceRoot);
  writeFileSync(join(parentVenv, "python"), "");
  assert.equal(resolveWorkspacePytestInvocation(workspaceRoot), undefined);

  const venvBin = join(workspaceRoot, ".venv", "bin");
  mkdirSync(venvBin, { recursive: true });
  const venvPython = join(venvBin, "python");
  writeFileSync(
    venvPython,
    `#!${process.execPath}
if (process.argv.slice(2).join(" ") === "-m pytest --version") {
  console.log("pytest 9.0.0-workspace");
  process.exit(0);
}
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  virtualEnv: process.env.VIRTUAL_ENV
}));
`,
  );
  chmodSync(venvPython, 0o700);

  const invocation = resolveWorkspacePytestInvocation(workspaceRoot);
  assert.equal(invocation?.executable, venvPython);
  assert.deepEqual(invocation?.argsPrefix, ["-m", "pytest"]);
  assert.equal(invocation?.venvRoot, join(workspaceRoot, ".venv"));

  const manager = new BackgroundJobManager(
    join(root, "state"),
    new RunnerRegistry({}, process.platform, {
      HOME: root,
      PATH: ["/usr/bin", "/bin"].join(delimiter),
    }),
  );
  try {
    const started = await manager.start({
      workspaceId: "ws_pytest",
      workspaceRoot,
      workingDirectory: workspaceRoot,
      runner: "pytest",
      args: ["tests"],
      timeoutSeconds: 30,
    });
    const completed = await waitForTerminal(manager, started.jobId);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.runnerVersion, "pytest 9.0.0-workspace");
    assert.match(completed.output ?? "", /"-m","pytest","tests"/);
    assert.match(
      completed.output ?? "",
      new RegExp(
        `"virtualEnv":${JSON.stringify(join(workspaceRoot, ".venv"))}`,
      ),
    );
  } finally {
    manager.close();
  }

  if (process.platform !== "win32") {
    const symlinkWorkspace = join(root, "symlink-workspace");
    const externalVenv = join(root, "external-venv");
    mkdirSync(symlinkWorkspace);
    mkdirSync(join(externalVenv, "bin"), { recursive: true });
    writeFileSync(join(externalVenv, "bin", "python"), "");
    symlinkSync(externalVenv, join(symlinkWorkspace, ".venv"));
    assert.equal(resolveWorkspacePytestInvocation(symlinkWorkspace), undefined);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function waitForTerminal(manager: BackgroundJobManager, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = manager.poll(jobId);
    if (snapshot.status !== "running" && snapshot.status !== "cancelling") {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}
