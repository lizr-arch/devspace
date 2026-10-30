/**
 * Fault-injection tests for the fail-closed shared-Codex ChatGPT launch
 * verifier (DEVSPACE-CODEX-APP-ONEPASS-003).
 *
 * Run with: node --test scripts/tests/verify-chatgpt-shared-launch.test.mjs
 *
 * Rules honored here:
 * - No test spawns /usr/bin/open: launch tests inject a fake open() and count
 *   the calls (must be exactly 0 or 1).
 * - No test performs a write against the production daemon. Socket-level tests
 *   use private unix sockets created under a short /tmp fixture directory.
 * - All probes are either fed plain observation objects (decision layer) or
 *   exercised with a fake command runner (probe layer).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_THREADS,
  EXPECTED_CODEX_APP_TOOLS,
  EXPECTED_MCP_TOOL_COUNT,
  GATE,
  L2_FAIL,
  L2_INCOMPLETE,
  L2_PASS,
  PROBE,
  checkReport,
  classifyGui,
  collectPreflight,
  decidePreflight,
  defaultConfig,
  evaluatePostLaunch,
  preflightFingerprint,
  probeDaemonIdentity,
  probeDaemonPidFile,
  probeNativeRolloutLedger,
  probeProcesses,
  probeSocket,
  probeThreads,
  probeToolSurface,
  probeWriterOwnership,
  runCheck,
  runLaunch,
  scanExtraSockets,
} from "../lib/launch-guard.mjs";

const LIB_PATH = fileURLToPath(new URL("../lib/launch-guard.mjs", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../verify-chatgpt-shared-launch.mjs", import.meta.url));
const UID = process.getuid?.() ?? 501;
const MANAGED_PID = 46163;
const BOOT = "DA24B34C-4704-499E-A984-CCB8A6854E1E";
const LSTART = "Sat Oct 24 17:38:57 2026";
// Derive the epoch in the test process timezone so the lstart cross-check is
// timezone-independent (production reads both from the live machine).
const START_SECONDS = Math.floor(Date.parse(LSTART) / 1000);
const RELEASE = "0.164.0-aarch64-apple-darwin";
const MANAGED_VERSION = "0.164.0";

const fixtures = [];
after(() => {
  for (const dir of fixtures) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function makeBase() {
  const base = realpathSync(mkdtempSync("/tmp/lg-"));
  fixtures.push(base);
  return base;
}

/** Build a fully configurable fixture config + on-disk tree (daemon pid file,
 * executable, thread-lock dir, alias dir, private socket dir). */
