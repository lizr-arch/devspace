/** Minimal opt-in integration-test child; environment must point at a temp state dir. */
import { loadConfig } from "./config.js";
import { startCodexWorkerService } from "./codex-worker-ipc.js";

const service=await startCodexWorkerService(loadConfig());
process.stdout.write(`READY ${service.workerId} ${service.generation} ${process.pid}\n`);
