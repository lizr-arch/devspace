/**
 * Fail-closed probe + decision library for the ChatGPT-Desktop-on-shared-Codex
 * launch verifier (DEVSPACE-CODEX-APP-ONEPASS-003, rework of b6e5218).
 *
 * This module never launches, kills, restarts or writes anything except the
 * single explicit `open -a` call performed by `runLaunch()` when invoked from
 * the CLI `--launch` action (which requires separate user authorization).
 * All probes are read-only.
 *
 * Core rules (see REWORK-B6E5218.md):
 *  P0-01 every probe reports exactly one of ABSENT | PRESENT | UNKNOWN and any
 *        UNKNOWN blocks. A failed/timeout/unparsable `ps` must never be read as
 *        "no GUI".
 *  P0-02 the managed daemon identity comes from `daemon.pid` (JSON) + the live
 *        process executable identity + argv, never from a socket alone. Per
 *        original thread the writer set must be exactly [] or [managedPid].
 *  P0-03 post-launch L2 machine gates are all required; uncheckable gates yield
 *        L2_MACHINE_INCOMPLETE, never a pass. User-visible validation is always
 *        a separate manual gate.
 *  P1-04 the full preflight is re-collected immediately before the single open
 *        call; any drift fails closed with zero opens.
 *  P1-05 socket alias parent is compared as an exact string
 *        (`/private/tmp/codex-daemon-<uid>`), owner/mode checked, no repair.
 *
 * Platform note (macOS): `ps -o comm=` is truncated by the kernel to
 * MAXCOMLEN (16) bytes, so the exact main-binary path can never be compared
 * through comm alone. We therefore keep the exact-string kernel comm check and,
 * when comm is the 16-byte prefix of the expected main binary, confirm the
 * executable identity through lsof's kernel text-vnode path (also an exact
 * string / realpath comparison, never a substring test). The argv fallback is
 * used only when argv[0] is exactly the main binary and no `--type=` is
 * present, exactly as required.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const PROBE = Object.freeze({ ABSENT: "ABSENT", PRESENT: "PRESENT", UNKNOWN: "UNKNOWN" });
export const GATE = Object.freeze({ PASS: "PASS", BLOCK: "BLOCK", UNKNOWN: "UNKNOWN" });

export const L2_PASS = "L2_MACHINE_PASS_USER_VISUAL_REQUIRED";
export const L2_INCOMPLETE = "L2_MACHINE_INCOMPLETE";
export const L2_FAIL = "L2_MACHINE_FAIL";

/** Original A/B threads that must keep exactly one (or zero) writer. */
export const DEFAULT_THREADS = Object.freeze({
  A: Object.freeze({
    id: "01a16cef-0e26-7660-99f9-03caac52cfdf",
    cwd: "/Users/liz/.devspace/worktrees/devspace-3352a613",
  }),
  B: Object.freeze({
    id: "01a16cf8-9102-7102-8fc9-9b925b1f1a21",
    cwd: "/Users/liz/.devspace/worktrees/TriaRegna-c3207114",
  }),
});

/**
 * Pinned DevSpace MCP `codex_app_*` tool surface (acceptance gate L2 #8).
 * Total live MCP catalog is pinned at 96 tools; the codex_app subset is pinned
 * by name. The live probe only runs when a read-only bearer token is supplied
 * through `DEVSPACE_MCP_PROBE_TOKEN`; the repository's
 * `scripts/verify-live-mcp-tools.cjs` is NOT side-effect-free (it INSERTs and
 * DELETEs an OAuth access token and calls `list_workspaces`), so it is never
 * auto-invoked from here.
 */
export const EXPECTED_CODEX_APP_TOOLS = Object.freeze([
  "codex_app_review",
  "codex_app_shared_status",
  "codex_app_thread_bind",
  "codex_app_thread_create",
  "codex_app_thread_current",
  "codex_app_thread_open",
  "codex_app_thread_read",
  "codex_app_thread_rework",
  "codex_app_thread_send",
  "codex_app_turn_receipt",
]);
export const EXPECTED_MCP_TOOL_COUNT = 96;
export const PEER_MCP_URL = "http://127.0.0.1:7676/mcp";

const MAX_FRAME = 2_097_152;
const UUID_RE = /^[A-Fa-f0-9]{8}-(?:[A-Fa-f0-9]{4}-){3}[A-Fa-f0-9]{12}$/;

export function defaultConfig(overrides = {}) {
  const home = overrides.home ?? homedir();
  const uid = overrides.uid ?? process.getuid?.() ?? -1;
  const codexHome = overrides.codexHome ?? join(home, ".codex");
  const socketAlias = overrides.socketAlias ?? join(codexHome, "app-server-control", "app-server-control.sock");
  const base = {
    home,
    uid,
    codexHome,
    appPath: overrides.appPath ?? "/Applications/ChatGPT.app",
    mainBin: overrides.mainBin ?? "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    socketAlias,
    aliasParent: overrides.aliasParent ?? dirname(socketAlias),
    socketParent: overrides.socketParent ?? "/private/tmp/codex-daemon-" + uid,
    daemonPidPath: overrides.daemonPidPath ?? join(codexHome, "app-server-daemon", "daemon.pid"),
    releasesDir: overrides.releasesDir ?? join(codexHome, "packages", "app-server-daemon", "releases"),
    codexCliPath: overrides.codexCliPath ?? join(home, ".local", "bin", "codex"),
    threadLockDir: overrides.threadLockDir ?? join(codexHome, "thread-writer-locks"),
    threads: overrides.threads ?? DEFAULT_THREADS,
    processTimeoutMs: overrides.processTimeoutMs ?? 5000,
    lsofTimeoutMs: overrides.lsofTimeoutMs ?? 5000,
    versionTimeoutMs: overrides.versionTimeoutMs ?? 20000,
    socketTimeoutMs: overrides.socketTimeoutMs ?? 5000,
    extraSocketTimeoutMs: overrides.extraSocketTimeoutMs ?? 1500,
    rpcTimeoutMs: overrides.rpcTimeoutMs ?? 12000,
    threadReadTimeoutMs: overrides.threadReadTimeoutMs ?? 20000,
    guiWaitMs: overrides.guiWaitMs ?? 30000,
    guiPollMs: overrides.guiPollMs ?? 1000,
    mcpProbeTokenEnv: overrides.mcpProbeTokenEnv ?? "DEVSPACE_MCP_PROBE_TOKEN",
    mcpUrl: overrides.mcpUrl ?? PEER_MCP_URL,
    // 16-byte kernel truncation of comm on macOS (MAXCOMLEN). Derived, never
    // compared as a substring.
    mainCommTruncated: (overrides.mainBin ?? "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT").slice(0, 16),
  };
  const merged = { ...base, ...overrides };
  merged.uid = uid;
  merged.mainBin = base.mainBin;
  merged.mainCommTruncated = base.mainBin.slice(0, 16);
  merged.aliasParent = overrides.aliasParent ?? dirname(merged.socketAlias);
  merged.threadLockDir =
    overrides.threadLockDir ?? join(merged.codexHome, "thread-writer-locks");
  merged.daemonPidPath =
    overrides.daemonPidPath ?? join(merged.codexHome, "app-server-daemon", "daemon.pid");
  merged.releasesDir =
    overrides.releasesDir ?? join(merged.codexHome, "packages", "app-server-daemon", "releases");
  merged.expectedUrl =
    overrides.expectedUrl ?? "ws+unix://localhost" + merged.socketAlias + ":/rpc";
  return merged;
}

export function defaultRun(argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 5000,
    maxBuffer: opts.maxBuffer ?? 8_000_000,
  });
  return {
    status: r.status,
    signal: r.signal ?? null,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    error: r.error ?? null,
  };
}

function runOf(deps) {
  return deps.run ?? defaultRun;
}
function sleepOf(deps) {
  return deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a === b) return true;
  const ra = safeRealpath(a);
  const rb = safeRealpath(b);
  return !!ra && !!rb && ra === rb;
}
function commandOutcome(r) {
  if (!r) return { state: PROBE.UNKNOWN, reason: "no command result" };
  if (r.error) {
    return {
      state: PROBE.UNKNOWN,
      reason: `command error: ${r.error.code ?? r.error.message ?? "unknown"}`,
      errorCode: r.error.code ?? null,
    };
  }
  if (r.signal) return { state: PROBE.UNKNOWN, reason: `command signal: ${r.signal}` };
  if (typeof r.status !== "number") return { state: PROBE.UNKNOWN, reason: "command status missing" };
  return { state: PROBE.PRESENT, status: r.status };
}
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/* ------------------------------------------------------------------ *
 * ps process table
 * ------------------------------------------------------------------ */

/**
 * Reads the full process table. The comm and command fields are collected by
 * two kernel queries and merged by pid because comm may contain spaces
 * (e.g. "ChatGPT Helper") while command contains arbitrary argv.
 */
export function probeProcesses(cfg, deps = {}) {
  const run = runOf(deps);
  const commRes = run(["/bin/ps", "-axo", "pid=,comm="], { timeoutMs: cfg.processTimeoutMs });
  const commState = commandOutcome(commRes);
  if (commState.state !== PROBE.PRESENT || commState.status !== 0) {
    return {
      state: PROBE.UNKNOWN,
      reason: `ps comm: ${commState.reason ?? "exit " + commState.status}`,
    };
  }
  const commandRes = run(["/bin/ps", "-axo", "pid=,command=", "-ww"], {
    timeoutMs: cfg.processTimeoutMs,
  });
  const commandState = commandOutcome(commandRes);
  if (commandState.state !== PROBE.PRESENT || commandState.status !== 0) {
    return {
      state: PROBE.UNKNOWN,
      reason: `ps command: ${commandState.reason ?? "exit " + commandState.status}`,
    };
  }
  const commByPid = parsePsField(commRes.stdout);
  if (!commByPid.state) return { state: PROBE.UNKNOWN, reason: `ps comm: ${commByPid.reason}` };
  const commandByPid = parsePsField(commandRes.stdout);
  if (!commandByPid.state) return { state: PROBE.UNKNOWN, reason: `ps command: ${commandByPid.reason}` };
  const byPid = {};
  for (const [pid, comm] of Object.entries(commByPid.map)) {
    byPid[pid] = { pid: Number(pid), comm, command: commandByPid.map[pid] ?? null };
  }
  for (const pid of Object.keys(commandByPid.map)) {
    if (!byPid[pid]) byPid[pid] = { pid: Number(pid), comm: null, command: commandByPid.map[pid] };
  }
  return { state: PROBE.PRESENT, byPid, count: Object.keys(byPid).length };
}