function makeFixture(overrides = {}) {
  const base = makeBase();
  const cfg = defaultConfig({
    home: join(base, "home"),
    codexHome: join(base, "codex"),
    uid: UID,
    socketAlias: join(base, "alias", "app-server-control.sock"),
    aliasParent: join(base, "alias"),
    socketParent: join(base, "codex-daemon-" + UID),
    codexCliPath: join(base, "codex"),
    appPath: join(base, "Applications/ChatGPT.app"),
    mainBin: join(base, "Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
    socketTimeoutMs: 1500,
    extraSocketTimeoutMs: 400,
    guiWaitMs: 0,
    guiPollMs: 1,
    processTimeoutMs: 1000,
    lsofTimeoutMs: 1000,
    versionTimeoutMs: 3000,
    rpcTimeoutMs: 2000,
    threadReadTimeoutMs: 2000,
    ...overrides,
  });
  const releaseDir = join(cfg.releasesDir, RELEASE, "bin");
  mkdirSync(releaseDir, { recursive: true });
  const daemonRealpath = join(releaseDir, "codex");
  writeFileSync(daemonRealpath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(dirnameSafe(cfg.daemonPidPath), { recursive: true });
  writeFileSync(
    cfg.daemonPidPath,
    JSON.stringify({
      pid: MANAGED_PID,
      processStartTime: LSTART,
      processIdentity: {
        bootId: BOOT,
        uniqueId: 6416213,
        startSeconds: START_SECONDS,
        startMicroseconds: 728030,
      },
      executableIdentity: { digest: Array(32).fill(1), path_digest: Array(32).fill(2) },
    }),
  );
  mkdirSync(cfg.threadLockDir, { recursive: true });
  mkdirSync(cfg.aliasParent, { recursive: true, mode: 0o700 });
  chmodSync(cfg.aliasParent, 0o700);
  mkdirSync(cfg.socketParent, { recursive: true, mode: 0o700 });
  chmodSync(cfg.socketParent, 0o700);
  mkdirSync(join(base, "Applications/ChatGPT.app/Contents/MacOS"), { recursive: true });
  writeFileSync(cfg.mainBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { base, cfg, daemonRealpath };
}

function dirnameSafe(path) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function expectedDaemonCommand(cfg) {
  return `${join(cfg.releasesDir, RELEASE, "bin", "codex")} app-server --listen unix:// --managed-daemon`;
}

function makeRun(spec = {}) {
  const calls = [];
  const normalize = (value, fallback = { status: 0, stdout: "", stderr: "" }) => {
    if (!value) return { ...fallback, signal: null, error: null };
    return {
      status: value.status ?? 0,
      signal: value.signal ?? null,
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
      error: value.error ?? null,
    };
  };
  const run = (argv) => {
    calls.push([...argv]);
    const joined = argv.join(" ");
    if (spec.override) {
      const custom = spec.override(argv, joined);
      if (custom !== undefined) return normalize(custom);
    }
    if (joined === "/bin/ps -axo pid=,comm=") return normalize(spec.psComm ?? { stdout: "    1 /sbin/launchd\n" });
    if (joined === "/bin/ps -axo pid=,command= -ww")
      return normalize(spec.psCommand ?? { stdout: "    1 /sbin/launchd\n" });
    if (argv[0] === "/bin/ps" && argv[1] === "-p") return normalize(spec.psLstart ?? { stdout: LSTART + "\n" });
    if (argv[0] === "/bin/ps" && argv[1] === "eww") return normalize(spec.psEnv ?? { stdout: "" });
    if (argv[0] === "/usr/sbin/sysctl") return normalize(spec.sysctl ?? { stdout: BOOT + "\n" });
    if (argv[0] === "/usr/sbin/lsof" && argv.includes("txt")) {
      const pidIndex = argv.indexOf("-p");
      const pid = Number(argv[pidIndex + 1]);
      const handler = spec.lsofTxt ?? (() => ({ status: 1, stdout: "", stderr: "" }));
      return normalize(handler(pid));
    }
    if (argv[0] === "/usr/sbin/lsof") {
      const lockPath = argv[argv.length - 1];
      const handler = spec.lsofLock ?? (() => ({ status: 1, stdout: "", stderr: "" }));
      return normalize(handler(lockPath));
    }
    if (argv[0] === process.execPath && argv[1]) {
      const handler = spec.version ?? (() => ({ status: 0, stdout: JSON.stringify(defaultVersionInfo(spec.cfg)) }));
      return normalize(handler());
    }
    return normalize(spec.default ?? { status: 127, stdout: "", stderr: "unexpected command" });
  };
  return { run, calls };
}

function defaultVersionInfo(cfg) {
  return {
    status: "running",
    backend: "pid",
    managedCodexPath: join(cfg.releasesDir, RELEASE, "bin", "codex"),
    managedCodexVersion: MANAGED_VERSION,
    socketPath: cfg.socketAlias,
    cliVersion: "0.162.1",
    appServerVersion: MANAGED_VERSION,
  };
}

function psOk(cfg, extraCommands = {}) {
  const daemonCommand = expectedDaemonCommand(cfg);
  return {
    psComm: {
      stdout: [
        `    1 /sbin/launchd`,
        ` ${MANAGED_PID} /Users/liz/.cod`,
        `  4093 ${join(cfg.releasesDir, RELEASE, "bin", "codex").slice(0, 16)}`,
      ].join("\n"),
    },
    psCommand: {
      stdout: [
        `    1 /sbin/launchd`,
        ` ${MANAGED_PID} ${daemonCommand}`,
        `  4093 ${join(cfg.releasesDir, RELEASE, "bin", "codex")} app-server daemon pid-update-loop`,
        ...Object.entries(extraCommands).map(([pid, command]) => ` ${pid} ${command}`),
      ].join("\n"),
    },
  };
}

function guiPs(cfg, { comm, command, pid = 777 } = {}) {
  const base = psOk(cfg);
  base.psComm = {
    stdout: [base.psComm.stdout, ` ${pid} ${comm ?? cfg.mainBin}`].join("\n"),
  };
  base.psCommand = {
    stdout: [base.psCommand.stdout, ` ${pid} ${command ?? cfg.mainBin}`].join("\n"),
  };
  return base;
}

function daemonIdentityOk(cfg, runSpec) {
  const { run } = makeRun({ ...runSpec, cfg });
  const ps = probeProcesses(cfg, { run });
  const pidFile = probeDaemonPidFile(cfg);
  return probeDaemonIdentity(cfg, ps, pidFile, { run });
}

/* ------------------------------------------------------------------ *
 * Synthetic observations (decision layer)
 * ------------------------------------------------------------------ */

function okObs(cfg, daemonRealpath) {
  const daemon = {
    state: PROBE.PRESENT,
    pid: MANAGED_PID,
    identityOk: true,
    realpath: daemonRealpath,
    version: RELEASE,
    argvOk: true,
    processFound: true,
    bootIdFromPidFile: BOOT,
    systemBootId: BOOT,
    bootIdVerified: "MATCH",
    startSecondsFromPidFile: START_SECONDS,
    lstartText: LSTART,
    lstartEpochSeconds: START_SECONDS,
    startVerified: "MATCH",
    reasons: [],
    versionCommand: {
      state: PROBE.PRESENT,
      ok: true,
      info: {
        status: "running",
        socketPath: cfg.socketAlias,
        managedCodexPath: daemonRealpath,
        managedCodexVersion: MANAGED_VERSION,
        appServerVersion: MANAGED_VERSION,
      },
    },
  };
  const socket = {
    state: PROBE.PRESENT,
    identityOk: true,
    realpath: join(cfg.socketParent, "a".repeat(64)),
    parent: cfg.socketParent,
    parentMode: 0o700,
    target: { isSocket: true, uid: UID, mode: 0o600 },
    handshake: { state: PROBE.PRESENT, handshake: "101", kind: "101", statusLine: "HTTP/1.1 101 Switching Protocols" },
    reasons: [],
  };
  return {
    ps: {
      state: PROBE.PRESENT,
      byPid: {
        [MANAGED_PID]: { pid: MANAGED_PID, comm: "/Users/liz/.cod", command: expectedDaemonCommand(cfg) },
      },
      count: 1,
    },
    gui: { state: PROBE.ABSENT, processes: [] },
    socket,
    extraSockets: { state: PROBE.PRESENT, entries: [] },
    managedDaemons: { state: PROBE.PRESENT, list: [{ pid: MANAGED_PID, argv0: daemonRealpath }] },
    appServer: { state: PROBE.PRESENT, pids: [MANAGED_PID] },
    daemonPidFile: {
      state: PROBE.PRESENT,
      pid: MANAGED_PID,
      bootId: BOOT,
      startSeconds: START_SECONDS,
      hasExecutableDigest: true,
      fileSha256: "f".repeat(64),
    },
    daemon,
    writers: {
      A: { state: PROBE.ABSENT, owners: [], unsafe: false, managedPid: MANAGED_PID, lockPath: "A" },
      B: { state: PROBE.ABSENT, owners: [], unsafe: false, managedPid: MANAGED_PID, lockPath: "B" },
    },
  };
}

function okPost(cfg, pre) {
  return {
    ps: pre.ps,
    gui: { state: PROBE.PRESENT, processes: [{ pid: 777, identity: "kernel_comm_truncated_vnode" }] },
    guiEnv: { state: PROBE.PRESENT, pid: 777, present: true, value: cfg.expectedUrl },
    socket: JSON.parse(JSON.stringify(pre.socket)),
    extraSockets: { state: PROBE.PRESENT, entries: [] },
    managedDaemons: JSON.parse(JSON.stringify(pre.managedDaemons)),
    appServer: { state: PROBE.PRESENT, pids: [MANAGED_PID] },
    daemonPidFile: JSON.parse(JSON.stringify(pre.daemonPidFile)),
    daemon: JSON.parse(JSON.stringify(pre.daemon)),
    writers: {
      A: { state: PROBE.PRESENT, owners: [], unsafe: false, managedPid: MANAGED_PID },
      B: { state: PROBE.PRESENT, owners: [MANAGED_PID], unsafe: false, managedPid: MANAGED_PID },
    },
    threads: {
      state: PROBE.PRESENT,
      threads: {
        A: {
          state: PROBE.PRESENT,
          threadId: cfg.threads.A.id,
          cwd: cfg.threads.A.cwd,
          status: "notLoaded",
          matches: { id: true, cwd: true },
        },
        B: {
          state: PROBE.PRESENT,
          threadId: cfg.threads.B.id,
          cwd: cfg.threads.B.cwd,
          status: "idle",
          matches: { id: true, cwd: true },
        },
      },
    },
    toolSurface: { state: PROBE.PRESENT, ok: true, toolCount: EXPECTED_MCP_TOOL_COUNT },
  };
}

/* ------------------------------------------------------------------ *
 * P0-01: ps probe + GUI identity
 * ------------------------------------------------------------------ */

test("P0-01 ps nonzero exit => UNKNOWN and blocks preflight (never 'no GUI')", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const { run } = makeRun({ cfg, psComm: { status: 1, stdout: "", stderr: "ps: error" } });
  const ps = probeProcesses(cfg, { run });
  assert.equal(ps.state, PROBE.UNKNOWN);
  const obs = okObs(cfg, daemonRealpath);
  obs.ps = ps;
  obs.gui = { state: PROBE.UNKNOWN, processes: [], reason: ps.reason };
  const decision = decidePreflight(cfg, obs);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_PS_PROBE_UNKNOWN");
  assert.equal(decision.severity, GATE.UNKNOWN);
});

test("P0-01 ps timeout => UNKNOWN and blocks preflight", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const timeout = {
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
    error: { code: "ETIMEDOUT", message: "spawnSync /bin/ps ETIMEDOUT" },
  };
  const { run } = makeRun({ cfg, psComm: timeout });
  const ps = probeProcesses(cfg, { run });
  assert.equal(ps.state, PROBE.UNKNOWN);
  assert.match(ps.reason, /ETIMEDOUT/);
  const obs = okObs(cfg, daemonRealpath);
  obs.ps = ps;
  obs.gui = { state: PROBE.UNKNOWN, processes: [], reason: ps.reason };
  assert.equal(decidePreflight(cfg, obs).code, "BLOCK_PS_PROBE_UNKNOWN");
});

test("P0-01 unparsable ps output => UNKNOWN and blocks", () => {
  const { cfg } = makeFixture();
  const { run } = makeRun({ cfg, psComm: { status: 0, stdout: "not-a-ps-line\n" } });
  const ps = probeProcesses(cfg, { run });
  assert.equal(ps.state, PROBE.UNKNOWN);
  assert.match(ps.reason, /unparsable/);
});

test("P0-01 GUI: full kernel comm exact match counts as the single trusted GUI", () => {
  const { cfg } = makeFixture();
  const ps = {
    state: PROBE.PRESENT,
    byPid: {
      123: { pid: 123, comm: cfg.mainBin, command: cfg.mainBin },
    },
  };
  const gui = classifyGui(cfg, ps, () => {
    throw new Error("lsof must not be needed for a full comm match");
  });
  assert.equal(gui.state, PROBE.PRESENT);
  assert.equal(gui.processes.length, 1);
  assert.equal(gui.processes[0].identity, "kernel_comm");
}); 

test("P0-01 GUI: kernel comm is 16-byte truncated on macOS; vnode identity confirms it", () => {
  const { cfg } = makeFixture();
  assert.equal(cfg.mainBin.slice(0, 16), cfg.mainCommTruncated);
  const ps = {
    state: PROBE.PRESENT,
    byPid: { 123: { pid: 123, comm: cfg.mainCommTruncated, command: "something-else --flag" } },
  };
  const gui = classifyGui(cfg, ps, (pid) => ({
    state: PROBE.PRESENT,
    paths: ["/usr/lib/dyld", cfg.mainBin],
  }));
  assert.equal(gui.state, PROBE.PRESENT);
  assert.equal(gui.processes[0].identity, "kernel_comm_truncated_vnode");
});

test("P0-01 GUI negative: helper whose argv merely contains the app path is not the GUI", () => {
  const { cfg } = makeFixture();
  const helperCommand =
    "/Applications/ChatGPT.app/Contents/Frameworks/CodexCLI.app/Contents/MacOS/CodexCLI --parent " +
    "/Applications/ChatGPT.app --type=helper";
  const ps = {
    state: PROBE.PRESENT,
    byPid: { 4242: { pid: 4242, comm: cfg.mainCommTruncated, command: helperCommand } },
  };
  const gui = classifyGui(cfg, ps, () => ({
    state: PROBE.PRESENT,
    paths: ["/Applications/ChatGPT.app/Contents/Frameworks/CodexCLI.app/Contents/MacOS/CodexCLI"],
  }));
  assert.equal(gui.state, PROBE.ABSENT);
  assert.deepEqual(gui.processes, []);
});

test("P0-01 GUI negative: truncated comm with lsof failure => UNKNOWN (fail closed)", () => {
  const { cfg } = makeFixture();
  const ps = {
    state: PROBE.PRESENT,
    byPid: { 123: { pid: 123, comm: cfg.mainCommTruncated, command: "spoofed --type=renderer" } },
  };
  const gui = classifyGui(cfg, ps, () => ({ state: PROBE.UNKNOWN, reason: "lsof failed" }));
  assert.equal(gui.state, PROBE.UNKNOWN);
});

test("P0-01 GUI absent => ABSENT; duplicate GUI => BLOCK_GUI_DUPLICATE", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const psAbsent = { state: PROBE.PRESENT, byPid: { 1: { pid: 1, comm: "/sbin/launchd", command: "/sbin/launchd" } } };
  assert.equal(classifyGui(cfg, psAbsent, () => ({ state: PROBE.ABSENT })).state, PROBE.ABSENT);

  const obs = okObs(cfg, daemonRealpath);
  obs.gui = {
    state: PROBE.PRESENT,
    processes: [{ pid: 10, identity: "kernel_comm" }, { pid: 11, identity: "kernel_comm" }],
  };
  const decision = decidePreflight(cfg, obs);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_GUI_DUPLICATE");
});

