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

import {
  MAX_GAME_LOG_READ_BYTES,
  MAX_GAME_LOG_BYTES,
  MAX_PROTOCOL_BYTES,
  HANDSHAKE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  STOP_GRACE_MS,
  MAX_GAME_SESSIONS,
  type GameSessionStatus,
  type GameTreeNode,
  type GameSessionSnapshot,
  type GameCaptureManifest,
  type GameStopDiagnostics,
  type LiveSession,
  validateNodes,
  publicSnapshot,
  gitSnapshot,
  sha256,
  numberField,
  processGroupContainsToken,
  isTerminal,
  waitForExit,
  terminatePersistedProcess,
  deriveGuiVerdict,
  toRenderInfo,
  toPressedState,
  isEmptyPressedState,
} from "./game-sessions-types.js";

export {
  MAX_GAME_LOG_READ_BYTES,
  type GameSessionStatus,
  type GameTreeNode,
  type GameSessionSnapshot,
  type GameCaptureManifest,
  type GameStopDiagnostics,
};

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
    this.initialize();
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
      { allowWorkspaceRoot: true },
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
        resolvedEngine.environment,
        project.absolutePath,
        token,
      );
      session.engineVersion =
        typeof handshake.engineVersion === "string"
          ? handshake.engineVersion
          : resolvedEngine.version;
      session.bridgeProtocol =
        typeof handshake.protocol === "number" ? handshake.protocol : 1;
      session.renderInfo = toRenderInfo(handshake.renderInfo);
      session.guiVerdict = deriveGuiVerdict(session.renderInfo);
      if (typeof handshake.scene === "string" && handshake.scene) {
        session.scene = handshake.scene;
      }
      session.status = "running";
      session.lastHeartbeatAt = new Date().toISOString();
      this.appendLog(
        session,
        `[bridge] authenticated protocol=${session.bridgeProtocol ?? "unknown"} ` +
          `driver=${session.renderInfo?.renderingDriver || "unknown"} ` +
          `display=${session.renderInfo?.displayServer || "unknown"} ` +
          `gui=${session.guiVerdict}\n`,
      );
      if (session.guiVerdict !== "real_gpu") {
        this.appendLog(
          session,
          "[bridge] WARNING: session is not backed by a real GPU display; " +
            "frames from it are not GUI visual evidence.\n",
        );
      }
      this.persist(session);
      return publicSnapshot(session);
    } catch (error) {
      session.error = this.describeStartFailure(session, error);
      session.status = "crashed";
      session.endedAt = new Date().toISOString();
      this.terminate(session, "SIGKILL");
      this.persist(session);
      throw new Error(session.error);
    }
  }

  /**
   * Handshake failures used to surface as a bare `GAME_SESSION_HANDSHAKE_TIMEOUT`
   * with no hint about which engine was launched or what the engine printed.
   * Attach the elapsed time, resolved executable, and log tail so the failure is
   * diagnosable from the tool result alone.
   */
  private describeStartFailure(session: LiveSession, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const lines = [message];
    if (message === "GAME_SESSION_HANDSHAKE_TIMEOUT") {
      lines.push(
        `bridge did not authenticate within ${HANDSHAKE_TIMEOUT_MS}ms`,
        `engine=${session.engine} executable=${session.engineExecutable ?? "unknown"}`,
        `projectPath=${session.projectPath} scene=${session.scene}`,
        `viewport=${session.viewport.width}x${session.viewport.height}`,
        `exitCode=${session.exitCode ?? "none"} signal=${session.signal ?? "none"}`,
      );
      const tail = this.logTail(session);
      if (tail) lines.push(`engine output tail:\n${tail}`);
      lines.push(
        "If the engine printed no output at all, the binary likely never started; " +
          "if it printed import or C# build errors, run the project import/build task first.",
      );
    }
    return lines.join("\n");
  }

  private logTail(session: LiveSession, maxBytes = 4096): string {
    try {
      const log = readFileSync(this.logPath(session.sessionId));
      if (log.length === 0) return "";
      return log.subarray(Math.max(0, log.length - maxBytes)).toString("utf8");
    } catch {
      return "";
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
      session.pressedInput = toPressedState(result.pressed);
      if (typeof result.sceneGeneration === "number") {
        session.sceneGeneration = result.sceneGeneration;
      }
      if (typeof result.scene === "string" && result.scene) {
        session.scene = result.scene;
      }
      this.persist(session);
    }
    return publicSnapshot(session);
  }

  async sendInput(
    workspaceId: string,
    sessionId: string,
    input: GameInput,
  ): Promise<{ accepted: true; pressedInput?: GamePressedState }> {
    const session = this.getRunning(workspaceId, sessionId);
    switch (input.kind) {
      case "action":
        await this.sendAction(session, input);
        return { accepted: true };
      case "click":
        await this.sendClick(session, input);
        return { accepted: true };
      case "pointer": {
        const result = await this.request(session, "pointer", {
          event: input.event,
          x: input.x,
          y: input.y,
          buttonIndex: input.button
            ? MOUSE_BUTTON_INDEX[input.button]
            : undefined,
          wheelDirection: input.wheelDirection,
          factor: input.factor,
          modifiers: normalizeModifiers(input.modifiers),
        });
        return this.accepted(session, result);
      }
      case "key": {
        const key = input.key.trim();
        if (key.length === 0 || key.length > 64) {
          throw new Error(
            "GAME_SESSION_INPUT_INVALID: key must be 1-64 characters.",
          );
        }
        const text = validateKeyText(input.text);
        const result = await this.request(session, "key", {
          event: input.event,
          key,
          text,
          physical: input.physical ?? false,
          echo: input.echo ?? false,
          modifiers: normalizeModifiers(input.modifiers),
        });
        return this.accepted(session, result);
      }
      case "sequence": {
        const steps = validateSequence(input.steps);
        const result = await this.request(
          session,
          "sequence",
          { steps, releaseAtEnd: input.releaseAtEnd ?? true },
          sequenceTimeoutMs(steps),
        );
        return this.accepted(session, result);
      }
      case "release_all": {
        await this.request(session, "release_all", {});
        session.pressedInput = { mouse: [], keys: [], actions: [] };
        this.persist(session);
        return { accepted: true, pressedInput: session.pressedInput };
      }
      default: {
        const exhaustive: never = input;
        throw new Error(
          `GAME_SESSION_INPUT_INVALID: Unsupported input kind ${String(exhaustive)}.`,
        );
      }
    }
  }

  private accepted(
    session: LiveSession,
    result: Record<string, unknown>,
  ): {
    accepted: true;
    pressedInput?: GamePressedState;
  } {
    if (result.pressed) {
      session.pressedInput = toPressedState(result.pressed);
      if (typeof result.sceneGeneration === "number") {
        session.sceneGeneration = result.sceneGeneration;
      }
      this.persist(session);
    }
    return { accepted: true, pressedInput: session.pressedInput };
  }

  private async sendAction(
    session: LiveSession,
    input: Extract<GameInput, { kind: "action" }>,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(input.action)) {
      throw new Error("GAME_SESSION_INPUT_INVALID: Invalid action name.");
    }
    const strength = input.strength ?? 1;
    const frames = input.frames ?? 1;
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new Error("GAME_SESSION_INPUT_INVALID: strength must be 0-1.");
    }
    if (!Number.isInteger(frames) || frames < 1 || frames > 120) {
      throw new Error("GAME_SESSION_INPUT_INVALID: tap frames must be 1-120.");
    }
    await this.request(session, "action", {
      action: input.action,
      operation: input.operation,
      strength,
      frames,
    });
  }

  private async sendClick(
    session: LiveSession,
    input: Extract<GameInput, { kind: "click" }>,
  ): Promise<void> {
    assertInsideViewport(session, input.x, input.y, "Click");
    await this.request(session, "click", {
      x: input.x,
      y: input.y,
      buttonIndex: MOUSE_BUTTON_INDEX[input.button],
    });
  }

  async capture(
    workspaceId: string,
    sessionId: string,
    options: { waitFrames?: number } = {},
  ): Promise<{
    frameId: string;
    path: string;
    width: number;
    height: number;
    capturedAt: string;
    sha256: string;
    bytes: number;
    data: string;
    manifest: GameCaptureManifest;
    manifestPath: string;
  }> {
    const session = this.getRunning(workspaceId, sessionId);
    const frameId = `frame_${randomUUID()}`;
    const path = join(this.sessionEvidencePath(sessionId), `${frameId}.png`);
    const result = await this.request(
      session,
      "capture",
      {
        path,
        waitFrames: clampWaitFrames(options.waitFrames),
      },
      30_000,
    );
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
    const renderInfo = toRenderInfo(result) ?? session.renderInfo;
    // A frame is only GUI visual evidence when the engine itself reports a real
    // GPU display server and a non-dummy rendering driver.
    const guiVerdict = deriveGuiVerdict(renderInfo);
    const capturedAt = new Date().toISOString();
    const manifest: GameCaptureManifest = {
      manifestVersion: 1,
      frameId,
      sessionId,
      workspaceId,
      capturedAt,
      image: {
        path,
        sha256: sha256(bytes),
        bytes: bytes.length,
        width: numberField(result.width, session.viewport.width),
        height: numberField(result.height, session.viewport.height),
      },
      scene: textOr(result.scene, session.scene),
      sceneGeneration:
        typeof result.sceneGeneration === "number"
          ? result.sceneGeneration
          : "unknown",
      sceneInstances: Array.isArray(result.instances)
        ? result.instances.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      projectPath: session.projectPath,
      workspaceRoot: session.workspaceRoot,
      engine: session.engine,
      engineVersion: session.engineVersion ?? "unknown",
      bridgeProtocol: session.bridgeProtocol ?? "unknown",
      render: renderInfo ?? "unknown",
      guiVerdict,
      git: {
        headSha: session.headSha ?? "unknown",
        dirtyDiffSha256: session.dirtyDiffSha256,
        statusSha256: session.statusSha256,
        untrackedCount: session.untrackedCount,
      },
      assembly: this.assemblyIdentity(session),
      frameTiming: {
        requestedAt: timingField(result.frameRequestedAt),
        capturedAt: timingField(result.frameCapturedAt),
      },
    };
    const manifestPath = join(
      this.sessionEvidencePath(sessionId),
      `${frameId}.manifest.json`,
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
    });
    return {
      frameId,
      path,
      width: manifest.image.width,
      height: manifest.image.height,
      capturedAt,
      sha256: manifest.image.sha256,
      bytes: bytes.length,
      data: bytes.toString("base64"),
      manifest,
      manifestPath,
    };
  }

  /**
   * Best-effort identity of the managed assembly backing the session. Mono
   * Godot writes the compiled game assembly under `.godot/mono/temp/bin`. When
   * it cannot be located the manifest records `"unknown"` rather than a guess.
   */
  private assemblyIdentity(
    session: LiveSession,
  ): GameCaptureManifest["assembly"] {
    try {
      const projectRoot = join(
        session.workspaceRoot,
        session.projectPath === "." ? "" : session.projectPath,
      );
      const binaryRoot = join(projectRoot, ".godot", "mono", "temp", "bin");
      if (!existsSync(binaryRoot)) return "unknown";
      const candidates = collectAssemblyFiles(binaryRoot);
      if (candidates.length === 0) return "unknown";
      const newest = candidates
        .map((candidate) => ({
          candidate,
          mtime: statSync(candidate).mtimeMs,
        }))
        .sort((left, right) => right.mtime - left.mtime)[0].candidate;
      const bytes = readFileSync(newest);
      return {
        path: newest,
        sha256: sha256(bytes),
        bytes: bytes.length,
      };
    } catch {
      return "unknown";
    }
  }

  readLogs(
    workspaceId: string,
    sessionId: string,
    offsetBytes = 0,
    maxBytes = 64 * 1024,
  ): {    output: string;
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

  /**
   * Non-terminal sessions, optionally filtered to one workspace.
   *
   * Read-only and side-effect free: it exists so the workspace lifecycle audit
   * and `close_workspace_session` can see a live engine process without
   * attaching to it or starting anything.
   */
  listActiveSessions(workspaceId?: string): GameSessionSnapshot[] {
    this.initialize();
    return Array.from(this.sessions.values())
      .filter((session) => !isTerminal(session.status))
      .filter(
        (session) =>
          workspaceId === undefined || session.workspaceId === workspaceId,
      )
      .map((session) => publicSnapshot(session));
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

    // Explicitly drop anything still held before asking the engine to quit.
    // The bridge also releases on disconnect, but doing it here means a normal
    // stop never depends on the disconnect path firing.
    let releasedInputs = false;
    const before = await this.request(session, "state", {}, 3_000).catch(
      () => undefined,
    );
    if (before) {
      const pressed = toPressedState(before.pressed);
      session.pressedInput = pressed;
      if (!isEmptyPressedState(pressed)) {
        releasedInputs = true;
        this.appendLog(
          session,
          `[bridge] releasing latched input before stop: ${JSON.stringify(pressed)}\n`,
        );
      }
    }
    await this.request(session, "release_all", {}, 3_000).catch(() => undefined);
    session.pressedInput = { mouse: [], keys: [], actions: [] };

    await this.request(session, "quit", {}, 2_000).catch(() => undefined);
    let gracePath: GameStopDiagnostics["gracePath"] = "bridge_quit";
    await waitForExit(session.child, STOP_GRACE_MS);
    if (!isTerminal(session.status)) {
      gracePath = "sigterm";
      this.terminate(session, "SIGTERM");
      await waitForExit(session.child, 2_000);
    }
    if (!isTerminal(session.status)) {
      gracePath = "sigkill";
      this.terminate(session, "SIGKILL");
      await waitForExit(session.child, 2_000);
    }
    if (!isTerminal(session.status)) {
      session.status = "stopped";
      session.endedAt = new Date().toISOString();
    }
    if (!session.processGroupId) {
      gracePath = session.exitCode !== undefined ? "already_exited" : gracePath;
    }
    const residual = session.pressedInput ?? {
      mouse: [],
      keys: [],
      actions: [],
    };
    session.stopDiagnostics = {
      releasedInputs: releasedInputs || !isEmptyPressedState(residual),
      residualPressedInput: residual,
      processGroupReaped: !processGroupAlive(session),
      gracePath,
    };
    this.appendLog(
      session,
      `[bridge] stopped via ${gracePath}; residualInput=${JSON.stringify(residual)} ` +
        `groupReaped=${session.stopDiagnostics.processGroupReaped}\n`,
    );
    this.persist(session);
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
      const killHandle = setTimeout(() => {
        if (
          session.processGroupId &&
          session.processToken &&
          processGroupContainsToken(
            session.processGroupId,
            session.processToken,
          )
        ) {
          this.terminate(session, "SIGKILL");
        }
      }, STOP_GRACE_MS);
      killHandle.unref();
      session.child?.stdout.removeAllListeners();
      session.child?.stderr.removeAllListeners();
      session.child?.removeAllListeners();
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
          const killHandle = setTimeout(
            () => terminatePersistedProcess(parsed, "SIGKILL"),
            STOP_GRACE_MS,
          );
          killHandle.unref();
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
    environment: NodeJS.ProcessEnv;
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
          environment: resolved.environment,
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
    environment: NodeJS.ProcessEnv,
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
          ...environment,
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
    session.engineExecutable = executable;
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
    const persisted = {
      ...publicSnapshot(session),
      workspaceRoot: session.workspaceRoot,
      processToken: session.processToken,
    };
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

// --- input helpers ---------------------------------------------------------

const MOUSE_BUTTON_INDEX: Record<string, number> = {
  left: 1,
  right: 2,
  middle: 3,
};

/** Godot key names accepted by the bridge (resolved with OS.find_keycode_from_string). */
const KEY_NAME_PATTERN = /^[A-Za-z0-9_+ -]{1,32}$/;

const POINTER_EVENTS = ["down", "up", "move", "wheel", "double_click"];
const MAX_SEQUENCE_STEPS = 256;
const MAX_SEQUENCE_FRAME_DELAY = 600;

export interface GameModifiers {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface GamePressedState {
  mouse: number[];
  keys: number[];
  actions: string[];
}

export type GameInput =
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
    }
  | {
      kind: "pointer";
      event: "down" | "up" | "move" | "wheel" | "double_click";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      wheelDirection?: "up" | "down" | "left" | "right";
      factor?: number;
      modifiers?: GameModifiers;
    }
  | {
      kind: "key";
      event: "press" | "release" | "tap";
      key: string;
      /**
       * Character this key should insert into a focused text control. Godot
       * inserts from InputEventKey.unicode, so a key event alone cannot type
       * into a LineEdit. Defaults to the key itself when it is a single
       * printable character.
       */
      text?: string;
      physical?: boolean;
      echo?: boolean;
      modifiers?: GameModifiers;
    }
  | {
      kind: "sequence";
      steps: GameSequenceStep[];
      releaseAtEnd?: boolean;
    }
  | { kind: "release_all" };

export type GameSequenceStep =
  | ({
      type: "pointer";
      frameDelay?: number;
    } & Omit<Extract<GameInput, { kind: "pointer" }>, "kind">)
  | ({
      type: "key";
      frameDelay?: number;
    } & Omit<Extract<GameInput, { kind: "key" }>, "kind">)
  | ({
      type: "action";
      frameDelay?: number;
      action: string;
      operation: "press" | "release" | "tap";
      strength?: number;
      frames?: number;
    })
  | { type: "wait"; frameDelay?: number };

function normalizeModifiers(
  modifiers: GameModifiers | undefined,
): GameModifiers | undefined {
  if (!modifiers) return undefined;
  return {
    shift: modifiers.shift === true,
    ctrl: modifiers.ctrl === true,
    alt: modifiers.alt === true,
    meta: modifiers.meta === true,
  };
}

function assertInsideViewport(
  session: LiveSession,
  x: number,
  y: number,
  label: string,
): void {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= session.viewport.width ||
    y >= session.viewport.height
  ) {
    throw new Error(
      `GAME_SESSION_INPUT_INVALID: ${label} must be inside the viewport.`,
    );
  }
}

/**
 * Input sequences are the primary multi-step affordance (drag, wheel bursts,
 * modifier chords). They are validated to a closed shape so a caller can never
 * smuggle an unknown command into the bridge, and they always carry a bounded
 * frame budget so a request cannot outlive its own timeout.
 */
function validateSequence(steps: GameSequenceStep[]): Array<
  Record<string, unknown>
> {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(
      "GAME_SESSION_INPUT_INVALID: A sequence needs at least one step.",
    );
  }
  if (steps.length > MAX_SEQUENCE_STEPS) {
    throw new Error(
      `GAME_SESSION_INPUT_INVALID: A sequence may contain at most ${MAX_SEQUENCE_STEPS} steps.`,
    );
  }
  let totalFrames = 0;
  const encoded = steps.map((step, index) => {
    const frameDelay = step.frameDelay ?? 1;
    if (
      !Number.isInteger(frameDelay) ||
      frameDelay < 0 ||
      frameDelay > MAX_SEQUENCE_FRAME_DELAY
    ) {
      throw new Error(
        `GAME_SESSION_INPUT_INVALID: step ${index} frameDelay must be 0-${MAX_SEQUENCE_FRAME_DELAY}.`,
      );
    }
    totalFrames += frameDelay;
    switch (step.type) {
      case "pointer": {
        if (!POINTER_EVENTS.includes(step.event)) {
          throw new Error(
            `GAME_SESSION_INPUT_INVALID: step ${index} has an unsupported pointer event.`,
          );
        }
        if (!Number.isFinite(step.x) || !Number.isFinite(step.y)) {
          throw new Error(
            `GAME_SESSION_INPUT_INVALID: step ${index} needs finite x/y.`,
          );
        }
        if (step.button && !(step.button in MOUSE_BUTTON_INDEX)) {
          throw new Error(
            `GAME_SESSION_INPUT_INVALID: step ${index} has an unsupported button.`,
          );
        }
        return {
          type: "pointer",
          event: step.event,
          x: step.x,
          y: step.y,
          buttonIndex: step.button
            ? MOUSE_BUTTON_INDEX[step.button]
            : undefined,
          wheelDirection: step.wheelDirection,
          factor: step.factor,
          modifiers: normalizeModifiers(step.modifiers),
          frameDelay,
        };
      }
      case "key": {
        const key = step.key.trim();
        if (!KEY_NAME_PATTERN.test(key)) {
          throw new Error(
            `GAME_SESSION_INPUT_INVALID: step ${index} has an unsupported key name.`,
          );
        }
        if (!["press", "release", "tap"].includes(step.event)) {
          throw new Error(
            `GAME_SESSION_INPUT_INVALID: step ${index} has an unsupported key event.`,
          );
        }
        return {
          type: "key",
          event: step.event,
          key,
          text: validateKeyText(step.text),
          physical: step.physical === true,
          echo: step.echo === true,
          modifiers: normalizeModifiers(step.modifiers),
          frameDelay,
        };
      }
      case "action": {
        if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(step.action)) {
          throw new Error(
            `GAME_SESSION_INPUT_INVALID: step ${index} has an invalid action name.`,
          );
        }
        return {
          type: "action",
          action: step.action,
          operation: step.operation,
          strength: step.strength ?? 1,
          frames: step.frames ?? 1,
          frameDelay,
        };
      }
      case "wait":
        return { type: "wait", frameDelay };
      default:
        throw new Error(
          `GAME_SESSION_INPUT_INVALID: step ${index} has an unknown type.`,
        );
    }
  });
  return encoded;
}