function parsePsField(out) {
  if (typeof out !== "string" || out.trim() === "")
    return { state: false, reason: "empty output" };
  const lines = out.split("\n");
  const map = {};
  let parsed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) return { state: false, reason: `unparsable ps line: ${JSON.stringify(line.slice(0, 80))}` };
    map[m[1]] = m[2];
    parsed++;
  }
  if (!parsed) return { state: false, reason: "no parsable ps rows" };
  return { state: true, map };
}

/* ------------------------------------------------------------------ *
 * GUI detection (P0-01)
 * ------------------------------------------------------------------ */

export function probeLsofTextVnodes(cfg, pid, deps = {}) {
  const run = runOf(deps);
  const r = run(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "txt", "-Fn"], {
    timeoutMs: cfg.lsofTimeoutMs,
    maxBuffer: 1_000_000,
  });
  const outcome = commandOutcome(r);
  if (outcome.state !== PROBE.PRESENT) return { state: PROBE.UNKNOWN, reason: outcome.reason };
  if (outcome.status === 0) {
    const paths = (r.stdout || "")
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1));
    return { state: PROBE.PRESENT, paths };
  }
  if (outcome.status === 1 && !(r.stderr || "").trim()) {
    // lsof exit 1 without stderr is "no matching open files / process gone".
    return { state: PROBE.ABSENT, paths: [], reason: "no text vnodes" };
  }
  return {
    state: PROBE.UNKNOWN,
    reason: `lsof txt exit ${outcome.status}: ${(r.stderr || "").trim().slice(0, 200)}`,
  };
}

/**
 * Trusted GUI identity classifier.
 *
 * A pid counts as the GUI main process only if:
 *  - kernel comm equals the exact full main binary path, or
 *  - kernel comm equals the exact 16-byte kernel truncation of that path AND
 *    the kernel text-vnode list (lsof) contains the exact main binary path /
 *    realpath, or
 *  - argv[0] is exactly the main binary path and the command line has no
 *    `--type=` helper marker (documented argv fallback).
 * A helper whose command line merely *contains* the app path is never the GUI.
 */
export function classifyGui(cfg, psObs, lsofFn) {
  if (!psObs || psObs.state !== PROBE.PRESENT)
    return { state: PROBE.UNKNOWN, processes: [], reason: psObs?.reason ?? "process table unavailable" };
  const trusted = [];
  const seen = new Set();
  for (const entry of Object.values(psObs.byPid)) {
    if (!entry || seen.has(entry.pid)) continue;
    const comm = entry.comm ?? "";
    const command = entry.command ?? "";
    const argv0 = command.split(/\s+/)[0] ?? "";
    const commExact = comm === cfg.mainBin;
    const commTruncated = comm === cfg.mainCommTruncated;
    const argvExact = argv0 === cfg.mainBin && !/--type=/.test(command);
    if (commExact) {
      seen.add(entry.pid);
      trusted.push({ pid: entry.pid, identity: "kernel_comm", comm, command });
      continue;
    }
    if (argvExact) {
      seen.add(entry.pid);
      trusted.push({ pid: entry.pid, identity: "argv_fallback", comm, command });
      continue;
    }
    if (commTruncated) {
      // Kernel comm is truncated by 16 bytes on macOS: confirm the executable
      // identity through the kernel text-vnode path before trusting it.
      const vnodes = lsofFn(entry.pid);
      if (!vnodes || vnodes.state === PROBE.UNKNOWN) {
        return {
          state: PROBE.UNKNOWN,
          processes: trusted,
          reason: `cannot confirm truncated kernel comm for pid ${entry.pid}: ${vnodes?.reason ?? "no lsof result"}`,
        };
      }
      if (vnodes.state === PROBE.ABSENT) continue;
      const mains = (vnodes.paths || []).filter(
        (path) => path === cfg.mainBin || samePath(path, cfg.mainBin),
      );
      if (mains.length) {
        seen.add(entry.pid);
        trusted.push({ pid: entry.pid, identity: "kernel_comm_truncated_vnode", comm, command });
      }
      // else: helper sharing the truncated comm prefix -> not the GUI.
    }
  }
  trusted.sort((a, b) => a.pid - b.pid);
  return {
    state: trusted.length ? PROBE.PRESENT : PROBE.ABSENT,
    processes: trusted,
    count: trusted.length,
  };
}

/* ------------------------------------------------------------------ *
 * Daemon identity (P0-02)
 * ------------------------------------------------------------------ */