test("P0-01 single existing GUI => BLOCK_GUI_ALREADY_RUNNING (never restart)", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const obs = okObs(cfg, daemonRealpath);
  obs.gui = { state: PROBE.PRESENT, processes: [{ pid: 10, identity: "kernel_comm" }] };
  const decision = decidePreflight(cfg, obs);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_GUI_ALREADY_RUNNING");
});

/* ------------------------------------------------------------------ *
 * P0-02: daemon identity + writer ownership
 * ------------------------------------------------------------------ */

test("P0-02 daemon.pid invalid JSON => UNKNOWN (blocks), never a fake daemon", () => {
  const { cfg } = makeFixture();
  writeFileSync(cfg.daemonPidPath, "{not json");
  const pidFile = probeDaemonPidFile(cfg);
  assert.equal(pidFile.state, PROBE.UNKNOWN);
  assert.match(pidFile.reason, /not valid JSON/);
});

test("P0-02 daemon executable outside releases/.../codex => identity BLOCK", () => {
  const { cfg } = makeFixture();
  const runSpec = {
    ...psOk(cfg),
    cfg,
    lsofTxt: () => ({ status: 0, stdout: `p${MANAGED_PID}\nftxt\nn${join(cfg.codexHome, "bin", "codex")}\n` }),
  };
  const identity = daemonIdentityOk(cfg, runSpec);
  assert.equal(identity.state, PROBE.PRESENT);
  assert.equal(identity.identityOk, false);
  assert.match(identity.reasons.join(";"), /realpath not under/);

  const obs = okObs(cfg, join(cfg.releasesDir, RELEASE, "bin/codex"));
  obs.daemon = identity;
  const decision = decidePreflight(cfg, obs);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_DAEMON_IDENTITY");
});

test("P0-02 daemon argv without --managed-daemon => identity BLOCK", () => {
  const { cfg } = makeFixture();
  const runSpec = {
    psComm: { stdout: `  1 /sbin/launchd\n ${MANAGED_PID} /Users/liz/.cod\n` },
    psCommand: {
      stdout: `  1 /sbin/launchd\n ${MANAGED_PID} ${join(cfg.releasesDir, RELEASE, "bin", "codex")} app-server --listen unix://\n`,
    },
    cfg,
    lsofTxt: () => ({ status: 0, stdout: `n${join(cfg.releasesDir, RELEASE, "bin", "codex")}\n` }),
  };
  const identity = daemonIdentityOk(cfg, runSpec);
  assert.equal(identity.identityOk, false);
  assert.match(identity.reasons.join(";"), /argv/);
});

test("P0-02 daemon pid missing from process table => ABSENT => BLOCK_DAEMON_ABSENT", () => {
  const { cfg } = makeFixture();
  const runSpec = {
    psComm: { stdout: " 1 /sbin/launchd\n" },
    psCommand: { stdout: " 1 /sbin/launchd\n" },
    cfg,
    lsofTxt: () => ({ status: 0, stdout: "" }),
  };
  const identity = daemonIdentityOk(cfg, runSpec);
  assert.equal(identity.state, PROBE.ABSENT);
});

test("P0-02 daemon version command invalid JSON => UNKNOWN => BLOCK_DAEMON_VERSION_UNKNOWN", () => {
  const { cfg } = makeFixture();
  const runSpec = {
    ...psOk(cfg),
    cfg,
    lsofTxt: () => ({ status: 0, stdout: `n${join(cfg.releasesDir, RELEASE, "bin", "codex")}\n` }),
    version: () => ({ status: 0, stdout: "not-json-at-all\n" }),
  };
  const identity = daemonIdentityOk(cfg, runSpec);
  const obs = okObs(cfg, join(cfg.releasesDir, RELEASE, "bin/codex"));
  obs.daemon = identity;
  const decision = decidePreflight(cfg, obs);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_DAEMON_VERSION_UNKNOWN");
  assert.equal(decision.severity, GATE.UNKNOWN);
});

test("P0-02 version command socketPath drift => BLOCK_DAEMON_VERSION_MISMATCH", () => {
  const { cfg } = makeFixture();
  const runSpec = {
    ...psOk(cfg),
    cfg,
    lsofTxt: () => ({ status: 0, stdout: `n${join(cfg.releasesDir, RELEASE, "bin", "codex")}\n` }),
    version: () => ({
      status: 0,
      stdout: JSON.stringify({ ...defaultVersionInfo(cfg), socketPath: "/tmp/other.sock" }),
    }),
  };
  const identity = daemonIdentityOk(cfg, runSpec);
  assert.equal(identity.identityOk, false);
  assert.match(identity.reasons.join(";"), /socketPath/);
});

