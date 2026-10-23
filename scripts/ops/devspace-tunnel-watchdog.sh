#!/bin/bash
# DevSpace tunnel + host watchdog (v2, 2026-10-24)
#
# Why it exists:
#   cloudflared dropping is silent from inside the machine: local health checks
#   stay green while the public entry point returns Cloudflare 530/1033/502.
#   Since 2026-10-24 the watchdog also watches host saturation (event-loop
#   stalls, load average, swap) because a starved host makes DevSpace look
#   disconnected even when every HTTP status is 200.
#
# Checks, outside -> inside:
#   1) cloudflared process present
#   2) local DevSpace /healthz
#   3) public /healthz through the tunnel
#   4) host pressure via /monitor/api (optional; degrades gracefully)
#   5) optional cloudflared metrics connection count (record only)
#
# Optional config file: $STATE_DIR/watchdog.conf (shell overrides), e.g.
#   AUTORESTART=1
#   AUTORESTART_AFTER=3
#   RESTART_COOLDOWN=900
#   REMIND_SECONDS=1800
#   HOST_SATURATED_AFTER=2
#   MEMORY_PRESSURE_AFTER=3
#   EVENTLOOP_MAX_MS=5000
#   LOAD_FACTOR=2
#   SWAP_PERCENT=80
#   MEMORY_AVAILABLE_MIB=1024
#
# Flags:
#   --once   run a single pass, print a JSON summary and exit
#
# Notes:
#   - The watchdog never restarts cloudflared for host/memory pressure: that is
#     a host problem, not a tunnel problem.
#   - The watchdog never kills DevSpace.

set -u

SCRIPT_VERSION="2026-10-24.v2"

STATE_DIR="${DEVSPACE_WATCHDOG_STATE_DIR:-$HOME/.local/state/devspace}"
mkdir -p "$STATE_DIR"
if [ -f "$STATE_DIR/watchdog.conf" ]; then
  # shellcheck disable=SC1091
  . "$STATE_DIR/watchdog.conf"
fi

PUBLIC_URL="${PUBLIC_URL:-${DEVSPACE_WATCHDOG_PUBLIC_URL:-https://mcp.workspaceport.com/healthz}}"
LOCAL_URL="${LOCAL_URL:-${DEVSPACE_WATCHDOG_LOCAL_URL:-http://127.0.0.1:7676/healthz}}"
MONITOR_URL="${MONITOR_URL:-${DEVSPACE_WATCHDOG_MONITOR_URL:-http://127.0.0.1:7676/monitor/api}}"
CLOUDFLARED_LABEL="${CLOUDFLARED_LABEL:-${DEVSPACE_WATCHDOG_LAUNCHD_LABEL:-gui/$(id -u)/com.liz.cloudflared-devspace}}"
REMIND_SECONDS="${REMIND_SECONDS:-${DEVSPACE_WATCHDOG_REMIND_SECONDS:-1800}}"
RESTART_COOLDOWN="${RESTART_COOLDOWN:-${DEVSPACE_WATCHDOG_RESTART_COOLDOWN:-900}}"
AUTORESTART="${AUTORESTART:-${DEVSPACE_WATCHDOG_AUTORESTART:-0}}"
AUTORESTART_AFTER="${AUTORESTART_AFTER:-${DEVSPACE_WATCHDOG_AUTORESTART_AFTER:-3}}"
DRY_RUN="${DRY_RUN:-${DEVSPACE_WATCHDOG_DRY_RUN:-0}}"
HOST_SATURATED_AFTER="${HOST_SATURATED_AFTER:-${DEVSPACE_WATCHDOG_HOST_SATURATED_AFTER:-2}}"
MEMORY_PRESSURE_AFTER="${MEMORY_PRESSURE_AFTER:-${DEVSPACE_WATCHDOG_MEMORY_PRESSURE_AFTER:-3}}"
EVENTLOOP_MAX_MS="${EVENTLOOP_MAX_MS:-${DEVSPACE_WATCHDOG_EVENTLOOP_MAX_MS:-5000}}"
LOAD_FACTOR="${LOAD_FACTOR:-${DEVSPACE_WATCHDOG_LOAD_FACTOR:-2}}"
SWAP_PERCENT="${SWAP_PERCENT:-${DEVSPACE_WATCHDOG_SWAP_PERCENT:-80}}"
MEMORY_AVAILABLE_MIB="${MEMORY_AVAILABLE_MIB:-${DEVSPACE_WATCHDOG_MEMORY_AVAILABLE_MIB:-1024}}"
METRICS_URL="${METRICS_URL:-${DEVSPACE_WATCHDOG_METRICS_URL:-}}"
EXPECTED_CONNECTIONS="${EXPECTED_CONNECTIONS:-${DEVSPACE_WATCHDOG_EXPECTED_CONNECTIONS:-4}}"
LOG_ROTATE="${LOG_ROTATE:-${DEVSPACE_WATCHDOG_LOG_ROTATE:-1}}"
LOG_ROTATE_MAX_BYTES="${LOG_ROTATE_MAX_BYTES:-${DEVSPACE_WATCHDOG_LOG_ROTATE_MAX_BYTES:-104857600}}"
CLOUDFLARED_ERR_LOG="${CLOUDFLARED_ERR_LOG:-${DEVSPACE_WATCHDOG_CLOUDFLARED_LOG:-$HOME/.devspace/logs/cloudflared.err.log}}"
MONITOR_EVENTS="${MONITOR_EVENTS:-${DEVSPACE_WATCHDOG_MONITOR_EVENTS:-$HOME/.local/share/devspace/monitor-events.jsonl}}"
FIXTURE_MONITOR_JSON="${FIXTURE_MONITOR_JSON:-${DEVSPACE_WATCHDOG_FIXTURE_MONITOR_JSON:-}}"

