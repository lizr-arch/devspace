#!/bin/bash
# Install the repository copy of the DevSpace watchdog into ~/.local/bin and
# restart the launchd job. Keeps a timestamped backup of the previous script.
#
# Usage:
#   scripts/ops/install-devspace-watchdog.sh [--with-config] [--no-restart] [--dry-run]

set -eu

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC="$REPO_ROOT/scripts/ops/devspace-tunnel-watchdog.sh"
CONF_EXAMPLE="$REPO_ROOT/scripts/ops/watchdog.conf.example"
DEST="${DEVSPACE_WATCHDOG_INSTALL_PATH:-$HOME/.local/bin/devspace-tunnel-watchdog.sh}"
CONF_DIR="${DEVSPACE_WATCHDOG_STATE_DIR:-$HOME/.local/state/devspace}"
LABEL="gui/$(id -u)/com.liz.devspace-watchdog"

WITH_CONFIG=0
NO_RESTART=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
  --with-config) WITH_CONFIG=1 ;;
  --no-restart) NO_RESTART=1 ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "unknown argument: $arg" >&2
    exit 2
    ;;
  esac
done

[ -f "$SRC" ] || {
  echo "missing watchdog source: $SRC" >&2
  exit 1
}
[ -x "$SRC" ] || chmod 0755 "$SRC"

echo "install: $SRC -> $DEST"
if [ "$DRY_RUN" = "1" ]; then
  echo "dry-run: no files changed"
  exit 0
fi

mkdir -p "$(dirname "$DEST")" "$CONF_DIR"
if [ -f "$DEST" ]; then
  backup="$DEST.pre-$(date +%Y%m%d-%H%M%S)"
  cp -p "$DEST" "$backup"
  echo "backup: $backup"
fi
install -m 0755 "$SRC" "$DEST"

if [ "$WITH_CONFIG" = "1" ] && [ ! -f "$CONF_DIR/watchdog.conf" ]; then
  cp "$CONF_EXAMPLE" "$CONF_DIR/watchdog.conf"
  chmod 0644 "$CONF_DIR/watchdog.conf"
  echo "config: $CONF_DIR/watchdog.conf"
fi

if [ "$NO_RESTART" != "1" ]; then
  if launchctl kickstart -k "$LABEL" >/dev/null 2>&1; then
    echo "launchd: restarted $LABEL"
  else
    echo "launchd: kickstart failed for $LABEL (is the agent loaded?)" >&2
  fi
fi

echo "verify: one watchdog pass"
"$DEST" --once