export function probeDaemonPidFile(cfg, deps = {}) {
  let raw;
  try {
    raw = readFileSync(cfg.daemonPidPath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return { state: PROBE.ABSENT, reason: "daemon.pid missing" };
    return { state: PROBE.UNKNOWN, reason: `daemon.pid read error: ${e?.code ?? e?.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: PROBE.UNKNOWN, reason: "daemon.pid is not valid JSON" };
  }
  const pid = parsed?.pid;
  if (!Number.isInteger(pid) || pid <= 0)
    return { state: PROBE.UNKNOWN, reason: "daemon.pid has no valid pid" };
  const identity = parsed?.processIdentity ?? {};
  return {
    state: PROBE.PRESENT,
    pid,
    processStartTime: typeof parsed.processStartTime === "string" ? parsed.processStartTime : null,
    bootId: typeof identity.bootId === "string" ? identity.bootId : null,
    uniqueId: Number.isInteger(identity.uniqueId) ? identity.uniqueId : null,
    startSeconds: Number.isInteger(identity.startSeconds) ? identity.startSeconds : null,
    startMicroseconds: Number.isInteger(identity.startMicroseconds) ? identity.startMicroseconds : null,
    hasExecutableDigest:
      Array.isArray(parsed?.executableIdentity?.digest) &&
      parsed.executableIdentity.digest.length === 32,
    fileSha256: sha256Hex(raw),
    rawBytes: Buffer.byteLength(raw),
  };
}

function classifyManagedDaemons(cfg, psObs) {
  if (!psObs || psObs.state !== PROBE.PRESENT)
    return { state: PROBE.UNKNOWN, list: [], reason: psObs?.reason ?? "process table unavailable" };
  const list = [];
  for (const entry of Object.values(psObs.byPid)) {
    if (!entry?.command) continue;
    const tokens = entry.command.trim().split(/\s+/);
    if (!tokens.includes("app-server")) continue;
    if (!tokens.includes("--managed-daemon")) continue;
    list.push({ pid: entry.pid, argv0: tokens[0] ?? "", command: entry.command });
  }
  list.sort((a, b) => a.pid - b.pid);
  return { state: PROBE.PRESENT, list };
}

function classifyAppServerProcesses(cfg, psObs) {
  if (!psObs || psObs.state !== PROBE.PRESENT)
    return { state: PROBE.UNKNOWN, pids: [], reason: psObs?.reason ?? "process table unavailable" };
  const pids = [];
  for (const entry of Object.values(psObs.byPid)) {
    if (!entry?.command) continue;
    const tokens = entry.command.trim().split(/\s+/);
    if (tokens.includes("app-server")) pids.push(entry.pid);
  }
  pids.sort((a, b) => a - b);
  return { state: PROBE.PRESENT, pids };
}

const RELEASE_CODEX_RE = /^packages\/app-server-daemon\/releases\/([^/]+)\/(?:.*\/)?codex$/;

export function probeDaemonIdentity(cfg, psObs, pidFile, deps = {}) {
  const run = runOf(deps);
  const out = {
    state: PROBE.UNKNOWN,
    pid: pidFile?.pid ?? null,
    identityOk: false,
    realpath: null,
    version: null,
    argvOk: false,
    argv: null,
    processFound: false,
    bootIdFromPidFile: pidFile?.bootId ?? null,
    startSecondsFromPidFile: pidFile?.startSeconds ?? null,
    bootIdVerified: "UNKNOWN",
    startVerified: "UNKNOWN",
    lstartText: null,
    lstartEpochSeconds: null,
    versionCommand: { state: PROBE.UNKNOWN, reason: "not run" },
    reasons: [],
  };
  if (!pidFile || pidFile.state !== PROBE.PRESENT) {
    out.reasons.push(pidFile?.reason ?? "daemon.pid unavailable");
    return out;
  }
  if (!psObs || psObs.state !== PROBE.PRESENT) {
    out.reasons.push(psObs?.reason ?? "process table unavailable");
    return out;
  }
  const entry = psObs.byPid[String(pidFile.pid)];
  if (!entry) {
    out.state = PROBE.ABSENT;
    out.reasons.push(`pid ${pidFile.pid} not present in process table`);
    return out;
  }
  out.processFound = true;
  const command = entry.command ?? "";
  const tokens = command.trim().split(/\s+/);
  out.argv = command;
  const argvOk = tokens.length > 1 && tokens[1] === "app-server" && tokens.includes("--managed-daemon");
  out.argvOk = argvOk;
  if (!argvOk) out.reasons.push("argv is not `<codex> app-server ... --managed-daemon`");

  // Executable identity: kernel text vnode, not argv.
  const vnodes = probeLsofTextVnodes(cfg, pidFile.pid, deps);
  if (vnodes.state !== PROBE.PRESENT) {
    out.reasons.push(`executable identity unavailable: ${vnodes.reason ?? vnodes.state}`);
    out.state = PROBE.UNKNOWN;
    return out;
  }
  const codexPrefix = join(cfg.releasesDir);
  const candidates = (vnodes.paths || []).filter(
    (path) => typeof path === "string" && !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"),
  );
  let resolved = null;
  for (const path of candidates) {
    const real = safeRealpath(path);
    const candidate = real ?? path;
    const rel = candidate.startsWith(cfg.codexHome + "/")
      ? candidate.slice(cfg.codexHome.length + 1)
      : null;
    if (!rel) continue;
    const m = RELEASE_CODEX_RE.exec(rel);
    if (!m) continue;
    resolved = { path: candidate, version: m[1] };
    break;
  }
  if (!resolved) {
    out.reasons.push(
      `executable realpath not under ${codexPrefix}/<version>/.../codex`,
    );
    out.state = PROBE.PRESENT;
    out.identityOk = false;
    return out;
  }
  out.realpath = resolved.path;
  out.version = resolved.version;

  // Process start identity (kernel): exact lstart comparison against daemon.pid.
  const lstartRes = run(["/bin/ps", "-p", String(pidFile.pid), "-o", "lstart="], {
    timeoutMs: cfg.processTimeoutMs,
  });
  const lstartOutcome = commandOutcome(lstartRes);
  if (lstartOutcome.state === PROBE.PRESENT && lstartOutcome.status === 0) {
    const text = (lstartRes.stdout || "").trim();
    out.lstartText = text || null;
    const epochMs = Date.parse(text);
    out.lstartEpochSeconds = Number.isFinite(epochMs) ? Math.floor(epochMs / 1000) : null;
  }

  if (pidFile.bootId) {
    const sys = run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], {
      timeoutMs: cfg.processTimeoutMs,
    });
    const sysOutcome = commandOutcome(sys);
    if (sysOutcome.state === PROBE.PRESENT && sysOutcome.status === 0) {
      const boot = (sys.stdout || "").trim();
      out.systemBootId = boot || null;
      if (UUID_RE.test(boot)) {
        out.bootIdVerified = boot === pidFile.bootId ? "MATCH" : "MISMATCH";
      }
    }
  }
  if (pidFile.startSeconds !== null && Number.isFinite(out.lstartEpochSeconds)) {
    out.startVerified = out.lstartEpochSeconds === pidFile.startSeconds ? "MATCH" : "MISMATCH";
  }

  // Cross-check the daemon's own version/status view over the read-only CLI.
  out.versionCommand = probeDaemonVersionCommand(cfg, deps);
  const reasons = [...out.reasons];
  if (!argvOk) reasons.push("argv mismatch");
  if (out.bootIdVerified === "MISMATCH") reasons.push("bootId mismatch vs daemon.pid");
  if (out.startVerified === "MISMATCH") reasons.push("process start time mismatch vs daemon.pid");
  if (out.versionCommand.state === PROBE.PRESENT && out.versionCommand.ok === false)
    reasons.push(out.versionCommand.reason ?? "daemon version command mismatch");
  out.reasons = reasons;
  out.identityOk = argvOk && reasons.length === 0;
  out.state = PROBE.PRESENT;
  return out;
}

function probeDaemonVersionCommand(cfg, deps = {}) {
  const run = runOf(deps);
  const r = run([process.execPath, cfg.codexCliPath, "app-server", "daemon", "version"], {
    timeoutMs: cfg.versionTimeoutMs,
    maxBuffer: 2_000_000,
  });
  const outcome = commandOutcome(r);
  if (outcome.state !== PROBE.PRESENT)
    return { state: PROBE.UNKNOWN, ok: false, reason: outcome.reason };
  if (outcome.status !== 0)
    return {
      state: PROBE.PRESENT,
      ok: false,
      reason: `daemon version exit ${outcome.status}: ${(r.stderr || "").trim().slice(0, 200)}`,
    };
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  if (!lines.length) return { state: PROBE.UNKNOWN, ok: false, reason: "daemon version empty output" };
  let info;
  try {
    info = JSON.parse(lines[lines.length - 1]);
  } catch {
    return { state: PROBE.UNKNOWN, ok: false, reason: "daemon version is not valid JSON" };
  }
  if (!info || typeof info !== "object")
    return { state: PROBE.UNKNOWN, ok: false, reason: "daemon version JSON is not an object" };
  const checks = {
    running: info.status === "running",
    socketPathExact: info.socketPath === cfg.socketAlias,
  };
  const reason = [];
  if (!checks.running) reason.push(`status=${JSON.stringify(info.status)}`);
  if (!checks.socketPathExact)
    reason.push(`socketPath=${JSON.stringify(info.socketPath)} != ${JSON.stringify(cfg.socketAlias)}`);
  return {
    state: PROBE.PRESENT,
    ok: reason.length === 0,
    info,
    checks,
    reason: reason.join("; ") || null,
  };
}

/* ------------------------------------------------------------------ *
 * Writer ownership (P0-02)
 * ------------------------------------------------------------------ */

export function probeWriterOwnership(cfg, threadKey, managedPid, deps = {}) {
  const run = runOf(deps);
  const spec = cfg.threads[threadKey];
  const lockPath = join(cfg.threadLockDir, spec.id + ".lock");
  let st;
  try {
    st = lstatSync(lockPath);
  } catch (e) {
    if (e?.code === "ENOENT")
      return { state: PROBE.ABSENT, lockPath, owners: [], unsafe: false, managedPid };
    return { state: PROBE.UNKNOWN, lockPath, owners: [], reason: `lock lstat error: ${e?.code ?? e?.message}`, managedPid };
  }
  if (st.isSymbolicLink() || !st.isFile() || (cfg.uid !== undefined && st.uid !== cfg.uid)) {
    return {
      state: PROBE.PRESENT,
      lockPath,
      owners: [],
      unsafe: true,
      reason: "lock file is not a regular same-uid file",
      managedPid,
    };
  }
  const r = run(["/usr/sbin/lsof", "-nP", "-F", "p", lockPath], {
    timeoutMs: cfg.lsofTimeoutMs,
    maxBuffer: 200_000,
  });
  const outcome = commandOutcome(r);
  if (outcome.state !== PROBE.PRESENT)
    return { state: PROBE.UNKNOWN, lockPath, owners: [], reason: `lsof: ${outcome.reason}`, managedPid };
  if (outcome.status === 0) {
    const owners = [...new Set([...(r.stdout || "").matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1])))]
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .sort((a, b) => a - b);
    return { state: PROBE.PRESENT, lockPath, owners, unsafe: false, managedPid };
  }
  if (outcome.status === 1 && !(r.stderr || "").trim()) {
    // Normal "no matching open files" (valid empty holder set).
    return { state: PROBE.PRESENT, lockPath, owners: [], unsafe: false, managedPid };
  }
  return {
    state: PROBE.UNKNOWN,
    lockPath,
    owners: [],
    reason: `lsof exit ${outcome.status}: ${(r.stderr || "").trim().slice(0, 200)}`,
    managedPid,
  };
}

/* ------------------------------------------------------------------ *
 * Socket identity + WS handshake (P1-05 / P0-02)
 * ------------------------------------------------------------------ */

function wsUpgrade(socketPath, { timeoutMs = 5000, path = "/rpc" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };
    const key = randomBytes(16).toString("base64");
    let socket;
    try {
      socket = connect(socketPath);
    } catch (e) {
      return resolve({ state: PROBE.UNKNOWN, kind: "ERROR", reason: e?.message ?? "connect threw" });
    }
    const timer = setTimeout(() => finish({ state: PROBE.UNKNOWN, kind: "TIMEOUT", reason: "handshake timeout" }), timeoutMs);
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      const statusLine = buffer.slice(0, end).trim();
      const is101 = /^HTTP\/1\.[01]\s+101(?:\s|$)/.test(statusLine);
      finish({
        state: PROBE.PRESENT,
        kind: is101 ? "101" : "HTTP",
        statusLine,
        handshake: is101 ? "101" : statusLine,
      });
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      finish({ state: PROBE.UNKNOWN, kind: "ERROR", reason: `connect error: ${e.code ?? e.message}` });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      finish({ state: PROBE.UNKNOWN, kind: "CLOSED", reason: "socket closed before response" });
    });
  });
}

export async function probeSocket(cfg, deps = {}) {
  if (deps.probes?.socket) return deps.probes.socket(cfg, deps);
  const uid = cfg.uid;
  const result = {
    state: PROBE.UNKNOWN,
    alias: cfg.socketAlias,
    relation: null,
    realpath: null,
    target: null,
    parent: null,
    parentMode: null,
    identityOk: false,
    handshake: null,
    reasons: [],
  };
  let alias;
  try {
    alias = lstatSync(cfg.socketAlias);
  } catch (e) {
    if (e?.code === "ENOENT") return { ...result, state: PROBE.ABSENT, reasons: ["socket alias missing"] };
    return { ...result, state: PROBE.UNKNOWN, reasons: [`socket alias lstat error: ${e?.code ?? e?.message}`] };
  }
  // Canonical alias directory must be exactly 0700 and owned by this uid.
  try {
    const aliasParentStat = statSync(cfg.aliasParent);
    result.aliasParentMode = aliasParentStat.mode & 0o777;
    if (!aliasParentStat.isDirectory() || aliasParentStat.uid !== uid || (aliasParentStat.mode & 0o777) !== 0o700)
      result.reasons.push("alias parent is not an owner-only 0700 directory");
  } catch (e) {
    return { ...result, state: PROBE.UNKNOWN, reasons: [`alias parent stat error: ${e?.code ?? e?.message}`] };
  }
  if (alias.uid !== uid) result.reasons.push("socket alias uid mismatch");
  if (alias.isSymbolicLink()) {
    result.relation = "symlink";
    let real;
    try {
      real = realpathSync(cfg.socketAlias);
    } catch (e) {
      return { ...result, state: PROBE.UNKNOWN, reasons: [...result.reasons, `realpath error: ${e?.code ?? e?.message}`] };
    }
    result.realpath = real;
    result.parent = dirname(real);
    const targetName = basename(real);
    // Exact string compare: never startsWith (P1-05).
    if (result.parent !== cfg.socketParent) result.reasons.push("socket alias target parent mismatch");
    if (!/^[a-f0-9]{64}$/.test(targetName)) result.reasons.push("socket target name is not canonical 64-hex");
    try {
      const parentStat = statSync(result.parent);
      result.parentMode = parentStat.mode & 0o777;
      if (!parentStat.isDirectory() || parentStat.uid !== uid || (parentStat.mode & 0o777) !== 0o700)
        result.reasons.push("socket target parent is not an owner-only 0700 directory");
    } catch (e) {
      return { ...result, state: PROBE.UNKNOWN, reasons: [...result.reasons, `socket parent stat error: ${e?.code ?? e?.message}`] };
    }
  } else if (alias.isSocket()) {
    result.relation = "direct";
    result.realpath = cfg.socketAlias;
    result.parent = cfg.aliasParent;
  } else {
    result.reasons.push("socket alias is neither a symlink nor a socket");
  }
  try {
    const targetStat = statSync(cfg.socketAlias);
    result.target = { isSocket: targetStat.isSocket(), uid: targetStat.uid, mode: targetStat.mode & 0o777 };
    if (!targetStat.isSocket()) result.reasons.push("target is not a socket");
    if (targetStat.uid !== uid) result.reasons.push("target socket uid mismatch");
    if ((targetStat.mode & 0o777) !== 0o600) result.reasons.push("target socket mode is not 0600");
  } catch (e) {
    return { ...result, state: PROBE.UNKNOWN, reasons: [...result.reasons, `target stat error: ${e?.code ?? e?.message}`] };
  }
  result.identityOk = result.reasons.length === 0;

  const handshake = await wsUpgrade(cfg.socketAlias, {
    timeoutMs: cfg.socketTimeoutMs,
    path: "/rpc",
  });
  result.handshake = handshake;
  if (handshake.state === PROBE.PRESENT) {
    result.state = PROBE.PRESENT;
  } else {
    result.state = PROBE.UNKNOWN;
    result.reasons.push(`handshake: ${handshake.reason ?? handshake.kind}`);
  }
  return result;
}

/** Extra sockets in the private daemon directory are noise. They never grant
 * PASS and never define daemon identity. A stale listener that accepts a
 * connection but never answers is reported as STALE, not live. */
export async function scanExtraSockets(cfg, canonicalSocket, deps = {}) {
  if (deps.probes?.extraSockets) return deps.probes.extraSockets(cfg, canonicalSocket, deps);
  const out = { state: PROBE.PRESENT, entries: [], reasons: [] };
  let names;
  try {
    names = readdirSync(cfg.socketParent);
  } catch (e) {
    if (e?.code === "ENOENT") return { state: PROBE.ABSENT, entries: [] };
    return { state: PROBE.UNKNOWN, entries: [], reasons: [`readdir error: ${e?.code ?? e?.message}`] };
  }
  const canonicalReal = canonicalSocket?.realpath ?? safeRealpath(cfg.socketAlias);
  for (const name of names.sort()) {
    const full = join(cfg.socketParent, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isSocket()) continue;
    if (canonicalReal && full === canonicalReal) continue;
    const handshake = await wsUpgrade(full, {
      timeoutMs: cfg.extraSocketTimeoutMs,
      path: "/rpc",
    });
    let classification;
    if (handshake.state === PROBE.PRESENT && handshake.handshake === "101") classification = "LIVE_101";
    else if (handshake.kind === "TIMEOUT") classification = "STALE_UNRESPONSIVE";
    else if (handshake.kind === "ERROR" || handshake.kind === "CLOSED") classification = "STALE_NO_LISTENER";
    else classification = "NON_101";
    out.entries.push({ name, classification, handshake: handshake.statusLine ?? handshake.reason ?? handshake.kind });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * GUI environment (P0-03 gate 2)
 * ------------------------------------------------------------------ */

export function probeGuiEnv(cfg, pid, deps = {}) {
  if (deps.probes?.guiEnv) return deps.probes.guiEnv(cfg, pid, deps);
  const run = runOf(deps);
  const r = run(["/bin/ps", "eww", "-p", String(pid), "-ww"], {
    timeoutMs: cfg.processTimeoutMs,
    maxBuffer: 8_000_000,
  });
  const outcome = commandOutcome(r);
  if (outcome.state !== PROBE.PRESENT)
    return { state: PROBE.UNKNOWN, pid, reason: `ps eww: ${outcome.reason}` };
  if (outcome.status !== 0)
    return { state: PROBE.UNKNOWN, pid, reason: `ps eww exit ${outcome.status}` };
  const m = /(?:^|\s)CODEX_APP_SERVER_WS_URL=(\S+)/.exec(r.stdout || "");
  return {
    state: PROBE.PRESENT,
    pid,
    present: !!m,
    value: m ? m[1] : null,
  };
}

/* ------------------------------------------------------------------ *
 * JSON-RPC over the shared WebSocket (thread metadata, L2 gate 7)
 * ------------------------------------------------------------------ */

class JsonRpcSocket {
  constructor(socketPath, opts = {}) {
    this.socketPath = socketPath;
    this.path = opts.path ?? "/rpc";
    this.openTimeoutMs = opts.timeoutMs ?? 12000;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.closed = false;
    this.counter = 0;
    this.pending = new Map();
    this.socket = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.closed = true;
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        try {
          this.socket?.destroy();
        } catch {}
        reject(error);
      };
      const timer = setTimeout(
        () => fail(Object.assign(new Error("RPC handshake timeout"), { code: "WS_TIMEOUT" })),
        this.openTimeoutMs,
      );
      this.socket = connect(this.socketPath);
      this.socket.on("error", (e) =>
        fail(Object.assign(new Error(`socket error: ${e.code ?? e.message}`), { code: "WS_ERROR" })),
      );
      this.socket.on("close", () =>
        fail(Object.assign(new Error("socket closed"), { code: "WS_CLOSED" })),
      );
      this.socket.on("connect", () => {
        const key = randomBytes(16).toString("base64");
        this.socket.write(
          `GET ${this.path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.socket.on("data", (chunk) => {
        try {
          this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          });
        } catch (e) {
          fail(e);
        }
      });
    });
  }

  consume(data, onReady) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > MAX_FRAME + 1024) {
      this.closed = true;
      throw Object.assign(new Error("frame limit"), { code: "FRAME_LIMIT" });
    }
    if (!this.ready) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString("ascii");
      const statusLine = header.split("\r\n")[0];
      if (!/^HTTP\/1\.[01]\s+101(?:\s|$)/.test(statusLine)) {
        this.closed = true;
        throw Object.assign(new Error(`handshake rejected: ${statusLine}`), { code: "WS_REJECTED" });
      }
      this.buffer = this.buffer.subarray(end + 4);
      this.ready = true;
      onReady?.();
    }
    while (this.buffer.length >= 2 && !this.closed) {
      const opcode = this.buffer[0] & 15;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) {
          this.closed = true;
          throw Object.assign(new Error("frame limit"), { code: "FRAME_LIMIT" });
        }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_FRAME) {
        this.closed = true;
        throw Object.assign(new Error("frame limit"), { code: "FRAME_LIMIT" });
      }
      const masked = !!(this.buffer[1] & 0x80);
      const total = offset + (masked ? 4 : 0) + length;
      if (this.buffer.length < total) return;
      const bytes = Buffer.from(this.buffer.subarray(offset + (masked ? 4 : 0), total));
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(total);
      if (opcode === 8) {
        this.closed = true;
        for (const p of this.pending.values())
          p.reject(Object.assign(new Error("server closed"), { code: "WS_CLOSED" }));
        this.pending.clear();
        return;
      }
      if (opcode === 9) {
        this.frame(bytes, 0xa);
        continue;
      }
      if (opcode !== 1) continue;
      let msg;
      try {
        msg = JSON.parse(bytes.toString("utf8"));
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(
            Object.assign(new Error("rpc rejected: " + String(msg.error?.message ?? "unknown")), {
              code: "RPC_REJECTED",
              rpcError: msg.error,
            }),
          );
        } else {
          p.resolve(msg.result);
        }
      }
    }
  }

  frame(body, opcode = 1) {
    if (!this.socket || !this.ready || this.closed)
      throw Object.assign(new Error("not connected"), { code: "WS_CLOSED" });
    if (body.length > MAX_FRAME) throw Object.assign(new Error("frame limit"), { code: "FRAME_LIMIT" });
    const mask = randomBytes(4);
    const n = body.length;
    let header;
    if (n < 126) header = Buffer.from([0x80 | opcode, 0x80 | n]);
    else if (n < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0xfe;
      header.writeUInt16BE(n, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(n), 2);
    }
    const encoded = Buffer.alloc(n);
    for (let i = 0; i < n; i++) encoded[i] = body[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, encoded]));
  }

  notify(method, params = {}) {
    this.frame(Buffer.from(JSON.stringify({ method, params }), "utf8"));
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      let settled = false;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(Object.assign(new Error(`${method} timeout`), { code: "RPC_TIMEOUT" }));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.frame(Buffer.from(JSON.stringify({ id, method, params }), "utf8"));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  close() {
    this.closed = true;
    for (const p of this.pending.values())
      p.reject(Object.assign(new Error("closed"), { code: "WS_CLOSED" }));
    this.pending.clear();
    try {
      this.socket?.destroy();
    } catch {}
  }
}