test("P0-02 writer locks: lsof failure => UNKNOWN; normal no-holder => []; holder sets parsed", () => {
  const { cfg } = makeFixture();
  const lockPath = join(cfg.threadLockDir, cfg.threads.A.id + ".lock");

  const writeLock = () => writeFileSync(lockPath, "");
  writeLock();

  const missingLockCfg = cfg;
  const missing = probeWriterOwnership(missingLockCfg, "A", MANAGED_PID, {
    run: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  assert.equal(missing.state, PROBE.PRESENT);
  assert.deepEqual(missing.owners, []);

  const errored = probeWriterOwnership(cfg, "A", MANAGED_PID, {
    run: () => ({ status: 2, stdout: "", stderr: "lsof: fatal error" }),
  });
  assert.equal(errored.state, PROBE.UNKNOWN);

  const one = probeWriterOwnership(cfg, "A", MANAGED_PID, {
    run: () => ({ status: 0, stdout: `p${MANAGED_PID}\n` }),
  });
  assert.deepEqual(one.owners, [MANAGED_PID]);

  const two = probeWriterOwnership(cfg, "A", MANAGED_PID, {
    run: () => ({ status: 0, stdout: "p100\np200\n" }),
  });
  assert.deepEqual(two.owners, [100, 200]);

  writeFileSync(join(cfg.threadLockDir, cfg.threads.B.id + ".lock"), "");
  rmSync(lockPath);
});

test("P0-02 writer gates: foreign single, multi writer, unknown all block", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const foreign = okObs(cfg, daemonRealpath);
  foreign.writers.A = { state: PROBE.PRESENT, owners: [999], unsafe: false, managedPid: MANAGED_PID };
  assert.equal(decidePreflight(cfg, foreign).code, "BLOCK_WRITER_FOREIGN");

  const multi = okObs(cfg, daemonRealpath);
  multi.writers.B = { state: PROBE.PRESENT, owners: [MANAGED_PID, 999], unsafe: false, managedPid: MANAGED_PID };
  assert.equal(decidePreflight(cfg, multi).code, "BLOCK_WRITER_MULTI");

  const unknown = okObs(cfg, daemonRealpath);
  unknown.writers.A = { state: PROBE.UNKNOWN, owners: [], reason: "lsof failed", managedPid: MANAGED_PID };
  const decision = decidePreflight(cfg, unknown);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_WRITER_LOCK_UNKNOWN");
  assert.equal(decision.severity, GATE.UNKNOWN);

  const managed = okObs(cfg, daemonRealpath);
  managed.writers.B = { state: PROBE.PRESENT, owners: [MANAGED_PID], unsafe: false, managedPid: MANAGED_PID };
  assert.equal(decidePreflight(cfg, managed).ok, true);
});

test("P0-02 ps scan detects a second real managed daemon argv => BLOCK", async () => {
  const { cfg, daemonRealpath } = makeFixture();
  const ps = psOk(cfg, {
    424242: `${join(cfg.releasesDir, RELEASE, "bin", "codex")} app-server --listen unix:// --managed-daemon`,
  });
  const { run } = makeRun({
    ...ps,
    cfg,
    lsofTxt: () => ({ status: 0, stdout: `n${join(cfg.releasesDir, RELEASE, "bin", "codex")}\n` }),
  });
  const deps = { run, probes: { socket: async () => okObs(cfg, daemonRealpath).socket, extraSockets: async () => ({ state: PROBE.PRESENT, entries: [] }) } };
  const obs = await collectPreflight(cfg, deps);
  assert.equal(obs.managedDaemons.list.length, 2);
  const decision = decidePreflight(cfg, obs);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_SECOND_MANAGED_DAEMON");
});

test("P0-02 second live managed daemon => BLOCK_SECOND_MANAGED_DAEMON", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const obs = okObs(cfg, daemonRealpath);
  obs.managedDaemons = {
    state: PROBE.PRESENT,
    list: [
      { pid: MANAGED_PID, argv0: daemonRealpath },
      { pid: 99999, argv0: join(cfg.releasesDir, RELEASE, "bin", "codex") },
    ],
  };
  const decision = decidePreflight(cfg, obs);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_SECOND_MANAGED_DAEMON");
});

/* ------------------------------------------------------------------ *
 * P1-05: socket identity (real private unix sockets)
 * ------------------------------------------------------------------ */

