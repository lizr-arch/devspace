import { spawn, spawnSync } from "node:child_process";

const MONITOR_URL = "http://127.0.0.1:7676/monitor";
const CHECK_ONLY = process.argv.includes("--check");

let available = await isAvailable();

if (!available && process.platform === "darwin") {
  const userId = typeof process.getuid === "function" ? process.getuid() : 501;
  spawnSync("launchctl", ["kickstart", `gui/${userId}/com.liz.devspace`]);
  for (let attempt = 0; attempt < 10 && !available; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    available = await isAvailable();
  }
}

if (!available) {
  console.error(
    "DevSpace is not responding on 127.0.0.1:7676. Start the local service, then retry.",
  );
  process.exitCode = 1;
} else if (CHECK_ONLY) {
  console.log(`DevSpace monitor is ready at ${MONITOR_URL}`);
} else {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [MONITOR_URL] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/c", "start", "", MONITOR_URL] }
        : { executable: "xdg-open", args: [MONITOR_URL] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`Opened ${MONITOR_URL}`);
}

async function isAvailable() {
  try {
    const response = await fetch(`${MONITOR_URL}/api`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
