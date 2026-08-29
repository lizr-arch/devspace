import {
  execFileSync,
  type ChildProcessByStdio,
} from "node:child_process";
import { createHash } from "node:crypto";
import type { Server, Socket } from "node:net";
import type { Readable } from "node:stream";

export const MAX_GAME_LOG_READ_BYTES = 256 * 1024;
export const MAX_GAME_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_PROTOCOL_BYTES = 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const STOP_GRACE_MS = 3_000;
export const MAX_GAME_SESSIONS = 2;

export type GameSessionStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"
  | "interrupted";

export interface GameTreeNode {
  path: string;
  type: string;
  childCount: number;
  visible: boolean | null;
}

export interface GameSessionSnapshot {
  sessionId: string;
  workspaceId: string;
  projectPath: string;
  scene: string;
  engine: "godot" | "godot-mono";
  engineVersion?: string;
  viewport: { width: number; height: number };
  status: GameSessionStatus;
  startedAt: string;
  endedAt?: string;
  headSha?: string;
  dirtyDiffSha256: string;
  statusSha256: string;
  untrackedCount: number;
  processId?: number;
  processGroupId?: number;
  lastHeartbeatAt?: string;
  exitCode?: number;
  signal?: string;
  error?: string;
  nodes?: GameTreeNode[];
}

export interface LiveSession extends GameSessionSnapshot {
  workspaceRoot: string;
  processToken?: string;
  child?: ChildProcessByStdio<null, Readable, Readable>;
  bridgeServer?: Server;
  socket?: Socket;
  bridgeToken?: string;
  receiveBuffer?: string;
  pending?: Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  stopRequested?: boolean;
}

export function validateNodes(value: unknown): GameTreeNode[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).map((entry) => {
    const item =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    return {
      path: String(item.path ?? "").slice(0, 1024),
      type: String(item.type ?? "").slice(0, 128),
      childCount: numberField(item.childCount, 0),
      visible: typeof item.visible === "boolean" ? item.visible : null,
    };
  });
}

export function publicSnapshot(session: LiveSession): GameSessionSnapshot {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    projectPath: session.projectPath,
    scene: session.scene,
    engine: session.engine,
    engineVersion: session.engineVersion,
    viewport: { ...session.viewport },
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    headSha: session.headSha,
    dirtyDiffSha256: session.dirtyDiffSha256,
    statusSha256: session.statusSha256,
    untrackedCount: session.untrackedCount,
    processId: session.processId,
    processGroupId: session.processGroupId,
    lastHeartbeatAt: session.lastHeartbeatAt,
    exitCode: session.exitCode,
    signal: session.signal,
    error: session.error,
    nodes: session.nodes?.map((node) => ({ ...node })),
  };
}

export function gitSnapshot(
  workspaceRoot: string,
): Pick<
  GameSessionSnapshot,
  "headSha" | "dirtyDiffSha256" | "statusSha256" | "untrackedCount"
> {
  try {
    const headSha = git(workspaceRoot, ["rev-parse", "HEAD"]).trim();
    const dirty = gitBuffer(workspaceRoot, ["diff", "--binary", "HEAD"]);
    const status = gitBuffer(workspaceRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    return {
      headSha,
      dirtyDiffSha256: sha256(dirty),
      statusSha256: sha256(status),
      untrackedCount: status
        .toString("utf8")
        .split("\0")
        .filter((entry) => entry.startsWith("?? ")).length,
    };
  } catch {
    const empty = sha256(Buffer.alloc(0));
    return {
      dirtyDiffSha256: empty,
      statusSha256: empty,
      untrackedCount: 0,
    };
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

export function isTerminal(status: GameSessionStatus): boolean {
  return ["stopped", "crashed", "interrupted"].includes(status);
}

export function waitForExit(
  child: ChildProcessByStdio<null, Readable, Readable> | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function terminatePersistedProcess(
  session: LiveSession,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (
    process.platform === "win32" ||
    !session.processGroupId ||
    !session.processToken ||
    !processGroupContainsToken(session.processGroupId, session.processToken)
  ) {
    return;
  }
  try {
    process.kill(-session.processGroupId, signal);
  } catch {
    // Already exited.
  }
}

export function processGroupContainsToken(
  processGroupId: number,
  processToken: string,
): boolean {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8",
    });
    for (const row of rows.split("\n")) {
      const match = row.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match || Number(match[2]) !== processGroupId) continue;
      const environment = execFileSync(
        "ps",
        ["-E", "-p", match[1], "-o", "command="],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      if (environment.includes(`DEVSPACE_PROCESS_TOKEN=${processToken}`)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
