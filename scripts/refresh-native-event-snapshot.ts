#!/usr/bin/env node
/**
 * P0-03 operational helper: keep the isolated wake sidecar's read-only Coach
 * event snapshot in sync with the live DevSpace event store.
 *
 * The 8788 wake sidecar holds <snapshotDir>/coach-review-events.sqlite open
 * read-only; this script refreshes that file in place from the live store opened
 * strictly read-only (`file:<path>?mode=ro`). In-place `.backup` refresh is
 * observed by a running sidecar without restart (route-audit T2).
 *
 * Usage:
 *   node --import tsx scripts/refresh-native-event-snapshot.ts --status
 *   node --import tsx scripts/refresh-native-event-snapshot.ts --once
 *   node --import tsx scripts/refresh-native-event-snapshot.ts --watch [--interval 3000]
 *
 * Never writes the live store; never sends wake/POST; never restarts anything.
 */
import { refreshNativeEventSnapshot, snapshotFreshness, startNativeEventSnapshotRefresher } from "../src/coach-native-snapshot.js";

const args = process.argv.slice(2);
const source = process.env.DEVSPACE_NATIVE_EVENT_DB ?? "/Users/liz/.local/share/devspace/coach-review-events.sqlite";
const snapshot = process.env.DEVSPACE_NATIVE_EVENT_SNAPSHOT_PATH ?? "/Users/liz/agy/dsh-wake-e2e/state/coach-review-events.sqlite";
const intervalArg = args.indexOf("--interval");
const intervalMs = intervalArg >= 0 ? Number(args[intervalArg + 1]) : 3000;

if (args.includes("--status")) {
  console.log(JSON.stringify({ mode: "status", source, snapshot, freshness: snapshotFreshness({ sourcePath: source, snapshotPath: snapshot }) }, null, 2));
} else if (args.includes("--once")) {
  const result = refreshNativeEventSnapshot({ sourcePath: source, snapshotPath: snapshot });
  console.log(JSON.stringify({ mode: "once", result }, null, 2));
  process.exit(result.ok ? 0 : 1);
} else if (args.includes("--watch")) {
  const refresher = startNativeEventSnapshotRefresher({ sourcePath: source, snapshotPath: snapshot, intervalMs });
  console.log(JSON.stringify({ mode: "watch", source, snapshot, intervalMs, startedAt: new Date().toISOString() }));
  const stop = () => {
    refresher.stop();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} else {
  console.error("usage: --status | --once | --watch [--interval ms]");
  process.exit(2);
}