/**
 * A sequence is dispatched one step per frame on the engine side, so the host
 * timeout has to scale with the declared frame budget instead of using the
 * fixed single-request timeout.
 */
function sequenceTimeoutMs(steps: Array<Record<string, unknown>>): number {
  const frames = steps.reduce(
    (total, step) => total + numberField(step.frameDelay, 1) + 1,
    0,
  );
  const budget = frames * 20 + 5_000;
  return Math.min(Math.max(budget, REQUEST_TIMEOUT_MS), 120_000);
}

/**
 * A printable character to insert. Godot's unicode field is a single code
 * point, so longer strings are rejected rather than silently truncated.
 */
function validateKeyText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 2) {
    throw new Error(
      "GAME_SESSION_INPUT_INVALID: text must be 1-2 characters (one code point).",
    );
  }
  if (value.length === 2 && value.codePointAt(0)! < 0x10000) {
    throw new Error(
      "GAME_SESSION_INPUT_INVALID: text must be a single code point.",
    );
  }
  return value;
}

function clampWaitFrames(value: number | undefined): number {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || value < 1 || value > 600) {
    throw new Error("GAME_SESSION_INPUT_INVALID: waitFrames must be 1-600.");
  }
  return value;
}

function timingField(value: unknown): number | "unknown" {
  return typeof value === "number" && Number.isFinite(value) ? value : "unknown";
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function collectAssemblyFiles(root: string, depth = 0): string[] {
  if (depth > 6) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectAssemblyFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) {
      found.push(full);
    }
  }
  return found;
}

function processGroupAlive(session: LiveSession): boolean {
  if (!session.processGroupId || !session.processToken) return false;
  return processGroupContainsToken(session.processGroupId, session.processToken);
}