ONCE=0
if [ "${1:-}" = "--once" ]; then ONCE=1; fi

STATE_FILE="$STATE_DIR/watchdog.state"
LOG_FILE="$STATE_DIR/watchdog.log"
HOST_JSONL="$STATE_DIR/watchdog-host.jsonl"
NOW=$(date +%s)
TS=$(date '+%Y-%m-%d %H:%M:%S')

log() {
  printf '%s %s\n' "$TS" "$*" >>"$LOG_FILE"
  if [ "$(wc -c <"$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    tail -n 500 "$LOG_FILE" >"$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
}

notify() {
  local title="$1" message="$2" sound="${3:-}"
  if [ "$DRY_RUN" = "1" ]; then
    log "NOTIFY_DRY title=$title message=$message"
    return 0
  fi
  if [ -n "$sound" ]; then
    osascript -e "display notification \"$message\" with title \"$title\" sound name \"$sound\"" >/dev/null 2>&1 || true
  else
    osascript -e "display notification \"$message\" with title \"$title\"" >/dev/null 2>&1 || true
  fi
}

http_code() {
  local url="$1" timeout="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m "$timeout" --noproxy '*' "$url" 2>/dev/null)
  [ -n "$code" ] || code=000
  printf '%s' "$code"
}

is_number() {
  case "${1:-}" in
  "" | *[!0-9.]* ) return 1 ;;
  esac
  return 0
}

ge() { # ge a b -> true when a >= b
  awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN { exit !(a >= b) }'
}

# ---------------- state ------------------------------------------------------

TUNNEL_STATUS="healthy"
TUNNEL_CONSECUTIVE=0
TUNNEL_NOTIFY_AT=0
TUNNEL_RESTART_AT=0
HOST_STATUS="ok"
HOST_CONSECUTIVE=0
HOST_NOTIFY_AT=0
MEMORY_STATUS="ok"
MEMORY_CONSECUTIVE=0
MEMORY_NOTIFY_AT=0

