import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { TaskError } from "./task-errors.js";
import {
  type EnvironmentInfo,
  DEPENDENCY_LOCK_CANDIDATES,
  VENV_CANDIDATES,
} from "./task-runner-types.js";

export interface WorkspacePythonResolutionOptions {
  allowIncompleteTarget?: ".venv" | "venv";
}

export function resolveWorkspacePythonEnvironment(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
  options: WorkspacePythonResolutionOptions = {},
): EnvironmentInfo {
  const scriptsDir = platform === "win32" ? "Scripts" : "bin";
  const pythonName = platform === "win32" ? "python.exe" : "python";

  for (const name of VENV_CANDIDATES) {
    const venvRoot = join(workspaceRoot, name);
    const venvScripts = join(venvRoot, scriptsDir);
    const python = join(venvScripts, pythonName);
    const incompleteMarker = join(venvRoot, ".devspace-bootstrap-incomplete");

    if (!existsSync(python)) continue;
    if (
      existsSync(incompleteMarker) &&
      options.allowIncompleteTarget !== name
    ) {
      continue;
    }

    // Reject symlinked or incomplete venv directories.
    try {
      if (
        lstatSync(venvRoot).isSymbolicLink() ||
        lstatSync(venvScripts).isSymbolicLink() ||
        !statSync(join(venvRoot, "pyvenv.cfg")).isFile() ||
        !statSync(python).isFile()
      ) {
        continue;
      }
    } catch {
      continue;
    }

    // A candidate is usable only when the interpreter starts and reports that
    // sys.prefix is the selected workspace venv. A python-shaped half install
    // must never become the ordinary task runtime.
    let pythonVersion: string;
    try {
      const versionOutput = execFileSync(python, ["--version"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      const match = versionOutput.match(/Python\s+(\S+)/);
      pythonVersion = match ? match[1] : versionOutput;
      const prefixOutput = execFileSync(
        python,
        ["-c", "import os,sys; print(os.path.realpath(sys.prefix))"],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        },
      ).trim();
      const expectedPrefix = realpathSync(venvRoot);
      const normalizeCase = (value: string) =>
        platform === "win32" ? value.toLowerCase() : value;
      if (normalizeCase(prefixOutput) !== normalizeCase(expectedPrefix)) {
        continue;
      }
    } catch {
      continue;
    }

    // Detect dependency lock file
    let dependencyLockPath: string | null = null;
    let dependencyLockSha256: string | null = null;
    for (const candidate of DEPENDENCY_LOCK_CANDIDATES) {
      const lockPath = join(workspaceRoot, candidate);
      if (existsSync(lockPath) && statSync(lockPath).isFile()) {
        dependencyLockPath = candidate;
        dependencyLockSha256 = createHash("sha256")
          .update(readFileSync(lockPath, "utf8"))
          .digest("hex");
        break;
      }
    }

    return {
      resolvedExecutable: python,
      pythonVersion,
      environmentSource: name as ".venv" | "venv",
      dependencyLockPath,
      dependencyLockSha256,
    };
  }

  // No .venv found — TASK_ENVIRONMENT_UNAVAILABLE for workspace-python runtime
  throw new TaskError({
    code: "TASK_ENVIRONMENT_UNAVAILABLE",
    manifestPath: join(workspaceRoot, ".devspace/tasks.yaml"),
    field: "runtime.venv",
    message: `Workspace requires Python virtual environment but neither .venv nor venv was found at ${workspaceRoot}. Create a venv with 'python -m venv .venv'.`,
    recoverable: true,
  });
}