export async function probeThreads(cfg, deps = {}) {
  if (deps.probes?.threads) return deps.probes.threads(cfg, deps);
  const out = { state: PROBE.UNKNOWN, threads: {}, error: null };
  const rpc = new JsonRpcSocket(cfg.socketAlias, { timeoutMs: cfg.rpcTimeoutMs });
  try {
    await rpc.open();
    const init = await rpc.request(
      "initialize",
      {
        clientInfo: { name: "devspace-launch-verify", title: "DevSpace Launch Verify", version: "1.0.0" },
        capabilities: { experimentalApi: false },
      },
      cfg.rpcTimeoutMs,
    );
    if (typeof init?.platformOs !== "string")
      throw Object.assign(new Error("initialize reply invalid"), { code: "RPC_INIT_INVALID" });
    rpc.notify("initialized");
    for (const key of Object.keys(cfg.threads)) {
      const spec = cfg.threads[key];
      try {
        // Acceptance L2: metadata only, includeTurns false. B's full history
        // is ~14.1 MB and cannot cross the 2 MiB socket frame.
        const result = await rpc.request(
          "thread/read",
          { threadId: spec.id, includeTurns: false },
          cfg.threadReadTimeoutMs,
        );
        const thread = result?.thread;
        const status =
          typeof thread?.status === "string"
            ? thread.status
            : typeof thread?.status?.type === "string"
              ? thread.status.type
              : null;
        out.threads[key] = {
          state: PROBE.PRESENT,
          threadId: thread?.id ?? null,
          cwd: typeof thread?.cwd === "string" ? thread.cwd : null,
          status,
          matches: {
            id: thread?.id === spec.id,
            cwd: samePath(thread?.cwd, spec.cwd),
            statusRequired: key === "B" ? status === "idle" : undefined,
          },
        };
      } catch (e) {
        if (e?.code === "RPC_REJECTED") {
          out.threads[key] = { state: "RPC_ERROR", error: String(e.rpcError?.message ?? e.message) };
        } else {
          out.threads[key] = { state: PROBE.UNKNOWN, error: `${e?.code ?? ""} ${e?.message ?? e}`.trim() };
        }
      }
    }
    const values = Object.values(out.threads);
    out.state = values.every((v) => v.state === PROBE.PRESENT) ? PROBE.PRESENT : PROBE.UNKNOWN;
  } catch (e) {
    out.error = `${e?.code ?? ""} ${e?.message ?? e}`.trim();
    out.state = PROBE.UNKNOWN;
  } finally {
    rpc.close();
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * DevSpace live MCP tool surface (L2 gate 8)
 * ------------------------------------------------------------------ */

export async function probeToolSurface(cfg, deps = {}) {
  if (deps.probes?.toolSurface) return deps.probes.toolSurface(cfg, deps);
  const token = deps.mcpProbeToken ?? process.env[cfg.mcpProbeTokenEnv];
  if (!token) {
    return {
      state: PROBE.UNKNOWN,
      ok: false,
      reason:
        "no side-effect-free live probe available: scripts/verify-live-mcp-tools.cjs mints an OAuth access token " +
        "(INSERT + DELETE on the live sqlite state) and calls list_workspaces, so it is not auto-invoked; " +
        `set ${cfg.mcpProbeTokenEnv} to a read-only bearer token to enable this gate`,
    };
  }
  const call = async (body, sessionId) => {
    const res = await fetch(cfg.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.rpcTimeoutMs),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text.includes("data:")
        ? JSON.parse(text.split("data:").slice(1).join("data:").trim())
        : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, session: res.headers.get("mcp-session-id"), parsed };
  };
  try {
    const init = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "devspace-launch-verify", version: "1.0.0" },
      },
    });
    if (!init.parsed) return { state: PROBE.UNKNOWN, ok: false, reason: "MCP initialize unparsable" };
    await call({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.session);
    if (!list.parsed) return { state: PROBE.UNKNOWN, ok: false, reason: "MCP tools/list unparsable" };
    const tools = Array.isArray(list.parsed?.result?.tools) ? list.parsed.result.tools : null;
    if (!tools) return { state: PROBE.UNKNOWN, ok: false, reason: "MCP tools/list has no tool array" };
    const names = tools.map((t) => t?.name).filter((n) => typeof n === "string");
    const liveCodexApp = names.filter((n) => n.startsWith("codex_app_")).sort();
    const expected = [...EXPECTED_CODEX_APP_TOOLS].sort();
    const missing = expected.filter((n) => !liveCodexApp.includes(n));
    const extra = liveCodexApp.filter((n) => !expected.includes(n));
    const toolCount = names.length;
    const ok = missing.length === 0 && extra.length === 0 && toolCount === EXPECTED_MCP_TOOL_COUNT;
    return {
      state: PROBE.PRESENT,
      ok,
      toolCount,
      expectedToolCount: EXPECTED_MCP_TOOL_COUNT,
      codexAppTools: liveCodexApp,
      missing,
      extra,
      reason: ok ? null : `tool surface drift: count=${toolCount}, missing=${missing.join(",")}, extra=${extra.join(",")}`,
    };
  } catch (e) {
    return { state: PROBE.UNKNOWN, ok: false, reason: `live MCP probe failed: ${e?.message ?? e}` };
  }
}

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

