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

/**
 * Renderer identity reported by the in-engine Runtime Bridge. This is what
 * separates real GPU evidence from a headless/dummy-renderer run: a headless
 * Godot session reports `displayServer: "headless"` and a `dummy` driver, and
 * must never be labelled GUI visual evidence.
 */
export interface GameRenderInfo {
  displayServer: string;
  renderingMethod: string;
  renderingDriver: string;
  projectRenderingMethod: string;
  adapterName: string;
  adapterVendor: string;
  adapterApiVersion: string;
  windowSize: [number, number];
  viewportSize: [number, number];
  isHeadless: boolean;
  isDummyDriver: boolean;
}

export type GameGuiVerdict = "real_gpu" | "headless_not_gui" | "unknown";

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
  /** Additive: real-renderer identity and GUI evidence verdict. */
  renderInfo?: GameRenderInfo;
  guiVerdict?: GameGuiVerdict;
  bridgeProtocol?: number;
  sceneGeneration?: number;
  /** Input still latched inside the engine; always empty on a clean stop. */
  pressedInput?: { mouse: number[]; keys: number[]; actions: string[] };
  /** Additive: how the session ended, including cleanup diagnostics. */
  stopDiagnostics?: GameStopDiagnostics;
}

export interface GameStopDiagnostics {
  releasedInputs: boolean;
  residualPressedInput: { mouse: number[]; keys: number[]; actions: string[] };
  processGroupReaped: boolean;
  gracePath: "bridge_quit" | "sigterm" | "sigkill" | "already_exited";
}

/**
 * Machine-readable sidecar written next to every captured frame. Fields that
 * cannot be established are reported as `"unknown"` — never guessed.
 */
export interface GameCaptureManifest {
  manifestVersion: 1;
  frameId: string;
  sessionId: string;
  workspaceId: string;
  capturedAt: string;
  image: {
    path: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
  };
  scene: string;
  sceneGeneration: number | "unknown";
  /**
   * Every PackedScene instance currently parented under the engine root. A
   * healthy session has exactly one; more than one proves a replaced scene was
   * left rendering underneath (the Phase 17 residue defect).
   */
  sceneInstances: string[];
  projectPath: string;
  workspaceRoot: string;
  engine: string;
  engineVersion: string;
  bridgeProtocol: number | "unknown";
  render: GameRenderInfo | "unknown";
  guiVerdict: GameGuiVerdict;
  git: {
    headSha: string;
    dirtyDiffSha256: string;
    statusSha256: string;
    untrackedCount: number;
  };
  assembly: {
    path: string;
    sha256: string;
    bytes: number;
  } | "unknown";
  frameTiming: {
    requestedAt: number | "unknown";
    capturedAt: number | "unknown";
  };
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
  handshakeElapsedMs?: number;
  logBytesAtHandshake?: number;
  engineExecutable?: string;
}

/**
 * Derive the GUI evidence verdict from in-engine renderer facts. Anything we
 * cannot positively establish stays `unknown` rather than being optimistically
 * reported as real.
 */
export function deriveGuiVerdict(
  info: GameRenderInfo | undefined,
): GameGuiVerdict {
  if (!info) return "unknown";
  const driver = info.renderingDriver.toLowerCase();
  if (info.isHeadless || driver === "dummy" || driver === "") {
    return "headless_not_gui";
  }
  if (info.displayServer.toLowerCase() === "headless") {
    return "headless_not_gui";
  }
  return "real_gpu";
}

export function toRenderInfo(value: unknown): GameRenderInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const pair = (input: unknown): [number, number] => {
    if (!Array.isArray(input) || input.length < 2) return [0, 0];
    return [numberField(input[0], 0), numberField(input[1], 0)];
  };
  const text = (input: unknown): string =>
    typeof input === "string" ? input : "";
  const driver = text(raw.renderingDriver);
  const displayServer = text(raw.displayServer);
  return {
    displayServer,
    renderingMethod: text(raw.renderingMethod),
    renderingDriver: driver,
    projectRenderingMethod: text(raw.projectRenderingMethod),
    adapterName: text(raw.adapterName),
    adapterVendor: text(raw.adapterVendor),
    adapterApiVersion: text(raw.adapterApiVersion),
    windowSize: pair(raw.windowSize),
    viewportSize: pair(raw.viewportSize),
    isHeadless: raw.isHeadless === true || displayServer === "headless",
    isDummyDriver: raw.isDummyDriver === true || driver === "dummy",
  };
}

export function toPressedState(
  value: unknown,
): { mouse: number[]; keys: number[]; actions: string[] } {
  const empty = { mouse: [], keys: [], actions: [] };
  if (!value || typeof value !== "object") return empty;
  const raw = value as Record<string, unknown>;
  const numbers = (input: unknown): number[] =>
    Array.isArray(input)
      ? input.map((entry) => numberField(entry, -1)).filter((n) => n >= 0)
      : [];
  const strings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((entry): entry is string => typeof entry === "string")
      : [];
  return {
    mouse: numbers(raw.mouse),
    keys: numbers(raw.keys),
    actions: strings(raw.actions),
  };
}

export function isEmptyPressedState(state: {
  mouse: number[];
  keys: number[];
  actions: string[];
}): boolean {
  return (
    state.mouse.length === 0 &&
    state.keys.length === 0 &&
    state.actions.length === 0
  );
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
    renderInfo: session.renderInfo ? { ...session.renderInfo } : undefined,
    guiVerdict: session.guiVerdict,
    bridgeProtocol: session.bridgeProtocol,
    sceneGeneration: session.sceneGeneration,
    pressedInput: session.pressedInput
      ? {
          mouse: [...session.pressedInput.mouse],
          keys: [...session.pressedInput.keys],
          actions: [...session.pressedInput.actions],
        }
      : undefined,
    stopDiagnostics: session.stopDiagnostics
      ? { ...session.stopDiagnostics }
      : undefined,
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