load_state() {
  [ -f "$STATE_FILE" ] || return 0
  if head -1 "$STATE_FILE" 2>/dev/null | grep -q '|'; then
    # Legacy single-line format: status|consecutive|notify_at|restart_at
    local legacy_status legacy_consecutive legacy_notify legacy_restart
    IFS='|' read -r legacy_status legacy_consecutive legacy_notify legacy_restart <"$STATE_FILE" || true
    case "${legacy_consecutive:-}" in '' | *[!0-9]*) legacy_consecutive=0 ;; esac
    case "${legacy_notify:-}" in '' | *[!0-9]*) legacy_notify=0 ;; esac
    case "${legacy_restart:-}" in '' | *[!0-9]*) legacy_restart=0 ;; esac
    TUNNEL_STATUS="${legacy_status:-healthy}"
    TUNNEL_CONSECUTIVE="$legacy_consecutive"
    TUNNEL_NOTIFY_AT="$legacy_notify"
    TUNNEL_RESTART_AT="$legacy_restart"
    return 0
  fi
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
    TUNNEL_STATUS) TUNNEL_STATUS="$value" ;;
    TUNNEL_CONSECUTIVE) TUNNEL_CONSECUTIVE="$value" ;;
    TUNNEL_NOTIFY_AT) TUNNEL_NOTIFY_AT="$value" ;;
    TUNNEL_RESTART_AT) TUNNEL_RESTART_AT="$value" ;;
    HOST_STATUS) HOST_STATUS="$value" ;;
    HOST_CONSECUTIVE) HOST_CONSECUTIVE="$value" ;;
    HOST_NOTIFY_AT) HOST_NOTIFY_AT="$value" ;;
    MEMORY_STATUS) MEMORY_STATUS="$value" ;;
    MEMORY_CONSECUTIVE) MEMORY_CONSECUTIVE="$value" ;;
    MEMORY_NOTIFY_AT) MEMORY_NOTIFY_AT="$value" ;;
    esac
  done <"$STATE_FILE"
}

save_state() {
  {
    printf 'FORMAT=2\n'
    printf 'UPDATED_AT=%s\n' "$NOW"
    printf 'TUNNEL_STATUS=%s\n' "$TUNNEL_STATUS"
    printf 'TUNNEL_CONSECUTIVE=%s\n' "$TUNNEL_CONSECUTIVE"
    printf 'TUNNEL_NOTIFY_AT=%s\n' "$TUNNEL_NOTIFY_AT"
    printf 'TUNNEL_RESTART_AT=%s\n' "$TUNNEL_RESTART_AT"
    printf 'HOST_STATUS=%s\n' "$HOST_STATUS"
    printf 'HOST_CONSECUTIVE=%s\n' "$HOST_CONSECUTIVE"
    printf 'HOST_NOTIFY_AT=%s\n' "$HOST_NOTIFY_AT"
    printf 'MEMORY_STATUS=%s\n' "$MEMORY_STATUS"
    printf 'MEMORY_CONSECUTIVE=%s\n' "$MEMORY_CONSECUTIVE"
    printf 'MEMORY_NOTIFY_AT=%s\n' "$MEMORY_NOTIFY_AT"
    printf 'TUNNEL_DETAIL=%s\n' "${TUNNEL_DETAIL:-}"
  } >"$STATE_FILE"
}

# ---------------- log rotation ----------------------------------------------