export async function collectPreflight(cfg, deps = {}) {
  const probes = deps.probes ?? {};
  const ps = (probes.processes ?? probeProcesses)(cfg, deps);
  const gui = (probes.gui ?? ((c, p) => classifyGui(c, p, (pid) => probeLsofTextVnodes(c, pid, deps))))(cfg, ps);
  const managed = (probes.managedDaemons ?? classifyManagedDaemons)(cfg, ps);
  const appServer = (probes.appServerProcesses ?? classifyAppServerProcesses)(cfg, ps);
  const pidFile = (probes.daemonPidFile ?? probeDaemonPidFile)(cfg, deps);
  const daemon = (probes.daemonIdentity ?? probeDaemonIdentity)(cfg, ps, pidFile, deps);
  const writers = (probes.writers ?? ((c, pid) => {
    const result = {};
    for (const key of Object.keys(c.threads))
      result[key] = probeWriterOwnership(c, key, pid, deps);
    return result;
  }))(cfg, daemon.pid);
  const socket = await (probes.socket ?? probeSocket)(cfg, deps);
  const extraSockets = await (probes.extraSockets ?? scanExtraSockets)(cfg, socket, deps);
  return { ps, gui, managedDaemons: managed, appServer, daemonPidFile: pidFile, daemon, writers, socket, extraSockets };
}

export async function collectPostLaunch(cfg, preObs, deps = {}) {
  if (deps.collectPostLaunch) return deps.collectPostLaunch(cfg, preObs, deps);
  const probes = deps.probes ?? {};
  const run = runOf(deps);
  const sleep = sleepOf(deps);
  const lsofFn = (pid) => probeLsofTextVnodes(cfg, pid, deps);
  let ps;
  let gui;
  const deadline = Date.now() + cfg.guiWaitMs;
  for (;;) {
    ps = (probes.processes ?? probeProcesses)(cfg, deps);
    gui = (probes.gui ?? ((c, p) => classifyGui(c, p, lsofFn)))(cfg, ps);
    if (gui.state === PROBE.PRESENT && gui.processes.length > 0) break;
    if (Date.now() >= deadline) break;
    await sleep(cfg.guiPollMs);
  }
  const managed = (probes.managedDaemons ?? classifyManagedDaemons)(cfg, ps);
  const appServer = (probes.appServerProcesses ?? classifyAppServerProcesses)(cfg, ps);
  const pidFile = (probes.daemonPidFile ?? probeDaemonPidFile)(cfg, deps);
  const daemon = (probes.daemonIdentity ?? probeDaemonIdentity)(cfg, ps, pidFile, deps);
  const writers = (probes.writers ?? ((c, pid) => {
    const result = {};
    for (const key of Object.keys(c.threads))
      result[key] = probeWriterOwnership(c, key, pid, deps);
    return result;
  }))(cfg, daemon.pid);
  const socket = await (probes.socket ?? probeSocket)(cfg, deps);
  let guiEnv;
  if (gui.state === PROBE.PRESENT && gui.processes.length === 1) {
    guiEnv = (probes.guiEnv ?? probeGuiEnv)(cfg, gui.processes[0].pid, deps);
  } else {
    guiEnv = {
      state: PROBE.UNKNOWN,
      reason: gui.state === PROBE.PRESENT ? `expected one GUI, found ${gui.processes.length}` : "GUI identity unknown",
    };
  }
  const threads = await (probes.threads ?? probeThreads)(cfg, deps);
  const toolSurface = await (probes.toolSurface ?? probeToolSurface)(cfg, deps);
  return { ps, gui, guiEnv, managedDaemons: managed, appServer, daemonPidFile: pidFile, daemon, writers, socket, threads, toolSurface };
}

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

function gate(gates, reasons, name, verdict, code, detail) {
  gates[name] = verdict;
  if (verdict !== GATE.PASS) reasons.push({ gate: name, code, detail: detail ?? null, verdict });
}

