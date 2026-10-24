#!/usr/bin/env node
/**
 * Falsifiable, fail-closed launch check for the ChatGPT desktop App on the
 * *existing* managed Codex app-server daemon.
 *
 * Design constraints (AUTONOMY-002):
 * - Never quit/restart/kill an App or daemon.
 * - Never launch when a trusted GUI main process is already running.
 * - Never accept command-line substring matches as "App is running"; require
 *   kernel-provided executable identity (ps comm) for the GUI main binary.
 * - "Launch" = /usr/bin/open -a ChatGPT.app --env CODEX_APP_SERVER_WS_URL=...
 *   exactly like scripts/launch-chatgpt-shared-codex.mjs; session-scoped env.
 * - Post-launch proof: trusted GUI process exists, its env var points to the
 *   same socket, WS upgrade still returns 101, and thread-writer locks did not
 *   gain a second holder (single writer preserved).
 *
 * Usage:
 *   node scripts/verify-chatgpt-shared-launch.mjs --check   # preflight only
 *   node scripts/verify-chatgpt-shared-launch.mjs --launch  # preflight + open + verify
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";

const SOCKET = join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
const APP = "/Applications/ChatGPT.app";
const MAIN_BIN = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const THREADS = [
  "01a16cef-0e26-7660-99f9-03caac52cfdf",
  "01a16cf8-9102-7102-8fc9-9b925b1f1a21",
];
const EXPECTED_URL = "ws+unix://localhost" + SOCKET + ":/rpc";

function psLines(args) {
  const r = spawnSync("/bin/ps", args, { encoding: "utf8", timeout: 5000, maxBuffer: 4_000_000 });
  return r.status === 0 ? (r.stdout || "").split("\n").filter(Boolean) : [];
}

/** Trusted GUI identity: comm must be the main binary; argv fallback only when
 * argv[0] is exactly that binary and the process is not a --type= helper. */
function guiProcesses() {
  const out = [];
  for (const line of psLines(["-axo", "pid=,comm=,command="])) {
    const t = line.trim();
    const m = /^(\d+)\s+(\S+)\s+(.*)$/.exec(t);
    if (!m) continue;
    const [, pid, comm, command] = m;
    if (comm === MAIN_BIN) { out.push({ pid: Number(pid), command }); continue; }
    const argv0 = command.split(/\s+/)[0];
    if (argv0 === MAIN_BIN && !/--type=/.test(command)) out.push({ pid: Number(pid), command });
  }
  return out;
}

function socketCheck(path) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const alias = lstatSync(path);
      if (alias.uid !== process.getuid?.()) return done({ ok: false, reason: "socket uid mismatch" });
      if (alias.isSymbolicLink()) {
        const real = realpathSync(path);
        const folder = dirname(real);
        if (!folder.startsWith("/private/tmp/codex-daemon-") || !/^[a-f0-9]{64}$/.test(basename(real)))
          return done({ ok: false, reason: "socket alias target not canonical" });
        const parent = statSync(folder);
        if (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
          return done({ ok: false, reason: "socket parent not owner-only" });
      }
      const target = statSync(path);
      if (!target.isSocket() || target.uid !== process.getuid?.() || (target.mode & 0o077) !== 0)
        return done({ ok: false, reason: "target not an owner-only socket" });
    } catch (e) {
      return done({ ok: false, reason: "socket path error: " + (e?.code || e?.message) });
    }
    const s = connect(path);
    let buf = "";
    const timer = setTimeout(() => { try { s.destroy(); } catch {} done({ ok: false, reason: "handshake timeout" }); }, 5000);
    s.on("connect", () => {
      const key = randomBytes(16).toString("base64");
      s.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    s.on("data", (c) => {
      buf += c.toString("utf8");
      if (buf.includes("\r\n")) {
        clearTimeout(timer);
        const head = buf.split("\r\n")[0];
        const ok = / 101 /.test(head);
        try { s.destroy(); } catch {}
        done({ ok, reason: ok ? "101" : head });
      }
    });
    s.on("error", (e) => { clearTimeout(timer); done({ ok: false, reason: "connect error: " + e.message }); });
  });
}