async function listenUnix(sockPath, mode) {
  const sockets = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    if (mode === "close") {
      socket.destroy();
      return;
    }
    if (mode === "never") return;
    socket.once("data", () => {
      const status = mode === "400" ? "HTTP/1.1 400 Bad Request" : "HTTP/1.1 101 Switching Protocols";
      socket.write(`${status}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });
  chmodSync(sockPath, 0o600);
  return {
    server,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) {
          try {
            s.destroy();
          } catch {}
        }
        server.close(() => resolve());
      }),
  };
}

async function socketFixture(mode = "101", { parentName = null, aliasMode = 0o700, targetMode = 0o600 } = {}) {
  const { cfg } = makeFixture();
  // `cfg.socketParent` stays the canonical expected parent; `parentName`
  // relocates only the real target so the exact-string comparison can be
  // exercised (short name: unix socket paths are limited to ~104 bytes).
  const targetParent = parentName ? join(dirnameSafe(cfg.socketParent), parentName) : cfg.socketParent;
  mkdirSync(targetParent, { recursive: true, mode: 0o700 });
  chmodSync(targetParent, 0o700);
  const target = join(targetParent, "b".repeat(64));
  const server = await listenUnix(target, mode);
  if (targetMode !== 0o600) chmodSync(target, targetMode);
  mkdirSync(cfg.aliasParent, { recursive: true, mode: aliasMode });
  chmodSync(cfg.aliasParent, aliasMode);
  symlinkSync(target, cfg.socketAlias);
  return { cfg, server, target };
}

test("P1-05 socket: canonical alias + 0600 target + 0700 parents + WS 101 => PRESENT", async () => {
  const { cfg, server } = await socketFixture("101");
  try {
    const sock = await probeSocket(cfg);
    assert.equal(sock.state, PROBE.PRESENT);
    assert.equal(sock.identityOk, true);
    assert.equal(sock.handshake.handshake, "101");
    assert.equal(sock.realpath, join(cfg.socketParent, "b".repeat(64)));
    assert.equal(sock.parent, cfg.socketParent);
  } finally {
    await server.close();
  }
});

test("P1-05 socket: non-101 handshake is a known BLOCK, not a pass", async () => {
  const { cfg, server } = await socketFixture("400");
  try {
    const sock = await probeSocket(cfg);
    assert.equal(sock.state, PROBE.PRESENT);
    assert.equal(sock.identityOk, true);
    assert.equal(sock.handshake.handshake, "HTTP/1.1 400 Bad Request");
    const { daemonRealpath } = { daemonRealpath: join(cfg.releasesDir, RELEASE, "bin/codex") };
    const obs = okObs(cfg, daemonRealpath);
    obs.socket = sock;
    const decision = decidePreflight(cfg, obs);
    assert.equal(decision.ok, false);
    assert.equal(decision.code, "BLOCK_SOCKET_NOT_101");
  } finally {
    await server.close();
  }
});

test("P1-05 socket: disconnect before response => UNKNOWN => BLOCK_SOCKET_UNKNOWN", async () => {
  const { cfg, server } = await socketFixture("close");
  try {
    const sock = await probeSocket(cfg);
    assert.equal(sock.state, PROBE.UNKNOWN);
  } finally {
    await server.close();
  }
});

test("P1-05 socket: unresponsive listener (stale) => UNKNOWN, never a live pass", async () => {
  const { cfg, server } = await socketFixture("never");
  try {
    const sock = await probeSocket(cfg);
    assert.equal(sock.state, PROBE.UNKNOWN);
    assert.ok(["TIMEOUT", "CLOSED"].includes(sock.handshake.kind));
  } finally {
    await server.close();
  }
});

test("P1-05 socket: parent mismatch (exact string, not startsWith) => identity BLOCK", async () => {
  // A parent that merely starts with the canonical path must still fail the
  // exact-string comparison; keep it short for the 104-byte unix socket limit.
  const { cfg, server } = await socketFixture("101", { parentName: "c501evil" });
  try {
    const sock = await probeSocket(cfg);
    assert.equal(sock.identityOk, false);
    assert.match(sock.reasons.join(";"), /target parent mismatch/);
  } finally {
    await server.close();
  }
});

test("P1-05 socket: alias directory not 0700 => identity BLOCK", async () => {
  const { cfg, server } = await socketFixture("101", { aliasMode: 0o755 });
  try {
    const sock = await probeSocket(cfg);
    assert.equal(sock.identityOk, false);
    assert.match(sock.reasons.join(";"), /alias parent/);
  } finally {
    await server.close();
  }
});

test("P1-05 socket: wrong uid / unsafe identity => BLOCK_SOCKET_IDENTITY", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const obs = okObs(cfg, daemonRealpath);
  obs.socket = {
    state: PROBE.PRESENT,
    identityOk: false,
    reasons: ["target socket uid mismatch", "socket alias uid mismatch"],
    handshake: { state: PROBE.PRESENT, handshake: "101" },
  };
  const decision = decidePreflight(cfg, obs);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "BLOCK_SOCKET_IDENTITY");
});

test("P1-05 socket: missing alias => ABSENT => BLOCK_SOCKET_ABSENT", async () => {
  const { cfg } = makeFixture();
  const sock = await probeSocket(cfg);
  assert.equal(sock.state, PROBE.ABSENT);
  const obs = okObs(cfg, join(cfg.releasesDir, RELEASE, "bin/codex"));
  obs.socket = sock;
  assert.equal(decidePreflight(cfg, obs).code, "BLOCK_SOCKET_ABSENT");
});

test("P1-05 stale/extra listeners are reported but never grant or break identity", async () => {
  const { cfg, server } = await socketFixture("101");
  const stale = await listenUnix(join(cfg.socketParent, "c".repeat(64)), "never");
  const extraLive = await listenUnix(join(cfg.socketParent, "d".repeat(64)), "101");
  try {
    const sock = await probeSocket(cfg);
    const extras = await scanExtraSockets(cfg, sock);
    assert.equal(extras.state, PROBE.PRESENT);
    const byName = Object.fromEntries(extras.entries.map((e) => [e.name, e.classification]));
    assert.equal(byName["c".repeat(64)], "STALE_UNRESPONSIVE");
    assert.equal(byName["d".repeat(64)], "LIVE_101");

    // Daemon identity is still from PID + process identity + canonical 101.
    const obs = okObs(cfg, join(cfg.releasesDir, RELEASE, "bin/codex"));
    obs.extraSockets = extras;
    const decision = decidePreflight(cfg, obs);
    assert.equal(decision.ok, true);
    assert.equal(decision.gates.extra_sockets, GATE.PASS);
    assert.ok(decision.warnings.some((w) => w.code === "WARN_EXTRA_SOCKETS"));

    // A stale/extra socket cannot replace the canonical handshake.
    const missingCanonical = okObs(cfg, join(cfg.releasesDir, RELEASE, "bin/codex"));
    missingCanonical.socket = { state: PROBE.ABSENT, reasons: ["socket alias missing"] };
    missingCanonical.extraSockets = extras;
    assert.equal(decidePreflight(cfg, missingCanonical).ok, false);
  } finally {
    await stale.close();
    await extraLive.close();
    await server.close();
  }
});

/* ------------------------------------------------------------------ *
 * Full collectPreflight with fake commands + private sockets
 * ------------------------------------------------------------------ */

async function collectFixture({ runSpec, socketMode = "101", lockOverrides = {} } = {}) {
  const { cfg, server } = await socketFixture(socketMode);
  for (const [threadKey, spec] of Object.entries(lockOverrides)) {
    const path = join(cfg.threadLockDir, cfg.threads[threadKey].id + ".lock");
    writeFileSync(path, "");
    spec(cfg, path);
  }
  const lsofLock = (lockPath) => {
    for (const [threadKey, holder] of Object.entries(lockOverrides)) {
      if (lockPath === join(cfg.threadLockDir, cfg.threads[threadKey].id + ".lock")) {
        return holder.result ? holder.result() : { status: 1, stdout: "", stderr: "" };
      }
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  const { run } = makeRun({
    ...psOk(cfg),
    cfg,
    lsofTxt: () => ({ status: 0, stdout: `n${join(cfg.releasesDir, RELEASE, "bin/codex")}\n` }),
    lsofLock,
    ...runSpec,
  });
  const deps = {
    run,
    probes: {
      extraSockets: async () => ({ state: PROBE.PRESENT, entries: [] }),
    },
  };
  const obs = await collectPreflight(cfg, deps);
  return { cfg, obs, server };
}

test("collectPreflight: valid fixture => LAUNCH_PREFLIGHT_OK (read-only, no open)", async () => {
  const { cfg, obs, server } = await collectFixture();
  try {
    const decision = decidePreflight(cfg, obs);
    assert.equal(decision.ok, true, JSON.stringify(decision.blockReasons));
    assert.equal(decision.code, "LAUNCH_PREFLIGHT_OK");
    assert.deepEqual(obs.writers.A.owners, []);
    assert.deepEqual(obs.writers.B.owners, []);
    assert.equal(obs.daemon.pid, MANAGED_PID);
    assert.equal(obs.daemon.bootIdVerified, "MATCH");
    assert.equal(obs.daemon.startVerified, "MATCH");
  } finally {
    await server.close();
  }
});

test("collectPreflight: managed daemon as sole writer for B => OK", async () => {
  const { cfg, obs, server } = await collectFixture({
    lockOverrides: {
      B: Object.assign(
        () => {},
        { result: () => ({ status: 0, stdout: `p${MANAGED_PID}\n` }) },
      ),
    },
  });
  try {
    const decision = decidePreflight(cfg, obs);
    assert.equal(decision.ok, true, JSON.stringify(decision.blockReasons));
    assert.deepEqual(obs.writers.B.owners, [MANAGED_PID]);
  } finally {
    await server.close();
  }
});

test("collectPreflight: foreign single writer for A => BLOCK_WRITER_FOREIGN", async () => {
  const { cfg, obs, server } = await collectFixture({
    lockOverrides: {
      A: Object.assign(
        () => {},
        { result: () => ({ status: 0, stdout: "p999\n" }) },
      ),
    },
  });
  try {
    const decision = decidePreflight(cfg, obs);
    assert.equal(decision.ok, false);
    assert.equal(decision.code, "BLOCK_WRITER_FOREIGN");
  } finally {
    await server.close();
  }
});

test("collectPreflight: lsof lock failure => UNKNOWN severity", async () => {
  const { cfg, obs, server } = await collectFixture({
    lockOverrides: {
      A: Object.assign(
        () => {},
        { result: () => ({ status: 2, stdout: "", stderr: "lsof fatal" }) },
      ),
    },
  });
  try {
    const decision = decidePreflight(cfg, obs);
    assert.equal(decision.ok, false);
    assert.equal(decision.code, "BLOCK_WRITER_LOCK_UNKNOWN");
    assert.equal(decision.severity, GATE.UNKNOWN);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ *
 * P0-03: L2 machine gates
 * ------------------------------------------------------------------ */

test("L2 success: all machine gates proven => L2_MACHINE_PASS_USER_VISUAL_REQUIRED", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  assert.equal(decidePreflight(cfg, pre).ok, true);
  const decision = evaluatePostLaunch(cfg, pre, okPost(cfg, pre));
  assert.equal(decision.outcome, L2_PASS);
  assert.equal(decision.machinePass, true);
  assert.equal(decision.userVisualRequired, true);
  assert.match(decision.note, /NOT user-visible validation/);
});

test("L2: GUI absent / duplicate after open => FAIL", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const absent = okPost(cfg, pre);
  absent.gui = { state: PROBE.ABSENT, processes: [] };
  assert.equal(evaluatePostLaunch(cfg, pre, absent).outcome, L2_FAIL);
  const dup = okPost(cfg, pre);
  dup.gui = { state: PROBE.PRESENT, processes: [{ pid: 1 }, { pid: 2 }] };
  assert.equal(evaluatePostLaunch(cfg, pre, dup).outcome, L2_FAIL);
});

test("L2: wrong CODEX_APP_SERVER_WS_URL / unknown env => FAIL / INCOMPLETE", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const wrong = okPost(cfg, pre);
  wrong.guiEnv = { state: PROBE.PRESENT, pid: 777, present: true, value: "ws+unix://localhost/tmp/wrong.sock:/rpc" };
  const decision = evaluatePostLaunch(cfg, pre, wrong);
  assert.equal(decision.outcome, L2_FAIL);
  assert.ok(decision.failures.some((f) => f.code === "L2_GUI_ENV_MISMATCH"));

  const unknown = okPost(cfg, pre);
  unknown.guiEnv = { state: PROBE.UNKNOWN, reason: "ps eww failed" };
  assert.equal(evaluatePostLaunch(cfg, pre, unknown).outcome, L2_INCOMPLETE);

  const missing = okPost(cfg, pre);
  missing.guiEnv = { state: PROBE.PRESENT, pid: 777, present: false, value: null };
  assert.ok(evaluatePostLaunch(cfg, pre, missing).failures.some((f) => f.code === "L2_GUI_ENV_MISSING"));
});

test("L2: daemon PID/version/executable change => FAIL; uncheckable anchor => INCOMPLETE", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const changed = okPost(cfg, pre);
  changed.daemon.pid = 99999;
  const decision = evaluatePostLaunch(cfg, pre, changed);
  assert.equal(decision.outcome, L2_FAIL);
  assert.ok(decision.failures.some((f) => f.gate === "daemon_identity_unchanged"));

  const versionChanged = okPost(cfg, pre);
  versionChanged.daemon.version = "0.165.0-aarch64-apple-darwin";
  assert.equal(evaluatePostLaunch(cfg, pre, versionChanged).outcome, L2_FAIL);

  const unverified = okPost(cfg, pre);
  unverified.daemon.startVerified = "UNKNOWN";
  unverified.daemon.lstartText = null;
  const decisionUnknown = evaluatePostLaunch(cfg, pre, unverified);
  assert.equal(decisionUnknown.outcome, L2_INCOMPLETE);
});

test("L2: second managed daemon or new app-server => FAIL", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const second = okPost(cfg, pre);
  second.managedDaemons = {
    state: PROBE.PRESENT,
    list: [
      { pid: MANAGED_PID },
      { pid: 424242 },
    ],
  };
  assert.equal(evaluatePostLaunch(cfg, pre, second).outcome, L2_FAIL);

  const newServer = okPost(cfg, pre);
  newServer.appServer = { state: PROBE.PRESENT, pids: [MANAGED_PID, 424242] };
  const decision = evaluatePostLaunch(cfg, pre, newServer);
  assert.equal(decision.outcome, L2_FAIL);
  assert.ok(decision.failures.some((f) => f.gate === "no_new_daemon"));
});

test("L2: foreign/multi/unknown writer after launch => FAIL / INCOMPLETE", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const foreign = okPost(cfg, pre);
  foreign.writers.B = { state: PROBE.PRESENT, owners: [999], unsafe: false, managedPid: MANAGED_PID };
  assert.equal(evaluatePostLaunch(cfg, pre, foreign).outcome, L2_FAIL);

  const multi = okPost(cfg, pre);
  multi.writers.A = { state: PROBE.PRESENT, owners: [MANAGED_PID, 42], unsafe: false, managedPid: MANAGED_PID };
  assert.equal(evaluatePostLaunch(cfg, pre, multi).outcome, L2_FAIL);

  const unknown = okPost(cfg, pre);
  unknown.writers.A = { state: PROBE.UNKNOWN, owners: [], reason: "lsof failed", managedPid: MANAGED_PID };
  assert.equal(evaluatePostLaunch(cfg, pre, unknown).outcome, L2_INCOMPLETE);
});

test("L2: A/B thread metadata mismatch => FAIL; B must be idle; A may be notLoaded", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);

  const badId = okPost(cfg, pre);
  badId.threads.threads.A = { ...badId.threads.threads.A, threadId: "other", matches: { id: false, cwd: true } };
  assert.equal(evaluatePostLaunch(cfg, pre, badId).outcome, L2_FAIL);

  const badCwd = okPost(cfg, pre);
  badCwd.threads.threads.B = { ...badCwd.threads.threads.B, cwd: "/tmp/elsewhere", matches: { id: true, cwd: false } };
  assert.equal(evaluatePostLaunch(cfg, pre, badCwd).outcome, L2_FAIL);

  const bActive = okPost(cfg, pre);
  bActive.threads.threads.B = { ...bActive.threads.threads.B, status: "active" };
  const decision = evaluatePostLaunch(cfg, pre, bActive);
  assert.equal(decision.outcome, L2_FAIL);
  assert.ok(decision.failures.some((f) => f.gate === "thread_b_metadata"));

  const aNotLoaded = okPost(cfg, pre);
  aNotLoaded.threads.threads.A = { ...aNotLoaded.threads.threads.A, status: "notLoaded" };
  assert.equal(evaluatePostLaunch(cfg, pre, aNotLoaded).outcome, L2_PASS);
});

/* ------------------------------------------------------------------ *
 * DORMANT_RECOVERABLE (reviewer ruling ONEPASS-003-REVIEW-663d19b #2)
 * ------------------------------------------------------------------ */

function writeNativeRollout(sessionsDir, threadId, spec = {}) {
  const {
    cwd = DEFAULT_THREADS.B.cwd,
    source = "vscode",
    id = threadId,
    started = 3,
    completed = 3,
    trailingUser = false,
    corrupt = false,
    omitMeta = false,
  } = spec;
  const dir = join(sessionsDir, "2026", "10", "24");
  mkdirSync(dir, { recursive: true });
  const lines = [];
  if (!omitMeta)
    lines.push(JSON.stringify({ timestamp: "2026-10-24T08:13:11.857Z", type: "session_meta", payload: { id, cwd, source } }));
  for (let i = 0; i < started; i++)
    lines.push(JSON.stringify({ timestamp: `2026-10-24T08:${10 + i}:00.000Z`, type: "event_msg", payload: { type: "task_started" } }));
  for (let i = 0; i < completed; i++)
    lines.push(JSON.stringify({ timestamp: `2026-10-24T08:${20 + i}:00.000Z`, type: "event_msg", payload: { type: "task_complete" } }));
  if (trailingUser)
    lines.push(JSON.stringify({ timestamp: "2026-10-24T09:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [] } }));
  if (corrupt) lines.push("{not-json");
  const path = join(dir, `rollout-2026-10-24T08-13-11-${threadId}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("probeNativeRolloutLedger: complete 3x start/complete ledger => PRESENT + complete + identity", () => {
  const sessionsDir = mkdtempSync(join("/tmp", "onepass003-sessions-"));
  try {
    const threadId = DEFAULT_THREADS.B.id;
    writeNativeRollout(sessionsDir, threadId);
    const cfg = defaultConfig({ sessionsDir, threads: DEFAULT_THREADS });
    const probe = probeNativeRolloutLedger(cfg, "B");
    assert.equal(probe.state, PROBE.PRESENT);
    assert.equal(probe.ledger.started, 3);
    assert.equal(probe.ledger.completed, 3);
    assert.equal(probe.ledger.lastType, "task_complete");
    assert.equal(probe.ledger.complete, true);
    assert.deepEqual(probe.matches, { id: true, cwd: true, source: true });
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("probeNativeRolloutLedger: missing => ABSENT; corrupt => UNKNOWN; partial => incomplete", () => {
  const sessionsDir = mkdtempSync(join("/tmp", "onepass003-sessions-"));
  try {
    const threadId = DEFAULT_THREADS.B.id;
    const cfg = defaultConfig({ sessionsDir, threads: DEFAULT_THREADS });
    assert.equal(probeNativeRolloutLedger(cfg, "B").state, PROBE.ABSENT);

    writeNativeRollout(sessionsDir, threadId, { corrupt: true });
    assert.equal(probeNativeRolloutLedger(cfg, "B").state, PROBE.UNKNOWN);
    rmSync(sessionsDir, { recursive: true, force: true });
    mkdirSync(sessionsDir, { recursive: true });

    writeNativeRollout(sessionsDir, threadId, { started: 3, completed: 2 });
    const partial = probeNativeRolloutLedger(cfg, "B");
    assert.equal(partial.state, PROBE.PRESENT);
    assert.equal(partial.ledger.complete, false);

    rmSync(sessionsDir, { recursive: true, force: true });
    mkdirSync(sessionsDir, { recursive: true });
    writeNativeRollout(sessionsDir, threadId, { trailingUser: true });
    const trailing = probeNativeRolloutLedger(cfg, "B");
    assert.equal(trailing.ledger.complete, false);
    assert.equal(trailing.ledger.trailingUserAfterComplete, true);

    rmSync(sessionsDir, { recursive: true, force: true });
    mkdirSync(sessionsDir, { recursive: true });
    writeNativeRollout(sessionsDir, threadId, { omitMeta: true });
    const noMeta = probeNativeRolloutLedger(cfg, "B");
    assert.equal(noMeta.state, PROBE.PRESENT);
    assert.equal(noMeta.ledger.complete, true);
    assert.equal(noMeta.matches.id, false);
    assert.equal(noMeta.matches.cwd, false);
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("L2 B notLoaded + zero writers + complete ledger => DORMANT_RECOVERABLE PASS", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const post = okPost(cfg, pre);
  post.threads.threads.B = { ...post.threads.threads.B, status: "notLoaded" };
  post.writers.B = { state: PROBE.PRESENT, owners: [], unsafe: false, managedPid: MANAGED_PID };
  post.nativeLedger = {
    state: PROBE.PRESENT,
    matches: { id: true, cwd: true, source: true },
    ledger: { started: 3, completed: 3, lastType: "task_complete", trailingUserAfterComplete: false, complete: true },
    complete: true,
  };
  const decision = evaluatePostLaunch(cfg, pre, post);
  assert.equal(decision.outcome, L2_PASS, JSON.stringify(decision.failures));
  assert.equal(decision.threadClassifications.B.classification, "DORMANT_RECOVERABLE");
  assert.equal(decision.threadClassifications.B.ledger.started, 3);
  assert.equal(decision.gates.thread_b_metadata, GATE.PASS);
});

test("L2 dormant B: writer / ledger / identity / unknown variants all block", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const baseDormant = () => {
    const post = okPost(cfg, pre);
    post.threads.threads.B = { ...post.threads.threads.B, status: "notLoaded" };
    post.writers.B = { state: PROBE.PRESENT, owners: [], unsafe: false, managedPid: MANAGED_PID };
    post.nativeLedger = {
      state: PROBE.PRESENT,
      matches: { id: true, cwd: true, source: true },
      ledger: { started: 3, completed: 3, lastType: "task_complete", trailingUserAfterComplete: false, complete: true },
      complete: true,
    };
    return post;
  };

  const writerHeld = baseDormant();
  writerHeld.writers.B = { state: PROBE.PRESENT, owners: [MANAGED_PID], unsafe: false, managedPid: MANAGED_PID };
  let d = evaluatePostLaunch(cfg, pre, writerHeld);
  assert.equal(d.outcome, L2_FAIL);
  assert.ok(d.failures.some((f) => f.code === "L2_THREAD_NOT_DORMANT_WRITER"));

  const noLockFile = baseDormant();
  noLockFile.writers.B = { state: PROBE.ABSENT, owners: [], unsafe: false, managedPid: MANAGED_PID };
  d = evaluatePostLaunch(cfg, pre, noLockFile);
  assert.equal(d.outcome, L2_PASS, JSON.stringify(d.failures));
  assert.equal(d.threadClassifications.B.classification, "DORMANT_RECOVERABLE");

  const incomplete = baseDormant();
  incomplete.nativeLedger.ledger = { started: 3, completed: 2, lastType: "task_started", trailingUserAfterComplete: false, complete: false };
  d = evaluatePostLaunch(cfg, pre, incomplete);
  assert.equal(d.outcome, L2_FAIL);
  assert.ok(d.failures.some((f) => f.code === "L2_THREAD_DORMANT_LEDGER_INCOMPLETE"));

  const badIdentity = baseDormant();
  badIdentity.nativeLedger.matches = { id: true, cwd: false, source: true };
  d = evaluatePostLaunch(cfg, pre, badIdentity);
  assert.equal(d.outcome, L2_FAIL);
  assert.ok(d.failures.some((f) => f.code === "L2_THREAD_DORMANT_IDENTITY"));

  const missing = baseDormant();
  missing.nativeLedger = { state: PROBE.ABSENT, reason: "no rollout" };
  d = evaluatePostLaunch(cfg, pre, missing);
  assert.equal(d.outcome, L2_FAIL);
  assert.ok(d.failures.some((f) => f.code === "L2_THREAD_DORMANT_HISTORY_MISSING"));

  const unknown = baseDormant();
  unknown.nativeLedger = { state: PROBE.UNKNOWN, reason: "scan failed" };
  d = evaluatePostLaunch(cfg, pre, unknown);
  assert.equal(d.outcome, L2_INCOMPLETE);
  assert.ok(d.unknowns.some((f) => f.code === "L2_THREAD_DORMANT_UNKNOWN"));

  const noProbe = baseDormant();
  delete noProbe.nativeLedger;
  d = evaluatePostLaunch(cfg, pre, noProbe);
  assert.equal(d.outcome, L2_INCOMPLETE);
});

test("L2 idle B stays IDLE classification (dormant path not required)", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const decision = evaluatePostLaunch(cfg, pre, okPost(cfg, pre));
  assert.equal(decision.threadClassifications.B.classification, "IDLE");
});


test("L2: uncheckable DevSpace tool surface => INCOMPLETE, never PASS (default side-effect-free policy)", async () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const post = okPost(cfg, pre);
  delete post.toolSurface; // no probe result at all => unknown
  assert.equal(evaluatePostLaunch(cfg, pre, post).outcome, L2_INCOMPLETE);

  const toolProbe = await probeToolSurface(cfg, {});
  assert.equal(toolProbe.state, PROBE.UNKNOWN);
  assert.match(toolProbe.reason, /verify-live-mcp-tools\.cjs/);
  const withDefault = evaluatePostLaunch(cfg, pre, { ...okPost(cfg, pre), toolSurface: toolProbe });
  assert.equal(withDefault.outcome, L2_INCOMPLETE);

  const drifted = okPost(cfg, pre);
  drifted.toolSurface = { state: PROBE.PRESENT, ok: false, reason: "tool count 95 != 96" };
  assert.equal(evaluatePostLaunch(cfg, pre, drifted).outcome, L2_FAIL);
});

/* ------------------------------------------------------------------ *
 * P1-04: freshness + exactly one open
 * ------------------------------------------------------------------ */

function launchDeps({ cfg, preflightSequence, post, open, collectPost }) {
  let index = 0;
  return {
    config: cfg,
    collectPreflight: async () => preflightSequence[Math.min(index++, preflightSequence.length - 1)],
    collectPostLaunch: collectPost ?? (async (c, pre) => post(c, pre)),
    open,
  };
}

test("P1-04 success path: preflight rechecked, exactly ONE open call", async () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  let openCalls = 0;
  const deps = launchDeps({
    cfg,
    preflightSequence: [pre, pre],
    post: okPost,
    open: async ({ app, url }) => {
      openCalls++;
      assert.equal(app, cfg.appPath);
      assert.equal(url, cfg.expectedUrl);
      return { status: 0 };
    },
  });
  const result = await runLaunch(deps);
  assert.equal(openCalls, 1);
  assert.equal(result.openCalls, 1);
  assert.equal(result.phase, "l2");
  assert.equal(result.decision.outcome, L2_PASS);
});

test("P1-04 drift between the two preflights => fail closed, ZERO opens", async () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  const drifted = JSON.parse(JSON.stringify(pre));
  drifted.daemon.pid = 77777;
  drifted.writers.B = { state: PROBE.PRESENT, owners: [77777], unsafe: false, managedPid: 77777 };
  let openCalls = 0;
  const result = await runLaunch({
    config: cfg,
    collectPreflight: (() => {
      const seq = [pre, drifted];
      let i = 0;
      return async () => seq[Math.min(i++, seq.length - 1)];
    })(),
    open: async () => {
      openCalls++;
      return { status: 0 };
    },
  });
  assert.equal(openCalls, 0);
  assert.equal(result.openCalls, 0);
  assert.equal(result.code, "BLOCK_PREFLIGHT_DRIFT");
  assert.equal(result.phase, "preflight_freshness");
  assert.ok(result.drift.length > 0);
});

test("P1-04 blocked preflight => ZERO opens (GUI present)", async () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  pre.gui = { state: PROBE.PRESENT, processes: [{ pid: 10, identity: "kernel_comm" }] };
  let openCalls = 0;
  const result = await runLaunch({
    config: cfg,
    collectPreflight: async () => pre,
    open: async () => {
      openCalls++;
      return { status: 0 };
    },
  });
  assert.equal(openCalls, 0);
  assert.equal(result.decision.code, "BLOCK_GUI_ALREADY_RUNNING");
});

test("P1-04 open failure => one attempt, no retry, no kill", async () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  let openCalls = 0;
  const result = await runLaunch({
    config: cfg,
    collectPreflight: async () => pre,
    open: async () => {
      openCalls++;
      return { status: 1, error: new Error("open failed"), stderr: "boom" };
    },
  });
  assert.equal(openCalls, 1);
  assert.equal(result.openCalls, 1);
  assert.equal(result.code, "APP_SHARED_LAUNCH_FAILED");
});

test("P1-04 partial GUI count after open => L2 FAIL, never a second open", async () => {
  const { cfg, daemonRealpath } = makeFixture();
  const pre = okObs(cfg, daemonRealpath);
  let openCalls = 0;
  const result = await runLaunch({
    config: cfg,
    collectPreflight: async () => pre,
    open: async () => {
      openCalls++;
      return { status: 0 };
    },
    collectPostLaunch: async (c, p) => {
      const post = okPost(c, p);
      post.gui = { state: PROBE.PRESENT, processes: [{ pid: 1 }, { pid: 2 }] };
      return post;
    },
  });
  assert.equal(openCalls, 1);
  assert.equal(result.decision.outcome, L2_FAIL);
});

/* ------------------------------------------------------------------ *
 * --check reporting + source guards
 * ------------------------------------------------------------------ */

test("--check report: launchPermitted true for a clean fixture; stable JSON keys", async () => {
  const { cfg, obs, server } = await collectFixture();
  try {
    const decision = decidePreflight(cfg, obs);
    const report = checkReport(cfg, obs, decision);
    assert.equal(report.action, "--check");
    assert.equal(report.launchPermitted, true);
    assert.equal(report.ok, true);
    assert.equal(report.code, "LAUNCH_PREFLIGHT_OK");
    assert.deepEqual(report.gui, []);
    assert.deepEqual(report.writers.A, []);
    assert.deepEqual(report.writers.B, []);
    assert.equal(report.daemon.ok, true);
    assert.equal(report.sock.ok, true);
    assert.equal(report.expectedUrl, cfg.expectedUrl);
    assert.equal(typeof report.generatedAt, "string");
    JSON.parse(JSON.stringify(report)); // must be serializable as one JSON line
  } finally {
    await server.close();
  }
});

test("library/CLI source guards: L2 never requests includeTurns:true; one open site only", () => {
  const lib = readFileSync(LIB_PATH, "utf8");
  const cli = readFileSync(CLI_PATH, "utf8");
  assert.doesNotMatch(lib, /includeTurns\s*:\s*true/);
  assert.match(lib, /includeTurns: false/);
  assert.doesNotMatch(cli, /includeTurns/);
  // The only open invocation is the single defaultOpen site in the library.
  const openSites = lib.match(/\/usr\/bin\/open/g) ?? [];
  assert.equal(openSites.length, 1);
  assert.doesNotMatch(cli, /\/usr\/bin\/open/);
  // No destructive process control in the verifier.
  assert.doesNotMatch(lib, /process\.kill|SIGKILL|SIGTERM/);
  assert.doesNotMatch(lib, /unlinkSync|rmSync|renameSync/);
  // Pin expectations are explicit.
  assert.equal(EXPECTED_MCP_TOOL_COUNT, 96);
  assert.deepEqual(
    [...EXPECTED_CODEX_APP_TOOLS].sort(),
    [
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
    ],
  );
});

test("runCheck is read-only (no open call path) and returns decision", async () => {
  const { cfg, obs, server } = await collectFixture();
  try {
    const result = await runCheck({ config: cfg, collectPreflight: async () => obs });
    assert.equal(result.action, "--check");
    assert.equal(result.decision.ok, true);
  } finally {
    await server.close();
  }
});

test("fingerprint diff is stable for identical observations and detects changes", () => {
  const { cfg, daemonRealpath } = makeFixture();
  const a = okObs(cfg, daemonRealpath);
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(preflightFingerprint(a).gui.state, preflightFingerprint(b).gui.state);
  assert.deepEqual(preflightFingerprint(a), preflightFingerprint(b));
  b.daemon.pid = 1;
  const result = { same: JSON.stringify(preflightFingerprint(a)) === JSON.stringify(preflightFingerprint(b)) };
  assert.equal(result.same, false);
});

test("default threads pin A/B ids and worktree cwds", () => {
  assert.deepEqual(Object.keys(DEFAULT_THREADS), ["A", "B"]);
  assert.equal(DEFAULT_THREADS.A.id, "01a16cef-0e26-7660-99f9-03caac52cfdf");
  assert.equal(DEFAULT_THREADS.A.cwd, "/Users/liz/.devspace/worktrees/devspace-3352a613");
  assert.equal(DEFAULT_THREADS.B.id, "01a16cf8-9102-7102-8fc9-9b925b1f1a21");
  assert.equal(DEFAULT_THREADS.B.cwd, "/Users/liz/.devspace/worktrees/TriaRegna-c3207114");
});

/* Keep probeThreads imported/used so its no-includeTurns contract is covered by
 * the source guard, and assert it degrades to UNKNOWN without a socket. */
test("probeThreads degrades to UNKNOWN when no socket exists (no writes)", async () => {
  const { cfg } = makeFixture();
  const threads = await probeThreads(cfg);
  assert.equal(threads.state, PROBE.UNKNOWN);
});