export function decidePreflight(cfg, obs) {
  const gates = {};
  const reasons = [];
  const ps = obs?.ps ?? { state: PROBE.UNKNOWN, reason: "missing" };

  // 1. process table probe.
  if (ps.state !== PROBE.PRESENT) {
    gate(gates, reasons, "process_probe", GATE.UNKNOWN, "BLOCK_PS_PROBE_UNKNOWN", ps.reason);
  } else {
    gate(gates, reasons, "process_probe", GATE.PASS, null);
  }

  // 2. no trusted GUI.
  const gui = obs?.gui ?? { state: PROBE.UNKNOWN, processes: [] };
  if (gui.state === PROBE.UNKNOWN) {
    gate(gates, reasons, "gui_absent", GATE.UNKNOWN, "BLOCK_GUI_UNKNOWN", gui.reason);
  } else if (gui.state === PROBE.PRESENT && gui.processes.length > 1) {
    gate(gates, reasons, "gui_absent", GATE.BLOCK, "BLOCK_GUI_DUPLICATE", `GUI pids: ${gui.processes.map((p) => p.pid).join(",")}`);
  } else if (gui.state === PROBE.PRESENT && gui.processes.length === 1) {
    gate(gates, reasons, "gui_absent", GATE.BLOCK, "BLOCK_GUI_ALREADY_RUNNING", `GUI pid ${gui.processes[0].pid}`);
  } else {
    gate(gates, reasons, "gui_absent", GATE.PASS, null);
  }

  // 3. socket identity.
  const socket = obs?.socket ?? { state: PROBE.UNKNOWN };
  if (socket.state === PROBE.UNKNOWN) {
    gate(gates, reasons, "socket_identity", GATE.UNKNOWN, "BLOCK_SOCKET_UNKNOWN", (socket.reasons || []).join("; "));
  } else if (socket.state === PROBE.ABSENT) {
    gate(gates, reasons, "socket_identity", GATE.BLOCK, "BLOCK_SOCKET_ABSENT", (socket.reasons || []).join("; "));
  } else if (!socket.identityOk) {
    gate(gates, reasons, "socket_identity", GATE.BLOCK, "BLOCK_SOCKET_IDENTITY", (socket.reasons || []).join("; "));
  } else {
    gate(gates, reasons, "socket_identity", GATE.PASS, null);
  }

  // 4. socket WS 101.
  const handshake = socket.handshake ?? { state: PROBE.UNKNOWN };
  if (handshake.state === PROBE.PRESENT && handshake.handshake === "101") {
    gate(gates, reasons, "socket_handshake", GATE.PASS, null);
  } else if (handshake.state === PROBE.PRESENT) {
    gate(gates, reasons, "socket_handshake", GATE.BLOCK, "BLOCK_SOCKET_NOT_101", handshake.statusLine);
  } else {
    gate(gates, reasons, "socket_handshake", GATE.UNKNOWN, "BLOCK_SOCKET_HANDSHAKE_UNKNOWN", handshake.reason);
  }

  // 5. daemon process identity.
  const daemon = obs?.daemon ?? { state: PROBE.UNKNOWN };
  if (daemon.state === PROBE.UNKNOWN) {
    gate(gates, reasons, "daemon_identity", GATE.UNKNOWN, "BLOCK_DAEMON_UNKNOWN", (daemon.reasons || []).join("; "));
  } else if (daemon.state !== PROBE.PRESENT) {
    gate(gates, reasons, "daemon_identity", GATE.BLOCK, "BLOCK_DAEMON_ABSENT", (daemon.reasons || []).join("; "));
  } else if (!daemon.identityOk) {
    gate(gates, reasons, "daemon_identity", GATE.BLOCK, "BLOCK_DAEMON_IDENTITY", (daemon.reasons || []).join("; "));
  } else {
    gate(gates, reasons, "daemon_identity", GATE.PASS, null);
  }

  // 6. daemon version command agrees (running, canonical socketPath, same binary/version).
  const vc = daemon.versionCommand ?? { state: PROBE.UNKNOWN };
  if (vc.state === PROBE.UNKNOWN) {
    gate(gates, reasons, "daemon_version", GATE.UNKNOWN, "BLOCK_DAEMON_VERSION_UNKNOWN", vc.reason);
  } else if (!vc.ok) {
    gate(gates, reasons, "daemon_version", GATE.BLOCK, "BLOCK_DAEMON_VERSION_MISMATCH", vc.reason);
  } else {
    const mismatches = [];
    if (daemon.version && typeof vc.info?.managedCodexVersion === "string") {
      const reported = vc.info.managedCodexVersion;
      if (daemon.version !== reported && !daemon.version.startsWith(reported + "-"))
        mismatches.push(`release ${daemon.version} != managedCodexVersion ${reported}`);
    }
    if (vc.info?.managedCodexPath) {
      const managedReal = safeRealpath(vc.info.managedCodexPath);
      if (!managedReal) mismatches.push("managedCodexPath realpath unavailable");
      else if (daemon.realpath && managedReal !== daemon.realpath)
        mismatches.push(`managedCodexPath ${managedReal} != process realpath ${daemon.realpath}`);
    }
    if (
      typeof vc.info?.appServerVersion === "string" &&
      typeof vc.info?.managedCodexVersion === "string" &&
      vc.info.appServerVersion !== vc.info.managedCodexVersion
    ) {
      mismatches.push(`appServerVersion ${vc.info.appServerVersion} != managedCodexVersion ${vc.info.managedCodexVersion}`);
    }
    if (mismatches.length) {
      gate(gates, reasons, "daemon_version", GATE.BLOCK, "BLOCK_DAEMON_VERSION_MISMATCH", mismatches.join("; "));
    } else {
      gate(gates, reasons, "daemon_version", GATE.PASS, null);
    }
  }

  // 7. writer ownership per original thread.
  const managedPid = daemon.pid ?? null;
  const writers = obs?.writers ?? {};
  let writerVerdict = GATE.PASS;
  let writerCode = null;
  const writerDetails = [];
  for (const key of Object.keys(cfg.threads)) {
    const w = writers[key];
    if (!w || w.state === PROBE.UNKNOWN) {
      writerVerdict = GATE.UNKNOWN;
      writerCode = writerCode ?? "BLOCK_WRITER_LOCK_UNKNOWN";
      writerDetails.push(`${key}: ${w?.reason ?? "missing writer probe"}`);
      continue;
    }
    if (w.unsafe) {
      writerVerdict = GATE.BLOCK;
      writerCode = writerVerdict === GATE.BLOCK && writerCode === null ? "BLOCK_WRITER_LOCK_UNSAFE" : writerCode;
      writerDetails.push(`${key}: ${w.reason}`);
      continue;
    }
    const owners = w.owners ?? [];
    if (owners.length === 0) continue;
    if (owners.length > 1) {
      writerVerdict = GATE.BLOCK;
      writerCode = "BLOCK_WRITER_MULTI";
      writerDetails.push(`${key}: ${owners.length} holders (${owners.join(",")})`);
      continue;
    }
    if (!managedPid || owners[0] !== managedPid) {
      writerVerdict = GATE.BLOCK;
      writerCode = "BLOCK_WRITER_FOREIGN";
      writerDetails.push(`${key}: holder ${owners[0]} is not managed daemon ${managedPid}`);
    }
  }
  if (writerVerdict !== GATE.PASS) {
    gate(gates, reasons, "writer_ownership", writerVerdict, writerCode, writerDetails.join("; "));
  } else {
    gate(gates, reasons, "writer_ownership", GATE.PASS, null);
  }

  // 8. exactly one managed daemon (the one from daemon.pid).
  const managed = obs?.managedDaemons ?? { state: PROBE.UNKNOWN, list: [] };
  if (managed.state !== PROBE.PRESENT) {
    gate(gates, reasons, "single_managed_daemon", GATE.UNKNOWN, "BLOCK_DAEMON_SCAN_UNKNOWN", managed.reason);
  } else {
    const extras = managed.list.filter((d) => d.pid !== managedPid);
    if (extras.length) {
      gate(
        gates,
        reasons,
        "single_managed_daemon",
        GATE.BLOCK,
        "BLOCK_SECOND_MANAGED_DAEMON",
        extras.map((d) => `${d.pid}:${d.argv0}`).join("; "),
      );
    } else if (!managed.list.some((d) => d.pid === managedPid)) {
      gate(gates, reasons, "single_managed_daemon", GATE.BLOCK, "BLOCK_DAEMON_ABSENT", "managed daemon not in process scan");
    } else {
      gate(gates, reasons, "single_managed_daemon", GATE.PASS, null);
    }
  }

  // 9. extra sockets in the private daemon directory are reported as warnings
  // but never block and never grant PASS: daemon identity comes from daemon.pid
  // + process identity + the canonical socket's 101 handshake. A stale listener
  // that accepts a connection but never answers must not be read as a live
  // daemon; an unrelated app-server from a different CODEX_HOME that happens to
  // create its socket in the same per-uid directory must not cause a false
  // second-daemon block. Real second-daemon risk is caught by the process
  // identity scan above and by the L2 "no new app-server" gate.
  const extra = obs?.extraSockets ?? { state: PROBE.UNKNOWN, entries: [] };
  const warnings = [];
  if (extra?.state === PROBE.PRESENT && (extra.entries || []).length) {
    warnings.push({
      gate: "extra_sockets",
      code: "WARN_EXTRA_SOCKETS",
      detail: extra.entries.map((e) => `${e.name}:${e.classification}`).join("; "),
      notIdentityEvidence: true,
    });
  } else if (extra?.state === PROBE.UNKNOWN) {
    warnings.push({
      gate: "extra_sockets",
      code: "WARN_EXTRA_SOCKET_SCAN_UNKNOWN",
      detail: (extra.reasons || []).join("; "),
      notIdentityEvidence: true,
    });
  }
  gate(gates, reasons, "extra_sockets", GATE.PASS, null);

  const ok = reasons.length === 0;
  const severity = !ok && reasons.some((r) => r.verdict === GATE.BLOCK) ? GATE.BLOCK : ok ? GATE.PASS : GATE.UNKNOWN;
  return {
    ok,
    code: ok ? "LAUNCH_PREFLIGHT_OK" : reasons[0].code,
    severity,
    gates,
    blockReasons: reasons,
    warnings,
    expectedUrl: cfg.expectedUrl,
  };
}

function writerVerdictFor(cfg, post, key, expectedPid) {
  const w = post?.writers?.[key];
  if (!w) return { verdict: GATE.UNKNOWN, code: "L2_WRITER_MISSING", detail: "writer probe missing" };
  if (w.state === PROBE.UNKNOWN) return { verdict: GATE.UNKNOWN, code: "L2_WRITER_UNKNOWN", detail: w.reason };
  if (w.unsafe) return { verdict: "FAIL", code: "L2_WRITER_UNSAFE", detail: w.reason };
  const owners = w.owners ?? [];
  if (owners.length === 0) return { verdict: GATE.PASS };
  if (owners.length > 1) return { verdict: "FAIL", code: "L2_WRITER_MULTI", detail: owners.join(",") };
  if (!expectedPid || owners[0] !== expectedPid)
    return { verdict: "FAIL", code: "L2_WRITER_FOREIGN", detail: `${owners[0]} != ${expectedPid}` };
  return { verdict: GATE.PASS };
}