rotate_if_large() {
  local file="$1" limit="$2" size
  [ "$LOG_ROTATE" = "1" ] || return 0
  [ -f "$file" ] || return 0
  size=$(wc -c <"$file" 2>/dev/null || echo 0)
  [ "$size" -gt "$limit" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then
    log "ROTATE_DRY file=$file bytes=$size"
    return 0
  fi
  cp -p "$file" "$file.1" 2>/dev/null || true
  : >"$file" 2>/dev/null || true
  log "ROTATE file=$file bytes=$size"
}

# ---------------- checks -----------------------------------------------------

load_state

PROC_OVERRIDE="${PROC_OVERRIDE:-${DEVSPACE_WATCHDOG_PROC_OVERRIDE:-}}"
proc_ok=0
if [ "$PROC_OVERRIDE" = "1" ] || [ "$PROC_OVERRIDE" = "0" ]; then
  proc_ok="$PROC_OVERRIDE"
elif pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
  proc_ok=1
fi

local_code=$(http_code "$LOCAL_URL" 8)
public_code=$(http_code "$PUBLIC_URL" 25)

tunnel_status="healthy"
tunnel_detail=""
if [ "$local_code" != "200" ]; then
  tunnel_status="local_down"
  tunnel_detail="local DevSpace unresponsive (http=$local_code)"
elif [ "$proc_ok" != "1" ]; then
  tunnel_status="cloudflared_down"
  tunnel_detail="cloudflared process missing (local http=$local_code)"
elif [ "$public_code" != "200" ]; then
  tunnel_status="tunnel_down"
  tunnel_detail="public entry unhealthy (http=$public_code, local http=$local_code)"
else
  tunnel_detail="local http=$local_code, public http=$public_code"
fi

if [ "$tunnel_status" = "healthy" ]; then
  if [ "$TUNNEL_STATUS" != "healthy" ]; then
    notify "DevSpace 已恢复" "隧道恢复：$tunnel_detail" "Glass"
    log "RECOVERED dimension=tunnel from=$TUNNEL_STATUS $tunnel_detail"
    TUNNEL_NOTIFY_AT=$NOW
  else
    log "OK $tunnel_detail"
  fi
  TUNNEL_CONSECUTIVE=0
else
  TUNNEL_CONSECUTIVE=$((TUNNEL_CONSECUTIVE + 1))
  if [ "$TUNNEL_STATUS" != "$tunnel_status" ]; then
    notify "DevSpace 隧道异常" "$tunnel_status: $tunnel_detail" "Basso"
    TUNNEL_NOTIFY_AT=$NOW
    log "ALERT status=$tunnel_status consecutive=$TUNNEL_CONSECUTIVE $tunnel_detail"
  elif [ $((NOW - TUNNEL_NOTIFY_AT)) -ge "$REMIND_SECONDS" ]; then
    notify "DevSpace 隧道异常持续" "$tunnel_status: $tunnel_detail" "Basso"
    TUNNEL_NOTIFY_AT=$NOW
    log "REMIND status=$tunnel_status consecutive=$TUNNEL_CONSECUTIVE $tunnel_detail"
  else
    log "DOWN status=$tunnel_status consecutive=$TUNNEL_CONSECUTIVE $tunnel_detail"
  fi
fi
TUNNEL_STATUS="$tunnel_status"
TUNNEL_DETAIL="$tunnel_detail"

# ---------------- host pressure ---------------------------------------------

EVENTLOOP_VALUE=""
LOAD1_VALUE=""
CPUCOUNT_VALUE=""
SWAP_VALUE=""
AVAIL_VALUE=""
host_checked=0
mem_bad=0
mem_reason=""
host_bad=0
host_reason=""

if [ "$local_code" = "200" ]; then
  monitor_json=""
  if [ -n "$FIXTURE_MONITOR_JSON" ] && [ -f "$FIXTURE_MONITOR_JSON" ]; then
    monitor_json=$(cat "$FIXTURE_MONITOR_JSON" 2>/dev/null || true)
  else
    monitor_json=$(curl -s -m 2 --noproxy '*' "$MONITOR_URL" 2>/dev/null || true)
  fi
  if [ -n "$monitor_json" ] && command -v python3 >/dev/null 2>&1; then
    parsed=$(printf '%s' "$monitor_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
def fmt(v):
    return "" if v is None else str(v)
el = d.get("eventLoop") or {}
sysv = d.get("system") or {}
la = sysv.get("loadAverage") or {}
print(fmt(el.get("maxMs")), fmt(la.get("one")), fmt(sysv.get("cpuCount")), fmt(sysv.get("swapUsedPercent")), fmt(sysv.get("memoryAvailableMiB")))
' 2>/dev/null) || parsed=""
    if [ -n "$parsed" ]; then
      host_checked=1
      read -r EVENTLOOP_VALUE LOAD1_VALUE CPUCOUNT_VALUE SWAP_VALUE AVAIL_VALUE <<<"$parsed"
      if is_number "$EVENTLOOP_VALUE" && [ -n "$EVENTLOOP_VALUE" ] && ge "$EVENTLOOP_VALUE" "$EVENTLOOP_MAX_MS"; then
        host_bad=1
        host_reason="eventLoopMaxMs=$EVENTLOOP_VALUE"
      fi
      if is_number "$LOAD1_VALUE" && is_number "$CPUCOUNT_VALUE" && [ -n "$LOAD1_VALUE" ] && [ -n "$CPUCOUNT_VALUE" ]; then
        if ge "$LOAD1_VALUE" "$(awk -v f="$LOAD_FACTOR" -v c="$CPUCOUNT_VALUE" 'BEGIN { printf "%.2f", f * c }')"; then
          host_bad=1
          if [ -n "$host_reason" ]; then host_reason="$host_reason; "; fi
          host_reason="${host_reason}load1=$LOAD1_VALUE cpuCount=$CPUCOUNT_VALUE"
        fi
      fi
      if is_number "$SWAP_VALUE" && [ -n "$SWAP_VALUE" ] && ge "$SWAP_VALUE" "$SWAP_PERCENT"; then
        mem_bad=1
        mem_reason="swapUsedPercent=$SWAP_VALUE"
      fi
      if is_number "$AVAIL_VALUE" && [ -n "$AVAIL_VALUE" ] && ! ge "$AVAIL_VALUE" "$MEMORY_AVAILABLE_MIB"; then
        mem_bad=1
        if [ -n "$mem_reason" ]; then mem_reason="$mem_reason; "; fi
        mem_reason="${mem_reason}memoryAvailableMiB=$AVAIL_VALUE"
      fi
      {
        printf '{"observedAt":"%s","eventLoopMaxMs":%s,"load1":%s,"cpuCount":%s,"swapUsedPercent":%s,"memoryAvailableMiB":%s}\n' \
          "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
          "$( [ -n "$EVENTLOOP_VALUE" ] && printf '%s' "$EVENTLOOP_VALUE" || printf 'null')" \
          "$( [ -n "$LOAD1_VALUE" ] && printf '%s' "$LOAD1_VALUE" || printf 'null')" \
          "$( [ -n "$CPUCOUNT_VALUE" ] && printf '%s' "$CPUCOUNT_VALUE" || printf 'null')" \
          "$( [ -n "$SWAP_VALUE" ] && printf '%s' "$SWAP_VALUE" || printf 'null')" \
          "$( [ -n "$AVAIL_VALUE" ] && printf '%s' "$AVAIL_VALUE" || printf 'null')"
      } >>"$HOST_JSONL"
      if [ "$(wc -c <"$HOST_JSONL" 2>/dev/null || echo 0)" -gt 524288 ]; then
        tail -n 200 "$HOST_JSONL" >"$HOST_JSONL.tmp" 2>/dev/null && mv "$HOST_JSONL.tmp" "$HOST_JSONL"
      fi
    else
      log "HOST_SKIP reason=monitor_parse_failed"
    fi
  else
    log "HOST_SKIP reason=monitor_unavailable"
  fi
fi

if [ "$host_checked" = "1" ]; then
  if [ "$host_bad" = "1" ]; then
    HOST_CONSECUTIVE=$((HOST_CONSECUTIVE + 1))
  else
    HOST_CONSECUTIVE=0
  fi
  if [ "$host_bad" = "1" ] && [ "$HOST_CONSECUTIVE" -ge "$HOST_SATURATED_AFTER" ]; then
    new_host_status="host_saturated"
  else
    new_host_status="ok"
  fi
  if [ "$new_host_status" != "$HOST_STATUS" ]; then
    if [ "$new_host_status" = "ok" ]; then
      notify "DevSpace 主机已恢复" "主机压力回落" "Glass"
      log "RECOVERED dimension=host detail=pressure_normal"
    else
      notify "DevSpace 主机饱和" "$host_reason" "Basso"
      log "ALERT dimension=host consecutive=$HOST_CONSECUTIVE $host_reason"
    fi
    HOST_NOTIFY_AT=$NOW
  elif [ "$new_host_status" != "ok" ] && [ $((NOW - HOST_NOTIFY_AT)) -ge "$REMIND_SECONDS" ]; then
    notify "DevSpace 主机持续饱和" "$host_reason" "Basso"
    HOST_NOTIFY_AT=$NOW
    log "REMIND dimension=host $host_reason"
  fi
  HOST_STATUS="$new_host_status"

  if [ "$mem_bad" = "1" ]; then
    MEMORY_CONSECUTIVE=$((MEMORY_CONSECUTIVE + 1))
  else
    MEMORY_CONSECUTIVE=0
  fi
  if [ "$mem_bad" = "1" ] && [ "$MEMORY_CONSECUTIVE" -ge "$MEMORY_PRESSURE_AFTER" ]; then
    new_memory_status="memory_pressure"
  else
    new_memory_status="ok"
  fi
  if [ "$new_memory_status" != "$MEMORY_STATUS" ]; then
    if [ "$new_memory_status" = "ok" ]; then
      notify "DevSpace 内存已恢复" "内存压力回落" "Glass"
      log "RECOVERED dimension=memory detail=pressure_normal"
    else
      notify "DevSpace 内存压力" "$mem_reason" "Basso"
      log "ALERT dimension=memory consecutive=$MEMORY_CONSECUTIVE $mem_reason"
    fi
    MEMORY_NOTIFY_AT=$NOW
  elif [ "$new_memory_status" != "ok" ] && [ $((NOW - MEMORY_NOTIFY_AT)) -ge "$REMIND_SECONDS" ]; then
    notify "DevSpace 内存压力持续" "$mem_reason" "Basso"
    MEMORY_NOTIFY_AT=$NOW
    log "REMIND dimension=memory $mem_reason"
  fi
  MEMORY_STATUS="$new_memory_status"
fi

# ---------------- optional cloudflared metrics -------------------------------

CF_CONNECTIONS=""
if [ -n "$METRICS_URL" ] && command -v python3 >/dev/null 2>&1; then
  CF_CONNECTIONS=$(curl -s -m 2 --noproxy '*' "$METRICS_URL" 2>/dev/null | python3 -c '
import sys
value = None
for line in sys.stdin:
    if line.startswith("cloudflared_tunnel_ha_connections"):
        try:
            value = int(float(line.split()[-1]))
        except Exception:
            pass
print("" if value is None else value)
' 2>/dev/null || true)
  if [ -n "$CF_CONNECTIONS" ] && [ "$CF_CONNECTIONS" -lt "$EXPECTED_CONNECTIONS" ]; then
    log "TUNNEL_DEGRADED connections=$CF_CONNECTIONS expected=$EXPECTED_CONNECTIONS"
  fi
fi

# ---------------- self healing (tunnel only) ---------------------------------

if [ "$AUTORESTART" = "1" ] &&
  [ "$DRY_RUN" != "1" ] &&
  [ "$proc_ok" = "1" ] &&
  [ "$local_code" = "200" ] &&
  [ "$TUNNEL_STATUS" = "tunnel_down" ] &&
  [ "$TUNNEL_CONSECUTIVE" -ge "$AUTORESTART_AFTER" ] &&
  [ $((NOW - TUNNEL_RESTART_AT)) -ge "$RESTART_COOLDOWN" ]; then
  if launchctl kickstart -k "$CLOUDFLARED_LABEL" >/dev/null 2>&1; then
    TUNNEL_RESTART_AT=$NOW
    log "AUTORESTART kickstart issued label=$CLOUDFLARED_LABEL consecutive=$TUNNEL_CONSECUTIVE"
    notify "DevSpace 自动重启隧道" "已对 $TUNNEL_STATUS 执行 cloudflared 重启" "Funk"
  else
    log "AUTORESTART_FAILED label=$CLOUDFLARED_LABEL"
  fi
fi

# ---------------- log rotation ----------------------------------------------

rotate_if_large "$STATE_DIR/devspace.log" "$LOG_ROTATE_MAX_BYTES"
rotate_if_large "$CLOUDFLARED_ERR_LOG" "$LOG_ROTATE_MAX_BYTES"
rotate_if_large "$MONITOR_EVENTS" "$((LOG_ROTATE_MAX_BYTES / 5))"

save_state

if [ "$ONCE" = "1" ]; then
  printf '{"scriptVersion":"%s","tunnelStatus":"%s","tunnelDetail":"%s","hostStatus":"%s","hostConsecutive":%s,"memoryStatus":"%s","memoryConsecutive":%s,"localCode":"%s","publicCode":"%s","cloudflaredProcess":%s,"hostChecked":%s,"cloudflaredConnections":%s}\n' \
    "$SCRIPT_VERSION" "$TUNNEL_STATUS" "${TUNNEL_DETAIL//\"/}" "$HOST_STATUS" "${HOST_CONSECUTIVE:-0}" \
    "$MEMORY_STATUS" "${MEMORY_CONSECUTIVE:-0}" "$local_code" "$public_code" \
    "$( [ "$proc_ok" = "1" ] && printf true || printf false)" \
    "$( [ "$host_checked" = "1" ] && printf true || printf false)" \
    "$( [ -n "$CF_CONNECTIONS" ] && printf '%s' "$CF_CONNECTIONS" || printf null)"
fi

exit 0
