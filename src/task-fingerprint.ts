/**
 * Input-stability fingerprints for declared project tasks.
 *
 * A test result only signs off the exact source and binary inputs it ran
 * against. When a parallel agent edits C# or overwrites the compiled assembly
 * while a suite is running, the green result must not be reused for the new
 * code. These fingerprints are captured before and after a task so that
 * divergence is detectable from the result alone.
 *
 * The repository keeps its own `tools/analysis/pipeline_build_receipt.py`
 * receipt for the same purpose; this is the DevSpace-side companion that works
 * for any workspace and needs no cooperation from the project.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitSnapshot, sha256 } from "./game-sessions-types.js";

export interface AssemblyFingerprint {
  path: string;
  sha256: string;
  bytes: number;
  modifiedAt: string;
}

export interface TaskInputFingerprint {
  headSha: string | null;
  dirtyDiffSha256: string;
  statusSha256: string;
  untrackedCount: number;
  /** Newest managed assembly under the project's Godot Mono output. */
  assembly: AssemblyFingerprint | null;
  capturedAt: string;
}

export interface TaskInputStability {
  before: TaskInputFingerprint;
  after: TaskInputFingerprint | null;
  /**
   * `stable` — nothing that could change the meaning of the result moved.
   * `changed_during_run` — source or assembly changed mid-run; the result must
   *   not be used to sign off the new inputs.
   * `changed_before_run` — already diverged between plan and execution.
   */
  status: "stable" | "changed_during_run" | "changed_before_run" | "unknown";
  changes: string[];
}

export function captureTaskInputFingerprint(
  workspaceRoot: string,
  projectPath = ".",
): TaskInputFingerprint {
  const git = gitSnapshot(workspaceRoot);
  return {
    headSha: git.headSha ?? null,
    dirtyDiffSha256: git.dirtyDiffSha256,
    statusSha256: git.statusSha256,
    untrackedCount: git.untrackedCount,
    assembly: newestAssembly(projectRootFor(workspaceRoot, projectPath)),
    capturedAt: new Date().toISOString(),
  };
}

export function compareTaskInputs(
  before: TaskInputFingerprint | null,
  after: TaskInputFingerprint | null,
): TaskInputStability {
  const changes: string[] = [];
  if (!before || !after) {
    return {
      before: before ?? (after as TaskInputFingerprint),
      after,
      status: "unknown",
      changes: ["input fingerprint could not be captured for both boundaries"],
    };
  }
  if (before.headSha !== after.headSha) {
    changes.push(`HEAD moved ${before.headSha} -> ${after.headSha}`);
  }
  if (before.dirtyDiffSha256 !== after.dirtyDiffSha256) {
    changes.push("tracked working-tree diff changed");
  }
  if (before.statusSha256 !== after.statusSha256) {
    changes.push("git status changed (files added, removed or untracked)");
  }
  const beforeAssembly = before.assembly?.sha256 ?? null;
  const afterAssembly = after.assembly?.sha256 ?? null;
  if (beforeAssembly !== afterAssembly) {
    changes.push(
      `managed assembly changed ${beforeAssembly ?? "none"} -> ${afterAssembly ?? "none"}`,
    );
  }
  return {
    before,
    after,
    status: changes.length === 0 ? "stable" : "changed_during_run",
    changes,
  };
}

function projectRootFor(workspaceRoot: string, projectPath: string): string {
  return projectPath === "." || projectPath === ""
    ? workspaceRoot
    : join(workspaceRoot, projectPath);
}

/** Newest `.dll` under `.godot/mono/temp/bin`, mirroring the game-session probe. */
export function newestAssembly(projectRoot: string): AssemblyFingerprint | null {
  const binaryRoot = join(projectRoot, ".godot", "mono", "temp", "bin");
  try {
    statSync(binaryRoot);
  } catch {
    return null;
  }
  const candidates: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) {
        candidates.push(full);
      }
    }
  };
  walk(binaryRoot, 0);
  if (candidates.length === 0) return null;
  let newest = candidates[0];
  let newestMtime = -1;
  for (const candidate of candidates) {
    try {
      const mtime = statSync(candidate).mtimeMs;
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newest = candidate;
      }
    } catch {
      // Ignore an assembly that vanished mid-walk.
    }
  }
  try {
    const bytes = readFileSync(newest);
    return {
      path: newest,
      sha256: sha256(bytes),
      bytes: bytes.length,
      modifiedAt: new Date(newestMtime).toISOString(),
    };
  } catch {
    return null;
  }
}
