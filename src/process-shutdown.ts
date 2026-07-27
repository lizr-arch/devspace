export type ShutdownReason =
  "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection";

interface CloseableServer {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
}

export interface ShutdownHandlerOptions {
  httpServer: CloseableServer;
  closeResources: () => void;
  exit: (code: number) => void;
  logCrash: (reason: ShutdownReason, error: Error) => void;
  timeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export function createShutdownHandler(
  options: ShutdownHandlerOptions,
): (reason: ShutdownReason, error?: Error) => void {
  let shuttingDown = false;
  let finished = false;
  let timeout: NodeJS.Timeout | undefined;

  return (reason, error) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (error) options.logCrash(reason, error);

    const exitCode = reason === "SIGINT" || reason === "SIGTERM" ? 0 : 1;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      options.exit(exitCode);
    };

    try {
      options.closeResources();
    } catch (closeError) {
      options.logCrash(
        reason,
        closeError instanceof Error
          ? closeError
          : new Error(String(closeError)),
      );
    }

    timeout = setTimeout(() => {
      try {
        options.httpServer.closeAllConnections?.();
      } finally {
        finish();
      }
    }, options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    try {
      options.httpServer.close(() => finish());
    } catch {
      finish();
    }
  };
}
