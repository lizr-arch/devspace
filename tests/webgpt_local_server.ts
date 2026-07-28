import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

export interface LocalWebGptTestServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startLocalWebGptTestServer(): Promise<LocalWebGptTestServer> {
  const tempRoot = mkdtempSync(join(tmpdir(), "devspace-webgpt-local-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(tempRoot, "config"),
    DEVSPACE_ALLOWED_ROOTS: tempRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "local-webgpt-test-owner-token",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7677",
    DEVSPACE_STATE_DIR: join(tempRoot, "state"),
    DEVSPACE_WORKTREE_ROOT: join(tempRoot, "worktrees"),
    DEVSPACE_AGENT_DIR: join(tempRoot, "agent"),
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_SKILLS: "0",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    HOST: "127.0.0.1",
    PORT: "7677",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(httpServer);
    running.close();
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error("Unable to resolve local Web GPT test server address.");
  }

  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeHttpServer(httpServer);
      running.close();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function runStandalone(): Promise<void> {
  const server = await startLocalWebGptTestServer();
  const url = `${server.baseUrl}/app-test`;
  console.log(`DevSpace Web GPT local test host: ${url}`);
  console.log("Press Ctrl+C to stop the isolated test server.");

  if (process.argv.includes("--open")) {
    const command =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    const child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await runStandalone();
}
