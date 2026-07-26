import {
  execFileSync,
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { Readable } from "node:stream";
import { resolveExistingWorkspacePath } from "./workspace-paths.js";
import { GODOT_RUNTIME_BRIDGE } from "./godot-runtime-bridge.js";
import { RunnerRegistry, type RunnerName } from "./runner-registry.js";

export const MAX_GAME_LOG_READ_BYTES = 256 * 1024;
const MAX_GAME_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 3_000;
const MAX_GAME_SESSIONS = 2;

export type GameSessionStatus =
  "starting" | "running" | "stopping" | "stopped" | "crashed" | "interrupted";

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
  processToken?: string;
  lastHeartbeatAt?: string;
  exitCode?: number;
  signal?: string;
  error?: string;
  nodes?: GameTreeNode[];
}

interface LiveSession extends GameSessionSnapshot {
  workspaceRoot: string;
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

export class GameSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly sessionsDir: string;
  private readonly evidenceDir: string;
  private readonly bridgePath: string;
  private initialized = false;

  constructor(
    private readonly stateDir: string,
    private readonly runners = new RunnerRegistry(),
  ) {
    this.sessionsDir = join(stateDir, "game-sessions");
    this.evidenceDir = join(stateDir, "game-session-evidence");
    this.bridgePath = join(stateDir, "runtime", "godot-session-bridge.gd");
  }