export function daemonAnchors(obs) {
  const d = obs?.daemon ?? {};
  return {
    state: d.state ?? PROBE.UNKNOWN,
    pid: d.pid ?? null,
    realpath: d.realpath ?? null,
    version: d.version ?? null,
    bootId: d.bootIdFromPidFile ?? null,
    systemBootId: d.systemBootId ?? null,
    bootIdVerified: d.bootIdVerified ?? "UNKNOWN",
    startSeconds: d.startSecondsFromPidFile ?? null,
    lstartText: d.lstartText ?? null,
    lstartEpochSeconds: d.lstartEpochSeconds ?? null,
    startVerified: d.startVerified ?? "UNKNOWN",
    pidFileSha256: obs?.daemonPidFile?.fileSha256 ?? null,
    versionCommand: obs?.daemon?.versionCommand
      ? {
          state: obs.daemon.versionCommand.state,
          ok: obs.daemon.versionCommand.ok ?? false,
          status: obs.daemon.versionCommand.info?.status ?? null,
          socketPath: obs.daemon.versionCommand.info?.socketPath ?? null,
          managedCodexVersion: obs.daemon.versionCommand.info?.managedCodexVersion ?? null,
          managedCodexPath: obs.daemon.versionCommand.info?.managedCodexPath ?? null,
          appServerVersion: obs.daemon.versionCommand.info?.appServerVersion ?? null,
        }
      : null,
  };
}

export function evaluatePostLaunch(cfg, pre, post) {
  const gates = {};
  const failures = [];
  const unknowns = [];
  const put = (name, verdict, code, detail) => {
    gates[name] = verdict;
    if (verdict === "FAIL") failures.push({ gate: name, code, detail: detail ?? null });
    else if (verdict === GATE.UNKNOWN) unknowns.push({ gate: name, code, detail: detail ?? null });
  };

  // 1. exactly one trusted GUI main process.
  const gui = post?.gui ?? { state: PROBE.UNKNOWN, processes: [] };
  if (gui.state === PROBE.PRESENT && gui.processes.length === 1) put("gui_single_trusted", GATE.PASS);
  else if (gui.state === PROBE.PRESENT && gui.processes.length > 1)
    put("gui_single_trusted", "FAIL", "L2_GUI_DUPLICATE", gui.processes.map((p) => p.pid).join(","));
  else if (gui.state === PROBE.ABSENT) put("gui_single_trusted", "FAIL", "L2_GUI_ABSENT", "no trusted GUI after open");
  else put("gui_single_trusted", GATE.UNKNOWN, "L2_GUI_UNKNOWN", gui.reason);

  // 2. GUI env has EXACTLY the expected WS URL.
  const env = post?.guiEnv ?? { state: PROBE.UNKNOWN };
  if (env.state !== PROBE.PRESENT) put("gui_env_exact", GATE.UNKNOWN, "L2_GUI_ENV_UNKNOWN", env.reason);
  else if (!env.present) put("gui_env_exact", "FAIL", "L2_GUI_ENV_MISSING", "CODEX_APP_SERVER_WS_URL absent");
  else if (env.value !== cfg.expectedUrl)
    put("gui_env_exact", "FAIL", "L2_GUI_ENV_MISMATCH", `${JSON.stringify(env.value)} != ${JSON.stringify(cfg.expectedUrl)}`);
  else put("gui_env_exact", GATE.PASS);

  // 3. WS handshake still 101 on the same canonical socket.
  const socket = post?.socket ?? { state: PROBE.UNKNOWN };
  if (socket.state === PROBE.PRESENT && socket.identityOk && socket.handshake?.handshake === "101")
    put("ws_101", GATE.PASS);
  else if (socket.state === PROBE.PRESENT && socket.handshake?.state === PROBE.PRESENT)
    put("ws_101", "FAIL", "L2_WS_NOT_101", socket.handshake?.statusLine ?? "non-101");
  else if (socket.state === PROBE.PRESENT && !socket.identityOk)
    put("ws_101", "FAIL", "L2_SOCKET_IDENTITY", (socket.reasons || []).join("; "));
  else put("ws_101", GATE.UNKNOWN, "L2_WS_UNKNOWN", (socket.reasons || []).join("; ") || socket.handshake?.reason);

  // 4. daemon identity unchanged.
  const preA = daemonAnchors(pre);
  const postA = daemonAnchors(post);
  const daemonProblems = [];
  const daemonUnknown = [];
  if (postA.state === PROBE.UNKNOWN) daemonUnknown.push("post daemon identity unknown");
  else if (postA.state !== PROBE.PRESENT) daemonProblems.push(`daemon state ${postA.state}`);
  for (const field of ["pid", "realpath", "version", "pidFileSha256", "bootId", "startSeconds", "lstartText"]) {
    if (postA[field] === null || preA[field] === null) daemonUnknown.push(`${field} unverified`);
    else if (postA[field] !== preA[field]) daemonProblems.push(`${field}: ${JSON.stringify(preA[field])} -> ${JSON.stringify(postA[field])}`);
  }
  if (preA.versionCommand?.state === PROBE.PRESENT && postA.versionCommand?.state === PROBE.PRESENT) {
    for (const field of ["status", "socketPath", "managedCodexVersion", "managedCodexPath", "appServerVersion"]) {
      if (postA.versionCommand[field] !== preA.versionCommand[field])
        daemonProblems.push(`versionCommand.${field} changed`);
    }
  } else if (postA.versionCommand?.state === PROBE.UNKNOWN) {
    daemonUnknown.push("post daemon version command unknown");
  }
  if (postA.bootIdVerified === "MISMATCH") daemonProblems.push("daemon.pid bootId mismatch vs sysctl");
  if (postA.startVerified === "MISMATCH") daemonProblems.push("daemon.pid start time mismatch vs ps lstart");
  if (postA.bootIdVerified === "UNKNOWN") daemonUnknown.push("bootId cross-check unknown");
  if (postA.startVerified === "UNKNOWN") daemonUnknown.push("process start cross-check unknown");
  if (daemonProblems.length) put("daemon_identity_unchanged", "FAIL", "L2_DAEMON_CHANGED", daemonProblems.join("; "));
  else if (daemonUnknown.length) put("daemon_identity_unchanged", GATE.UNKNOWN, "L2_DAEMON_UNKNOWN", daemonUnknown.join("; "));
  else put("daemon_identity_unchanged", GATE.PASS);

  // 5. no new managed daemon / no new app-server spawned by App.
  const managed = post?.managedDaemons ?? { state: PROBE.UNKNOWN, list: [] };
  const appServer = post?.appServer ?? { state: PROBE.UNKNOWN, pids: [] };
  const preAppServer = new Set((pre?.appServer?.pids ?? []).map(String));
  if (managed.state !== PROBE.PRESENT || appServer.state !== PROBE.PRESENT) {
    put("no_new_daemon", GATE.UNKNOWN, "L2_DAEMON_SCAN_UNKNOWN", managed.reason ?? appServer.reason);
  } else {
    const problems = [];
    const primaryPid = preA.pid;
    if (managed.list.length !== 1) problems.push(`managed daemon count ${managed.list.length}`);
    else if (managed.list[0].pid !== primaryPid) problems.push(`managed daemon pid ${managed.list[0].pid} != ${primaryPid}`);
    const newAppServers = appServer.pids.filter((pid) => !preAppServer.has(String(pid)));
    if (newAppServers.length) problems.push(`new app-server pids ${newAppServers.join(",")}`);
    if (problems.length) put("no_new_daemon", "FAIL", "L2_NEW_DAEMON", problems.join("; "));
    else put("no_new_daemon", GATE.PASS);
  }

  // 6/7. per-thread writer ownership.
  for (const key of Object.keys(cfg.threads)) {
    const gateName = `writer_owner_${key.toLowerCase()}`;
    const v = writerVerdictFor(cfg, post, key, preA.pid);
    if (v.verdict === GATE.PASS) put(gateName, GATE.PASS);
    else if (v.verdict === GATE.UNKNOWN) put(gateName, GATE.UNKNOWN, v.code, v.detail);
    else put(gateName, "FAIL", v.code, v.detail);
  }

  // 8. thread metadata (includeTurns:false only).
  const threads = post?.threads ?? { state: PROBE.UNKNOWN, threads: {} };
  for (const key of Object.keys(cfg.threads)) {
    const gateName = `thread_${key.toLowerCase()}_metadata`;
    const t = threads.threads?.[key];
    if (!t) put(gateName, GATE.UNKNOWN, "L2_THREAD_PROBE_UNKNOWN", threads.error ?? "missing thread probe");
    else if (t.state === PROBE.UNKNOWN) put(gateName, GATE.UNKNOWN, "L2_THREAD_PROBE_UNKNOWN", t.error);
    else if (t.state === "RPC_ERROR") put(gateName, "FAIL", "L2_THREAD_RPC_ERROR", t.error);
    else {
      const problems = [];
      if (!t.matches?.id) problems.push(`id ${JSON.stringify(t.threadId)} != ${JSON.stringify(cfg.threads[key].id)}`);
      if (!t.matches?.cwd) problems.push(`cwd ${JSON.stringify(t.cwd)} != ${JSON.stringify(cfg.threads[key].cwd)}`);
      if (key === "B" && t.status !== "idle") problems.push(`B status ${JSON.stringify(t.status)} != idle`);
      if (problems.length) put(gateName, "FAIL", "L2_THREAD_METADATA_MISMATCH", problems.join("; "));
      else put(gateName, GATE.PASS);
    }
  }

  // 9. DevSpace codex_app tool surface unchanged.
  const tool = post?.toolSurface ?? { state: PROBE.UNKNOWN };
  if (tool.state === PROBE.PRESENT && tool.ok) put("tool_surface_unchanged", GATE.PASS);
  else if (tool.state === PROBE.PRESENT) put("tool_surface_unchanged", "FAIL", "L2_TOOL_SURFACE_DRIFT", tool.reason);
  else put("tool_surface_unchanged", GATE.UNKNOWN, "L2_TOOL_SURFACE_UNKNOWN", tool.reason);

  let outcome;
  if (failures.length) outcome = L2_FAIL;
  else if (unknowns.length) outcome = L2_INCOMPLETE;
  else outcome = L2_PASS;
  return {
    outcome,
    machinePass: outcome === L2_PASS,
    userVisualRequired: true,
    note:
      outcome === L2_PASS
        ? "All machine-checkable L2 gates passed. This is NOT user-visible validation: the user must still confirm the original conversation is visible in the App (separate manual gate)."
        : "Machine gates are not fully proven; launch may not be claimed as successful and user-visible validation is not applicable.",
    gates,
    failures,
    unknowns,
  };
}

