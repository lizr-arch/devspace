#!/bin/bash
# Deterministic tests for scripts/ops/devspace-tunnel-watchdog.sh.
#
# Runs the watchdog against local stub HTTP endpoints, fixture monitor JSON and
# shimmed launchctl/osascript binaries. No real tunnel, notification or launchd
# action is touched.
#
# Usage: bash scripts/ops/devspace-tunnel-watchdog.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WATCHDOG="$SCRIPT_DIR/devspace-tunnel-watchdog.sh"
[ -f "$WATCHDOG" ] || {
  echo "missing watchdog: $WATCHDOG" >&2
  exit 1
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/devspace-watchdog-test.XXXXXX")
LOCAL_PID=""
PUBLIC_PID=""

cleanup() {
  [ -n "$LOCAL_PID" ] && kill "$LOCAL_PID" 2>/dev/null || true
  [ -n "$PUBLIC_PID" ] && kill "$PUBLIC_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- watchdog log (last 40) ---" >&2
  tail -n 40 "$TMP"/*/watchdog.log 2>/dev/null >&2 || true
  exit 1
}

assert_contains() { # file needle label
  grep -q -- "$2" "$1" 2>/dev/null || fail "$3: '$2' not found in $1"
}
assert_not_contains() {
  ! grep -q -- "$2" "$1" 2>/dev/null || fail "$3: '$2' unexpectedly found in $1"
}

# --- shims -------------------------------------------------------------------
mkdir -p "$TMP/bin"
cat >"$TMP/bin/launchctl" <<'SHIM'
#!/bin/bash
printf '%s\n' "$*" >>"$SHIM_LOG/launchctl.log"
exit 0
SHIM
cat >"$TMP/bin/osascript" <<'SHIM'
#!/bin/bash
printf '%s\n' "$*" >>"$SHIM_LOG/osascript.log"
exit 0
SHIM
chmod 0755 "$TMP/bin/launchctl" "$TMP/bin/osascript"
export SHIM_LOG="$TMP"
export PATH="$TMP/bin:$PATH"

# --- stub HTTP servers -------------------------------------------------------
free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
LOCAL_PORT=$(free_port)
PUBLIC_PORT=$(free_port)
[ -n "$LOCAL_PORT" ] && [ -n "$PUBLIC_PORT" ] || fail "could not allocate ports"

cat >"$TMP/serve.py" <<'PY'
import http.server
import pathlib
import sys

port = int(sys.argv[1])
status_file = pathlib.Path(sys.argv[2])

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            code = int(status_file.read_text().strip() or "200")
        except Exception:
            code = 500
        if not 100 <= code <= 599:
            code = 500
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args):
        pass

http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY

echo 200 >"$TMP/local_status"
echo 200 >"$TMP/public_status"
python3 "$TMP/serve.py" "$LOCAL_PORT" "$TMP/local_status" &
LOCAL_PID=$!
python3 "$TMP/serve.py" "$PUBLIC_PORT" "$TMP/public_status" &
PUBLIC_PID=$!

wait_for_port() {
  local port="$1" i
  for i in $(seq 1 60); do
    if curl -s -o /dev/null -m 1 --noproxy '*' "http://127.0.0.1:$port/healthz"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}
wait_for_port "$LOCAL_PORT" || fail "local stub server did not start"
wait_for_port "$PUBLIC_PORT" || fail "public stub server did not start"

# --- fixtures ----------------------------------------------------------------
cat >"$TMP/monitor-healthy.json" <<'JSON'
{"eventLoop":{"maxMs":42,"p95Ms":11},"system":{"cpuCount":10,"loadAverage":{"one":1.2,"five":1.0,"fifteen":0.9},"swapUsedPercent":12.5,"memoryAvailableMiB":4096}}
JSON
cat >"$TMP/monitor-saturated.json" <<'JSON'
{"eventLoop":{"maxMs":27950.8,"p95Ms":430,"p76Ms":120},"system":{"cpuCount":10,"loadAverage":{"one":25.5,"five":22.0,"fifteen":20.0},"swapUsedPercent":88.4,"memoryAvailableMiB":220}}
JSON
# p76Ms is ignored by the parser on purpose (forward compatibility noise).

new_state_dir() {
  local dir="$TMP/$1"
  mkdir -p "$dir"
  rm -f "$TMP/launchctl.log" "$TMP/osascript.log"
  printf '%s' "$dir"
}

run_watchdog() { # state_dir monitor_fixture [extra env assignments...]
  local state_dir="$1" fixture="$2"
  shift 2
  env \
    DEVSPACE_WATCHDOG_STATE_DIR="$state_dir" \
    DEVSPACE_WATCHDOG_LOCAL_URL="$LOCAL_URL" \
    DEVSPACE_WATCHDOG_PUBLIC_URL="$PUBLIC_URL" \
    DEVSPACE_WATCHDOG_MONITOR_URL="http://127.0.0.1:1/monitor/api" \
    DEVSPACE_WATCHDOG_FIXTURE_MONITOR_JSON="$fixture" \
    DEVSPACE_WATCHDOG_LOG_ROTATE=0 \
    DEVSPACE_WATCHDOG_PROC_OVERRIDE=1 \
    "$@" \
    bash "$WATCHDOG" --once
}

LOCAL_URL="http://127.0.0.1:$LOCAL_PORT/healthz"
PUBLIC_URL="http://127.0.0.1:$PUBLIC_PORT/healthz"
DEAD_URL="http://127.0.0.1:1/healthz"

# --- 1. healthy --------------------------------------------------------------
STATE=$(new_state_dir s1-healthy)
OUT=$(run_watchdog "$STATE" "$TMP/monitor-healthy.json") || fail "healthy run exited non-zero"
case "$OUT" in
*'"tunnelStatus":"healthy"'*) ;;
*) fail "healthy tunnel expected, got: $OUT" ;;
esac
case "$OUT" in
*'"hostStatus":"ok"'*) ;;
*) fail "healthy host expected, got: $OUT" ;;
esac
assert_contains "$STATE/watchdog.log" "OK local http=200, public http=200" "healthy log"
[ -f "$TMP/launchctl.log" ] && fail "healthy run must not call launchctl"
[ -f "$TMP/osascript.log" ] && fail "healthy run must not notify"

# --- 2. local devspace down --------------------------------------------------
STATE=$(new_state_dir s2-local-down)
OUT=$(run_watchdog "$STATE" "$TMP/monitor-healthy.json" \
  DEVSPACE_WATCHDOG_LOCAL_URL="$DEAD_URL") || fail "local-down run exited non-zero"
case "$OUT" in
*'"tunnelStatus":"local_down"'*) ;;
*) fail "local_down expected, got: $OUT" ;;
esac
assert_contains "$STATE/watchdog.log" "ALERT status=local_down" "local-down alert"
assert_not_contains "$STATE/watchdog.log" "AUTORESTART" "local-down must not restart tunnel"
[ -f "$TMP/launchctl.log" ] && fail "local_down must not call launchctl"

# --- 3. public 502 with AUTORESTART off -> alert only ------------------------
STATE=$(new_state_dir s3-tunnel-down)
echo 502 >"$TMP/public_status"
OUT=$(run_watchdog "$STATE" "$TMP/monitor-healthy.json" \
  AUTORESTART=0) || fail "tunnel-down run exited non-zero"
case "$OUT" in
*'"tunnelStatus":"tunnel_down"'*) ;;
*) fail "tunnel_down expected, got: $OUT" ;;
esac
assert_contains "$STATE/watchdog.log" "ALERT status=tunnel_down" "tunnel-down alert"
[ -f "$TMP/launchctl.log" ] && fail "AUTORESTART=0 must not call launchctl"

# --- 4. public 502 with AUTORESTART on -> kickstart --------------------------
STATE=$(new_state_dir s4-autorestart)
OUT=$(run_watchdog "$STATE" "$TMP/monitor-healthy.json" \
  AUTORESTART=1 AUTORESTART_AFTER=1 RESTART_COOLDOWN=0) || fail "autorestart run exited non-zero"
case "$OUT" in
*'"tunnelStatus":"tunnel_down"'*) ;;
*) fail "tunnel_down expected, got: $OUT" ;;
esac
[ -f "$TMP/launchctl.log" ] || fail "AUTORESTART=1 should call launchctl"
assert_contains "$TMP/launchctl.log" "kickstart -k" "autorestart kickstart"
assert_contains "$STATE/watchdog.log" "AUTORESTART kickstart issued" "autorestart receipt"
assert_contains "$STATE/watchdog.log" "consecutive=1" "autorestart consecutive count"

# --- 5. watchdog.conf is honoured without env overrides ---------------------
STATE=$(new_state_dir s5-conf)
cat >"$STATE/watchdog.conf" <<'CONF'
AUTORESTART=1
AUTORESTART_AFTER=1
RESTART_COOLDOWN=0
CONF
rm -f "$TMP/launchctl.log"
OUT=$(run_watchdog "$STATE" "$TMP/monitor-healthy.json") || fail "conf run exited non-zero"
[ -f "$TMP/launchctl.log" ] || fail "watchdog.conf AUTORESTART=1 should call launchctl"

# --- 6. host saturation + memory pressure -----------------------------------
STATE=$(new_state_dir s6-host-saturated)
echo 200 >"$TMP/public_status"
rm -f "$TMP/launchctl.log" "$TMP/osascript.log"
OUT=$(run_watchdog "$STATE" "$TMP/monitor-saturated.json" \
  HOST_SATURATED_AFTER=1 MEMORY_PRESSURE_AFTER=1) || fail "saturated run exited non-zero"
case "$OUT" in
*'"hostStatus":"host_saturated"'*) ;;
*) fail "host_saturated expected, got: $OUT" ;;
esac
case "$OUT" in
*'"memoryStatus":"memory_pressure"'*) ;;
*) fail "memory_pressure expected, got: $OUT" ;;
esac
assert_contains "$STATE/watchdog.log" "ALERT dimension=host" "host alert"
assert_contains "$STATE/watchdog.log" "eventLoopMaxMs=27950.8" "host alert reason"
assert_contains "$STATE/watchdog.log" "ALERT dimension=memory" "memory alert"
[ -f "$TMP/osascript.log" ] || fail "host saturation should notify"
[ -f "$TMP/launchctl.log" ] && fail "host saturation must not restart cloudflared"
[ -f "$STATE/watchdog-host.jsonl" ] || fail "host sample history missing"
assert_contains "$STATE/watchdog-host.jsonl" '"eventLoopMaxMs":27950.8' "host sample"

# --- 7. recovery -------------------------------------------------------------
OUT=$(run_watchdog "$STATE" "$TMP/monitor-healthy.json" \
  HOST_SATURATED_AFTER=1 MEMORY_PRESSURE_AFTER=1) || fail "recovery run exited non-zero"
case "$OUT" in
*'"hostStatus":"ok"'*) ;;
*) fail "host recovery expected, got: $OUT" ;;
esac
case "$OUT" in
*'"memoryStatus":"ok"'*) ;;
*) fail "memory recovery expected, got: $OUT" ;;
esac
assert_contains "$STATE/watchdog.log" "RECOVERED dimension=host" "host recovery log"
assert_contains "$STATE/watchdog.log" "RECOVERED dimension=memory" "memory recovery log"

# --- 8. persistent alert reminder interval ----------------------------------
STATE=$(new_state_dir s8-remind)
echo 502 >"$TMP/public_status"
rm -f "$TMP/osascript.log"
OUT=$(run_watchdog "$STATE" "$TMP/monitor-healthy.json" REMIND_SECONDS=0) || fail "remind run 1 exited non-zero"
OUT=$(run_watchdog "$STATE" "$TMP/monitor-healthy.json" REMIND_SECONDS=0) || fail "remind run 2 exited non-zero"
assert_contains "$STATE/watchdog.log" "REMIND" "persistent remind"
[ "$(wc -l <"$TMP/osascript.log" 2>/dev/null || echo 0)" -ge 2 ] || fail "reminder should notify again"

echo "devspace watchdog tests PASS"
exit 0