function daemonInfo() {
  const r = spawnSync(process.execPath, [join(homedir(), ".local/bin/codex"), "app-server", "daemon", "version"],
    { encoding: "utf8", timeout: 20000 });
  if (r.status !== 0) return { ok: false, reason: "daemon version command failed" };
  try {
    const j = JSON.parse(r.stdout.trim().split("\n").pop());
    return { ok: j.status === "running" && j.socketPath === SOCKET, info: j };
  } catch { return { ok: false, reason: "daemon version not JSON" }; }
}

function writerHolders(threadId) {
  const path = join(homedir(), ".codex", "thread-writer-locks", threadId + ".lock");
  if (!existsSync(path)) return [];
  const r = spawnSync("/usr/sbin/lsof", [path], { encoding: "utf8", timeout: 8000 });
  const pids = new Set();
  if (r.status === 0) {
    for (const line of (r.stdout || "").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 1 && /^\d+$/.test(cols[1])) pids.add(Number(cols[1]));
    }
  }
  return [...pids];
}

async function preflight() {
  const gui = guiProcesses();
  const sock = await socketCheck(SOCKET);
  const daemon = daemonInfo();
  const writers = Object.fromEntries(THREADS.map((t) => [t, writerHolders(t)]));
  const secondWriter = Object.values(writers).some((pids) => pids.length > 1);
  const ok = gui.length === 0 && sock.ok && daemon.ok && !secondWriter;
  return { ok, gui, sock, daemon, writers, secondWriter, expectedUrl: EXPECTED_URL };
}

function appEnvForPid(pid) {
  const r = spawnSync("/bin/ps", ["eww", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  const m = /(?:^|\s)CODEX_APP_SERVER_WS_URL=(\S+)/.exec(r.stdout || "");
  return m ? m[1] : null;
}

async function launch() {
  const pre = await preflight();
  console.log(JSON.stringify({ action: "--launch", preflight: { gui: pre.gui, sock: pre.sock, daemonOk: pre.daemon.ok, writers: pre.writers } }));
  if (!pre.ok) { console.error("BLOCKED_PREFLIGHT: " + JSON.stringify(pre)); process.exit(3); }
  if (pre.gui.length) { console.error("BLOCKED: GUI already running; never restart"); process.exit(4); }
  const open = spawnSync("/usr/bin/open", ["-a", APP, "--env", "CODEX_APP_SERVER_WS_URL=" + EXPECTED_URL],
    { encoding: "utf8", timeout: 15000 });
  if (open.status !== 0) { console.error("APP_SHARED_LAUNCH_FAILED"); process.exit(5); }
  let gui = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    gui = guiProcesses();
    if (gui.length) break;
  }
  if (gui.length !== 1) { console.error("VERIFY_FAIL: expected exactly one trusted GUI, got " + JSON.stringify(gui)); process.exit(6); }
  const env = appEnvForPid(gui[0].pid);
  const envOk = env === EXPECTED_URL;
  const sock2 = await socketCheck(SOCKET);
  const writers2 = Object.fromEntries(THREADS.map((t) => [t, writerHolders(t)]));
  const secondWriter2 = Object.values(writers2).some((pids) => pids.length > 1);
  const pass = envOk && sock2.ok && !secondWriter2;
  console.log(JSON.stringify({ action: "verify", pid: gui[0].pid, envOk, handshake: sock2.reason, writers: writers2, secondWriter: secondWriter2, pass }));
  process.exit(pass ? 0 : 7);
}

const action = process.argv[2] ?? "--check";
if (action === "--check") {
  const pre = await preflight();
  console.log(JSON.stringify({ action, appFound: existsSync(APP), gui: pre.gui, sock: pre.sock,
    daemon: pre.daemon, writers: pre.writers, expectedUrl: EXPECTED_URL, ok: pre.ok }));
  process.exit(pre.ok ? 0 : 2);
} else if (action === "--launch") {
  await launch();
} else {
  console.error("Usage: node scripts/verify-chatgpt-shared-launch.mjs [--check|--launch]"); process.exit(1);
}