/* ------------------------------------------------------------------ *
 * Freshness (P1-04)
 * ------------------------------------------------------------------ */

export function preflightFingerprint(obs) {
  const gui = obs?.gui ?? {};
  const d = daemonAnchors(obs);
  const writers = {};
  for (const [key, w] of Object.entries(obs?.writers ?? {}))
    writers[key] = { state: w.state, owners: [...(w.owners ?? [])].sort((a, b) => a - b), unsafe: !!w.unsafe };
  return {
    ps: obs?.ps?.state ?? PROBE.UNKNOWN,
    gui: { state: gui.state ?? PROBE.UNKNOWN, pids: (gui.processes ?? []).map((p) => p.pid).sort((a, b) => a - b) },
    socket: {
      state: obs?.socket?.state ?? PROBE.UNKNOWN,
      identityOk: !!obs?.socket?.identityOk,
      handshake: obs?.socket?.handshake?.handshake ?? obs?.socket?.handshake?.kind ?? null,
      realpath: obs?.socket?.realpath ?? null,
      target: obs?.socket?.target ?? null,
      parent: obs?.socket?.parent ?? null,
    },
    daemon: d,
    writers,
    managedDaemons: (obs?.managedDaemons?.list ?? []).map((x) => x.pid).sort((a, b) => a - b),
    appServer: [...(obs?.appServer?.pids ?? [])].map(String).sort(),
    extraSockets: (obs?.extraSockets?.entries ?? [])
      .map((e) => `${e.name}:${e.classification}`)
      .sort(),
  };
}

export function diffFingerprints(before, after) {
  const changes = [];
  const walk = (path, a, b) => {
    const aObj = a && typeof a === "object";
    const bObj = b && typeof b === "object";
    if (aObj && bObj && !Array.isArray(a) && !Array.isArray(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of [...keys].sort()) walk(path ? `${path}.${key}` : key, a[key], b[key]);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, before: a, after: b });
  };
  walk("", before, after);
  return { same: changes.length === 0, changes };
}

/* ------------------------------------------------------------------ *
 * Launch runner (P1-04 single open)
 * ------------------------------------------------------------------ */

async function defaultOpen({ app, url }) {
  const r = spawnSync("/usr/bin/open", ["-a", app, "--env", "CODEX_APP_SERVER_WS_URL=" + url], {
    encoding: "utf8",
    timeout: 15000,
  });
  return { status: r.status, error: r.error ?? null, stderr: r.stderr ?? "" };
}

export async function runCheck(deps = {}) {
  const cfg = deps.config ?? defaultConfig();
  const collect = deps.collectPreflight ?? ((c) => collectPreflight(c, deps));
  const obs = await collect(cfg);
  const decision = decidePreflight(cfg, obs);
  return { action: "--check", cfg, obs, decision };
}

export async function runLaunch(deps = {}) {
  const cfg = deps.config ?? defaultConfig();
  const collect = deps.collectPreflight ?? ((c) => collectPreflight(c, deps));
  const result = { action: "--launch", openCalls: 0 };

  const pre1 = await collect(cfg);
  const first = decidePreflight(cfg, pre1);
  if (!first.ok) {
    return { ...result, phase: "preflight", decision: first, preflight: summary(pre1) };
  }

  // P1-04: full fresh re-collection immediately before the single open call.
  const pre2 = await collect(cfg);
  const drift = diffFingerprints(preflightFingerprint(pre1), preflightFingerprint(pre2));
  if (!drift.same) {
    return {
      ...result,
      phase: "preflight_freshness",
      code: "BLOCK_PREFLIGHT_DRIFT",
      drift: drift.changes,
      decision: decidePreflight(cfg, pre2),
      preflight: summary(pre2),
    };
  }
  const second = decidePreflight(cfg, pre2);
  if (!second.ok) {
    return { ...result, phase: "preflight_freshness", code: "BLOCK_PREFLIGHT_DRIFT", drift: [], decision: second };
  }

  // Exactly one open call. No retry, no kill, no relaunch on any failure.
  const open = deps.open ?? defaultOpen;
  result.openCalls = 1;
  const openResult = await open({ app: cfg.appPath, url: cfg.expectedUrl });
  if (!openResult || openResult.error || openResult.status !== 0) {
    return {
      ...result,
      phase: "open",
      code: "APP_SHARED_LAUNCH_FAILED",
      detail: openResult?.error?.message ?? `open exit ${openResult?.status}`,
      decision: second,
    };
  }

  const post = await (deps.collectPostLaunch ?? ((c, pre) => collectPostLaunch(c, pre, deps)))(cfg, pre2);
  const decision = evaluatePostLaunch(cfg, pre2, post);
  return { ...result, phase: "l2", decision, post: summarizePost(post) };
}

function summary(obs) {
  return {
    gui: { state: obs?.gui?.state, pids: (obs?.gui?.processes ?? []).map((p) => p.pid) },
    socket: {
      state: obs?.socket?.state,
      identityOk: obs?.socket?.identityOk,
      handshake: obs?.socket?.handshake?.handshake ?? obs?.socket?.handshake?.kind ?? null,
    },
    daemon: {
      state: obs?.daemon?.state,
      pid: obs?.daemon?.pid ?? null,
      realpath: obs?.daemon?.realpath ?? null,
      version: obs?.daemon?.version ?? null,
      identityOk: obs?.daemon?.identityOk ?? false,
    },
    writers: Object.fromEntries(
      Object.entries(obs?.writers ?? {}).map(([k, w]) => [k, w.owners ?? []]),
    ),
    managedDaemons: (obs?.managedDaemons?.list ?? []).map((d) => d.pid),
    extraSockets: (obs?.extraSockets?.entries ?? []).map((e) => ({ name: e.name, classification: e.classification })),
  };
}

function summarizePost(post) {
  return {
    gui: { state: post?.gui?.state, pids: (post?.gui?.processes ?? []).map((p) => p.pid) },
    guiEnv: { state: post?.guiEnv?.state, present: post?.guiEnv?.present, value: post?.guiEnv?.value },
    socket: { state: post?.socket?.state, handshake: post?.socket?.handshake?.handshake ?? null },
    daemon: { state: post?.daemon?.state, pid: post?.daemon?.pid ?? null, version: post?.daemon?.version ?? null },
    writers: Object.fromEntries(Object.entries(post?.writers ?? {}).map(([k, w]) => [k, w.owners ?? []])),
    threads: post?.threads?.threads ?? null,
    toolSurface: { state: post?.toolSurface?.state, ok: post?.toolSurface?.ok ?? false, reason: post?.toolSurface?.reason ?? null },
  };
}

/* ------------------------------------------------------------------ *
 * JSON formatting helpers used by the CLI (kept here so tests can reuse)
 * ------------------------------------------------------------------ */

function formatMode(mode) {
  return typeof mode === "number" ? "0" + mode.toString(8).padStart(3, "0") : null;
}

export function checkReport(cfg, obs, decision) {
  return {
    action: "--check",
    generatedAt: new Date().toISOString(),
    appFound: existsSync(cfg.appPath),
    expectedUrl: cfg.expectedUrl,
    gui: (obs?.gui?.processes ?? []).map((p) => ({ pid: p.pid, identity: p.identity })),
    guiState: obs?.gui?.state ?? PROBE.UNKNOWN,
    sock: {
      ok:
        obs?.socket?.state === PROBE.PRESENT &&
        obs.socket.identityOk === true &&
        obs?.socket?.handshake?.handshake === "101",
      state: obs?.socket?.state ?? PROBE.UNKNOWN,
      identityOk: obs?.socket?.identityOk ?? false,
      reason: obs?.socket?.handshake?.handshake ?? obs?.socket?.handshake?.reason ?? (obs?.socket?.reasons || []).join("; "),
      alias: cfg.socketAlias,
      realpath: obs?.socket?.realpath ?? null,
      parent: obs?.socket?.parent ?? null,
      parentMode: formatMode(obs?.socket?.parentMode),
      aliasParentMode: formatMode(obs?.socket?.aliasParentMode),
      target: obs?.socket?.target
        ? { ...obs.socket.target, mode: formatMode(obs.socket.target.mode) }
        : null,
    },
    daemon: {
      ok: obs?.daemon?.state === PROBE.PRESENT && obs?.daemon?.identityOk === true,
      state: obs?.daemon?.state ?? PROBE.UNKNOWN,
      pid: obs?.daemon?.pid ?? null,
      realpath: obs?.daemon?.realpath ?? null,
      version: obs?.daemon?.version ?? null,
      bootIdVerified: obs?.daemon?.bootIdVerified ?? "UNKNOWN",
      startVerified: obs?.daemon?.startVerified ?? "UNKNOWN",
      versionCommand: obs?.daemon?.versionCommand
        ? {
            state: obs?.daemon.versionCommand.state,
            ok: obs?.daemon.versionCommand.ok ?? false,
            status: obs?.daemon.versionCommand.info?.status ?? null,
            socketPath: obs?.daemon.versionCommand.info?.socketPath ?? null,
            managedCodexVersion: obs?.daemon.versionCommand.info?.managedCodexVersion ?? null,
            reason: obs?.daemon.versionCommand.reason ?? null,
          }
        : null,
      reasons: obs?.daemon?.reasons ?? [],
    },
    writers: Object.fromEntries(Object.entries(obs?.writers ?? {}).map(([k, w]) => [k, w.owners ?? []])),
    managedDaemons: (obs?.managedDaemons?.list ?? []).map((d) => d.pid),
    appServerPids: obs?.appServer?.pids ?? [],
    extraSockets: (obs?.extraSockets?.entries ?? []).map((e) => ({
      name: e.name,
      classification: e.classification,
    })),
    launchPermitted: decision.ok,
    ok: decision.ok,
    code: decision.code,
    severity: decision.severity,
    gates: decision.gates,
    blockReasons: decision.blockReasons,
    warnings: decision.warnings ?? [],
  };
}

export function isEntrypoint(metaUrl, argv = process.argv) {
  try {
    return realpathSync(new URL(metaUrl).pathname) === realpathSync(argv[1]);
  } catch {
    return false;
  }
}