  async start(input: {
    workspaceId: string;
    workspaceRoot: string;
    projectPath: string;
    scene: string;
    engine?: "auto" | "godot" | "godot-mono";
    viewportWidth?: number;
    viewportHeight?: number;
  }): Promise<GameSessionSnapshot> {
    this.initialize();
    this.assertCapacity(input.workspaceId);
    const project = resolveExistingWorkspacePath(
      input.workspaceRoot,
      input.projectPath,
      "directory",
    );
    if (!existsSync(join(project.absolutePath, "project.godot"))) {
      throw new Error(
        "GAME_SESSION_PROJECT_INVALID: projectPath must contain project.godot.",
      );
    }
    validateScene(input.scene);
    const width = validateViewport(input.viewportWidth ?? 1280, "width");
    const height = validateViewport(input.viewportHeight ?? 720, "height");
    const resolvedEngine = await this.resolveEngine(
      input.engine ?? "auto",
      project.absolutePath,
    );
    const git = gitSnapshot(input.workspaceRoot);
    const sessionId = `session_${randomUUID()}`;
    const token = randomUUID();
    const session: LiveSession = {
      sessionId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      projectPath: project.relativePath,
      scene: input.scene,
      engine: resolvedEngine.name,
      engineVersion: resolvedEngine.version,
      viewport: { width, height },
      status: "starting",
      startedAt: new Date().toISOString(),
      ...git,
      bridgeToken: token,
      receiveBuffer: "",
      pending: new Map(),
    };
    mkdirSync(this.sessionEvidencePath(sessionId), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(this.logPath(sessionId), "", { mode: 0o600 });
    this.sessions.set(sessionId, session);
    this.persist(session);

    try {
      const handshake = await this.spawnAndHandshake(
        session,
        resolvedEngine.executable,
        project.absolutePath,
        token,
      );
      session.engineVersion =
        typeof handshake.engineVersion === "string"
          ? handshake.engineVersion
          : resolvedEngine.version;
      session.status = "running";
      session.lastHeartbeatAt = new Date().toISOString();
      this.appendLog(session, "[bridge] authenticated\n");
      this.persist(session);
      return publicSnapshot(session);
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
      session.status = "crashed";
      session.endedAt = new Date().toISOString();
      this.terminate(session, "SIGKILL");
      this.persist(session);
      throw error;
    }
  }

  async inspect(
    workspaceId: string,
    sessionId: string,
  ): Promise<GameSessionSnapshot> {
    const session = this.getOwned(workspaceId, sessionId);
    if (session.status === "running") {
      const result = await this.request(session, "inspect", {});
      session.nodes = validateNodes(result.nodes);
      this.persist(session);
    }
    return publicSnapshot(session);
  }

  async sendInput(
    workspaceId: string,
    sessionId: string,
    input:
      | {
          kind: "action";
          action: string;
          operation: "press" | "release" | "tap";
          strength?: number;
          frames?: number;
        }
      | {
          kind: "click";
          x: number;
          y: number;
          button: "left" | "right" | "middle";
        },
  ): Promise<{ accepted: true }> {
    const session = this.getRunning(workspaceId, sessionId);
    if (input.kind === "action") {
      if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(input.action)) {
        throw new Error("GAME_SESSION_INPUT_INVALID: Invalid action name.");
      }
      const strength = input.strength ?? 1;
      const frames = input.frames ?? 1;
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
        throw new Error("GAME_SESSION_INPUT_INVALID: strength must be 0-1.");
      }
      if (!Number.isInteger(frames) || frames < 1 || frames > 120) {
        throw new Error(
          "GAME_SESSION_INPUT_INVALID: tap frames must be 1-120.",
        );
      }
      await this.request(session, "action", {
        action: input.action,
        operation: input.operation,
        strength,
        frames,
      });
    } else {
      if (
        !Number.isFinite(input.x) ||
        !Number.isFinite(input.y) ||
        input.x < 0 ||
        input.y < 0 ||
        input.x >= session.viewport.width ||
        input.y >= session.viewport.height
      ) {
        throw new Error(
          "GAME_SESSION_INPUT_INVALID: Click must be inside the viewport.",
        );
      }
      await this.request(session, "click", {
        x: input.x,
        y: input.y,
        buttonIndex: { left: 1, right: 2, middle: 3 }[input.button],
      });
    }
    return { accepted: true };
  }

  async capture(
    workspaceId: string,
    sessionId: string,
  ): Promise<{
    frameId: string;
    path: string;
    width: number;
    height: number;
    capturedAt: string;
    sha256: string;
    bytes: number;
    data: string;
  }> {
    const session = this.getRunning(workspaceId, sessionId);
    const frameId = `frame_${randomUUID()}`;
    const path = join(this.sessionEvidencePath(sessionId), `${frameId}.png`);
    const result = await this.request(session, "capture", { path }, 15_000);
    if (!existsSync(path)) {
      throw new Error("GAME_SESSION_CAPTURE_FAILED: Frame was not written.");
    }
    const bytes = readFileSync(path);
    if (
      bytes.length < 8 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      throw new Error("GAME_SESSION_CAPTURE_FAILED: Invalid PNG evidence.");
    }
    return {
      frameId,
      path,
      width: numberField(result.width, session.viewport.width),
      height: numberField(result.height, session.viewport.height),
      capturedAt: new Date().toISOString(),
      sha256: sha256(bytes),
      bytes: bytes.length,
      data: bytes.toString("base64"),
    };
  }

  readLogs(
    workspaceId: string,
    sessionId: string,
    offsetBytes = 0,
    maxBytes = 64 * 1024,
  ): {
    output: string;
    outputOffsetBytes: number;
    nextOutputOffsetBytes: number;
    totalBytes: number;
    truncated: boolean;
  } {
    const session = this.getOwned(workspaceId, sessionId);
    if (!Number.isInteger(offsetBytes) || offsetBytes < 0) {
      throw new Error("GAME_SESSION_LOG_OFFSET_INVALID");
    }
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_GAME_LOG_READ_BYTES
    ) {
      throw new Error("GAME_SESSION_LOG_LIMIT_INVALID");
    }
    const log = readFileSync(this.logPath(session.sessionId));
    const start = Math.min(offsetBytes, log.length);
    const end = Math.min(start + maxBytes, log.length);
    return {
      output: log.subarray(start, end).toString("utf8"),
      outputOffsetBytes: start,
      nextOutputOffsetBytes: end,
      totalBytes: log.length,
      truncated: end < log.length,
    };
  }

  async stop(
    workspaceId: string,
    sessionId: string,
  ): Promise<GameSessionSnapshot> {
    const session = this.getOwned(workspaceId, sessionId);
    if (isTerminal(session.status)) return publicSnapshot(session);
    session.stopRequested = true;
    session.status = "stopping";
    this.persist(session);
    await this.request(session, "quit", {}, 1_000).catch(() => undefined);
    await waitForExit(session.child, STOP_GRACE_MS);
    if (!isTerminal(session.status)) this.terminate(session, "SIGTERM");
    await waitForExit(session.child, 1_000);
    if (!isTerminal(session.status)) this.terminate(session, "SIGKILL");
    if (!isTerminal(session.status)) {
      session.status = "stopped";
      session.endedAt = new Date().toISOString();
      this.persist(session);
    }
    return publicSnapshot(session);
  }

  close(): void {
    this.initialize();
    for (const session of this.sessions.values()) {
      if (isTerminal(session.status)) continue;
      session.status = "interrupted";
      session.endedAt = new Date().toISOString();
      session.error =
        "GAME_SESSION_INTERRUPTED: DevSpace stopped during the session.";
      this.terminate(session, "SIGTERM");
      this.persist(session);
    }
  }

  private initialize(): void {
    if (this.initialized) return;
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.stateDir, "runtime"), { recursive: true, mode: 0o700 });
    chmodSync(this.sessionsDir, 0o700);
    writeFileSync(this.bridgePath, GODOT_RUNTIME_BRIDGE, { mode: 0o600 });
    for (const entry of readdirSync(this.sessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          readFileSync(join(this.sessionsDir, entry), "utf8"),
        ) as LiveSession;
        validateSessionId(parsed.sessionId);
        if (parsed.status === "running" || parsed.status === "starting") {
          parsed.status = "interrupted";
          parsed.endedAt = new Date().toISOString();
          parsed.error =
            "GAME_SESSION_INTERRUPTED: DevSpace restarted during the session.";
          terminatePersistedProcess(parsed);
        }
        this.sessions.set(parsed.sessionId, parsed);
        this.persist(parsed);
      } catch {
        // Ignore malformed persisted state.
      }
    }
    this.initialized = true;
  }

  private async resolveEngine(
    requested: "auto" | "godot" | "godot-mono",
    projectRoot: string,
  ): Promise<{
    name: "godot" | "godot-mono";
    executable: string;
    version?: string;
  }> {
    const csharp = readdirSync(projectRoot).some((entry) =>
      entry.toLowerCase().endsWith(".csproj"),
    );
    const order: RunnerName[] =
      requested === "auto"
        ? csharp
          ? ["godot-mono", "godot"]
          : ["godot", "godot-mono"]
        : [requested];
    let lastError: unknown;
    for (const name of order) {
      try {
        const resolved = await this.runners.resolve(name);
        return {
          name: name as "godot" | "godot-mono",
          executable: resolved.executable,
          version: resolved.version,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `GAME_SESSION_ENGINE_UNAVAILABLE: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private async spawnAndHandshake(
    session: LiveSession,
    executable: string,
    projectRoot: string,
    token: string,
  ): Promise<Record<string, unknown>> {
    const bridge = createServer();
    session.bridgeServer = bridge;
    await new Promise<void>((resolve, reject) => {
      bridge.once("error", reject);
      bridge.listen(0, "127.0.0.1", () => resolve());
    });
    const address = bridge.address();
    if (!address || typeof address === "string") {
      throw new Error("GAME_SESSION_BRIDGE_FAILED: No loopback port.");
    }
    const processToken = randomUUID();
    const child = spawn(
      executable,
      [
        "--headless",
        "--path",
        projectRoot,
        "--resolution",
        `${session.viewport.width}x${session.viewport.height}`,
        "--script",
        this.bridgePath,
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          DEVSPACE_BRIDGE_PORT: String(address.port),
          DEVSPACE_BRIDGE_TOKEN: token,
          DEVSPACE_GAME_SCENE: session.scene,
          DEVSPACE_PROCESS_TOKEN: processToken,
        },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    session.child = child;
    session.processId = child.pid;
    session.processGroupId =
      process.platform === "win32" ? undefined : child.pid;
    session.processToken = processToken;
    this.persist(session);
    child.stdout.on("data", (data) => this.appendLog(session, data));
    child.stderr.on("data", (data) => this.appendLog(session, data));
    child.once("error", (error) => {
      session.error = `GAME_SESSION_PROCESS_FAILED: ${error.message}`;
    });
    child.once("exit", (code, signal) => this.onExit(session, code, signal));

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("GAME_SESSION_HANDSHAKE_TIMEOUT"));
      }, HANDSHAKE_TIMEOUT_MS);
      bridge.once("connection", (socket) => {
        session.socket = socket;
        bridge.close();
        this.consumeSocket(session, socket, (hello) => {
          if (hello.token !== token) {
            clearTimeout(timer);
            reject(new Error("GAME_SESSION_AUTH_FAILED"));
            return;
          }
          clearTimeout(timer);
          resolve(hello);
        });
      });
    });
  }

  private consumeSocket(
    session: LiveSession,
    socket: Socket,
    onHello: (message: Record<string, unknown>) => void,
  ): void {
    let greeted = false;
    socket.on("data", (chunk) => {
      session.receiveBuffer = (session.receiveBuffer ?? "") + chunk.toString();
      if (Buffer.byteLength(session.receiveBuffer) > MAX_PROTOCOL_BYTES) {
        socket.destroy(new Error("GAME_SESSION_PROTOCOL_TOO_LARGE"));
        return;
      }
      let newline = session.receiveBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = session.receiveBuffer.slice(0, newline);
        session.receiveBuffer = session.receiveBuffer.slice(newline + 1);
        newline = session.receiveBuffer.indexOf("\n");
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.destroy(new Error("GAME_SESSION_PROTOCOL_INVALID"));
          return;
        }
        if (!greeted) {
          if (message.type !== "hello") {
            socket.destroy(new Error("GAME_SESSION_AUTH_FAILED"));
            return;
          }
          greeted = true;
          onHello(message);
          continue;
        }
        if (message.type === "heartbeat") {
          session.lastHeartbeatAt = new Date().toISOString();
          continue;
        }
        if (message.type === "response" && typeof message.id === "string") {
          const pending = session.pending?.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          session.pending?.delete(message.id);
          if (typeof message.error === "string" && message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(
              message.result && typeof message.result === "object"
                ? (message.result as Record<string, unknown>)
                : {},
            );
          }
        }
      }
    });
  }

  private request(
    session: LiveSession,
    command: string,
    data: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (!session.socket || session.socket.destroyed) {
      return Promise.reject(new Error("GAME_SESSION_BRIDGE_UNAVAILABLE"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending?.delete(id);
        reject(new Error("GAME_SESSION_REQUEST_TIMEOUT"));
      }, timeoutMs);
      session.pending?.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ id, command, ...data }) + "\n";
      if (Buffer.byteLength(payload) > MAX_PROTOCOL_BYTES) {
        clearTimeout(timer);
        session.pending?.delete(id);
        reject(new Error("GAME_SESSION_PROTOCOL_TOO_LARGE"));
        return;
      }
      session.socket!.write(payload);
    });
  }

  private onExit(
    session: LiveSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    for (const pending of session.pending?.values() ?? []) {
      clearTimeout(pending.timer);
      pending.reject(new Error("GAME_SESSION_PROCESS_EXITED"));
    }
    session.pending?.clear();
    session.exitCode = code ?? undefined;
    session.signal = signal ?? undefined;
    session.endedAt = new Date().toISOString();
    session.status =
      session.stopRequested || session.status === "stopping"
        ? "stopped"
        : code === 0
          ? "stopped"
          : "crashed";
    if (session.status === "crashed" && !session.error) {
      session.error = `GAME_SESSION_CRASHED: exit=${code ?? "null"} signal=${signal ?? "none"}`;
    }
    this.appendLog(
      session,
      `[bridge] process exited code=${code ?? "null"} signal=${signal ?? "none"}\n`,
    );
    this.persist(session);
  }

  private appendLog(session: LiveSession, data: Buffer | string): void {
    const current = statSync(this.logPath(session.sessionId)).size;
    if (current >= MAX_GAME_LOG_BYTES) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    appendFileSync(
      this.logPath(session.sessionId),
      bytes.subarray(0, MAX_GAME_LOG_BYTES - current),
      { mode: 0o600 },
    );
  }

  private assertCapacity(workspaceId: string): void {
    const running = Array.from(this.sessions.values()).filter(
      (session) => !isTerminal(session.status),
    );
    if (running.some((session) => session.workspaceId === workspaceId)) {
      throw new Error("GAME_SESSION_WORKSPACE_BUSY");
    }
    if (running.length >= MAX_GAME_SESSIONS) {
      throw new Error("GAME_SESSION_LIMIT_REACHED");
    }
  }

  private getOwned(workspaceId: string, sessionId: string): LiveSession {
    this.initialize();
    validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("GAME_SESSION_NOT_FOUND");
    if (session.workspaceId !== workspaceId) {
      throw new Error("GAME_SESSION_WORKSPACE_MISMATCH");
    }
    return session;
  }

  private getRunning(workspaceId: string, sessionId: string): LiveSession {
    const session = this.getOwned(workspaceId, sessionId);
    if (session.status !== "running") {
      throw new Error("GAME_SESSION_NOT_RUNNING");
    }
    return session;
  }

  private terminate(session: LiveSession, signal: NodeJS.Signals): void {
    if (!session.processId) return;
    try {
      if (process.platform !== "win32" && session.processGroupId) {
        process.kill(-session.processGroupId, signal);
      } else {
        session.child?.kill(signal);
      }
    } catch {
      // Already exited.
    }
    session.socket?.destroy();
    session.bridgeServer?.close();
  }

  private persist(session: LiveSession): void {
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    const persisted = publicSnapshot(session);
    writeFileSync(
      join(this.sessionsDir, `${session.sessionId}.json`),
      JSON.stringify(persisted, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  private logPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.log`);
  }

  private sessionEvidencePath(sessionId: string): string {
    return join(this.evidenceDir, sessionId);
  }
}

function validateScene(scene: string): void {
  if (
    !scene.startsWith("res://") ||
    scene.includes("\\") ||
    scene.includes("\0") ||
    scene.split("/").includes("..") ||
    !scene.toLowerCase().endsWith(".tscn")
  ) {
    throw new Error("GAME_SESSION_SCENE_INVALID");
  }
}

function validateViewport(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 64 || value > 4096) {
    throw new Error(`GAME_SESSION_VIEWPORT_INVALID: ${label} must be 64-4096.`);
  }
  return value;
}

function validateSessionId(sessionId: string): void {
  if (!/^session_[0-9a-f-]{36}$/.test(sessionId)) {
    throw new Error("GAME_SESSION_ID_INVALID");
  }
}

function validateNodes(value: unknown): GameTreeNode[] {
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

function publicSnapshot(session: LiveSession): GameSessionSnapshot {
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
    processToken: session.processToken,
    lastHeartbeatAt: session.lastHeartbeatAt,
    exitCode: session.exitCode,
    signal: session.signal,
    error: session.error,
    nodes: session.nodes?.map((node) => ({ ...node })),
  };
}

function gitSnapshot(
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

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function isTerminal(status: GameSessionStatus): boolean {
  return ["stopped", "crashed", "interrupted"].includes(status);
}

function waitForExit(
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

function terminatePersistedProcess(session: LiveSession): void {
  if (
    process.platform === "win32" ||
    !session.processGroupId ||
    !session.processToken ||
    !processGroupContainsToken(session.processGroupId, session.processToken)
  ) {
    return;
  }
  try {
    process.kill(-session.processGroupId, "SIGTERM");
  } catch {
    // Already exited.
  }
}

function processGroupContainsToken(
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
