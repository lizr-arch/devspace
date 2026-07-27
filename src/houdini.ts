import { spawn } from "node:child_process";
import { basename } from "node:path";
import { RunnerRegistry, type ResolvedRunner } from "./runner-registry.js";

const HOUDINI_PROBE_TIMEOUT_MS = 10_000;
const HOUDINI_PROBE_OUTPUT_BYTES = 32 * 1024;
const HOUDINI_PROBE_MARKER = "__DEVSPACE_HOUDINI_PREFLIGHT__";
const HOUDINI_PREFLIGHT_SCRIPT = [
  "import json, platform, hou",
  "category = str(hou.licenseCategory())",
  `print(${JSON.stringify(HOUDINI_PROBE_MARKER)} + json.dumps({`,
  '  "version": hou.applicationVersionString(),',
  '  "architecture": platform.machine(),',
  '  "licenseCategory": category',
  "}, sort_keys=True))",
].join("\n");

export type HoudiniProductEdition =
  | "commercial"
  | "indie"
  | "education"
  | "apprentice_non_commercial"
  | "engine"
  | "unknown";

export type HoudiniLicenseStatus = "available" | "unavailable" | "unknown";

export interface HoudiniInfo {
  detectedExecutable?: string;
  version?: string;
  hostArchitecture: string;
  executableArchitecture?: string;
  productEdition: HoudiniProductEdition;
  licenseStatus: HoudiniLicenseStatus;
  hythonAvailable: boolean;
  hbatchAvailable: boolean;
  hythonExecutable?: string;
  hbatchExecutable?: string;
  diagnostic: string;
}

interface ProbeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface HoudiniInspectionOptions {
  hostArchitecture?: string;
  probe?: (
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<ProbeResult>;
}

export async function inspectHoudini(
  runners: RunnerRegistry,
  options: HoudiniInspectionOptions = {},
): Promise<HoudiniInfo> {
  const [hython, hbatch] = await Promise.all([
    resolveOptional(runners, "hython"),
    resolveOptional(runners, "hbatch"),
  ]);
  const base: HoudiniInfo = {
    detectedExecutable: hython?.executable ?? hbatch?.executable,
    version: versionFromResolved(hython) ?? versionFromResolved(hbatch),
    hostArchitecture: options.hostArchitecture ?? process.arch,
    productEdition: "unknown",
    licenseStatus: "unknown",
    hythonAvailable: Boolean(hython),
    hbatchAvailable: Boolean(hbatch),
    hythonExecutable: hython?.executable,
    hbatchExecutable: hbatch?.executable,
    diagnostic:
      !hython && !hbatch
        ? "Houdini executables were not found in trusted discovery locations or operator configuration."
        : !hython
          ? "hbatch is available, but hython is unavailable; license-safe preflight was not run."
          : "Houdini executable discovery succeeded; license-safe preflight is pending.",
  };
  if (!hython) return base;

  const probe = options.probe ?? runBoundedProbe;
  const result = await probe(
    hython.executable,
    ["-c", HOUDINI_PREFLIGHT_SCRIPT],
    hython.environment,
  );
  if (result.timedOut) {
    return {
      ...base,
      diagnostic:
        "License-safe hython preflight timed out; license availability remains unknown.",
    };
  }

  const parsed = parsePreflightPayload(result.output);
  if (result.code === 0 && parsed) {
    return {
      ...base,
      version: parsed.version ?? base.version,
      executableArchitecture: parsed.architecture,
      productEdition: classifyProductEdition(parsed.licenseCategory),
      licenseStatus: "available",
      diagnostic: result.truncated
        ? "License-safe hython preflight succeeded; unrelated process output was truncated."
        : "License-safe hython preflight succeeded without login, activation, or license mutation.",
    };
  }

  const licenseUnavailable = hasLicenseFailureSignature(result.output);
  return {
    ...base,
    licenseStatus: licenseUnavailable ? "unavailable" : "unknown",
    diagnostic: licenseUnavailable
      ? "Hython is installed, but the read-only preflight reported no usable license."
      : `License-safe hython preflight failed${result.signal ? ` with signal ${result.signal}` : result.code === null ? "" : ` with exit code ${result.code}`}; diagnostic output was withheld to avoid credential disclosure.`,
  };
}

export function classifyProductEdition(value: string): HoudiniProductEdition {
  const normalized = value.toLowerCase();
  if (normalized.includes("indie")) return "indie";
  if (normalized.includes("education")) return "education";
  if (
    normalized.includes("apprentice") ||
    normalized.includes("noncommercial") ||
    normalized.includes("non-commercial")
  ) {
    return "apprentice_non_commercial";
  }
  if (normalized.includes("engine")) return "engine";
  if (normalized.includes("commercial") || normalized.includes("houdini fx")) {
    return "commercial";
  }
  return "unknown";
}

export function redactHoudiniDiagnostic(value: string): string {
  return value
    .replace(
      /\b(?:license(?:_?key)?|serial|account|username|password|token|secret|sesi_lmhost)\s*[:=]\s*[^\s,;]+/gi,
      "[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/gi, "[REDACTED]");
}

function versionFromResolved(
  resolved: ResolvedRunner | undefined,
): string | undefined {
  const candidates = [resolved?.version, resolved?.executable].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    const match =
      /\bHoudini(?:\s+(?:FX|Core|Indie|Education|Apprentice))?\s+(\d+\.\d+(?:\.\d+)?)/i.exec(
        candidate,
      ) ??
      /(?:Houdini|Versions)[/\\](?:Houdini)?(\d+\.\d+(?:\.\d+)?)/i.exec(
        candidate,
      );
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function resolveOptional(
  runners: RunnerRegistry,
  name: "hython" | "hbatch",
): Promise<ResolvedRunner | undefined> {
  try {
    return await runners.resolve(name);
  } catch {
    return undefined;
  }
}

function parsePreflightPayload(output: string):
  | {
      version?: string;
      architecture?: string;
      licenseCategory: string;
    }
  | undefined {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(HOUDINI_PROBE_MARKER));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(
      line.slice(HOUDINI_PROBE_MARKER.length),
    ) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { licenseCategory?: unknown }).licenseCategory !==
        "string"
    ) {
      return undefined;
    }
    const value = parsed as {
      version?: unknown;
      architecture?: unknown;
      licenseCategory: string;
    };
    return {
      version: typeof value.version === "string" ? value.version : undefined,
      architecture:
        typeof value.architecture === "string" ? value.architecture : undefined,
      licenseCategory: value.licenseCategory,
    };
  } catch {
    return undefined;
  }
}

function hasLicenseFailureSignature(output: string): boolean {
  return /(?:no licenses?|unable to (?:connect|acquire)|license (?:error|server|not found|unavailable)|cannot connect to.*license|failed to acquire)/i.test(
    redactHoudiniDiagnostic(output),
  );
}

async function runBoundedProbe(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProbeResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let truncated = false;
    let completed = false;
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      timedOut: boolean,
    ) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolvePromise({
        code,
        signal,
        output: redactHoudiniDiagnostic(output),
        timedOut,
        truncated,
      });
    };
    const append = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = HOUDINI_PROBE_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = data.subarray(0, remaining);
      output += accepted.toString("utf8");
      outputBytes += accepted.length;
      if (accepted.length < data.length) truncated = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      append(`${basename(executable)} probe error: ${error.message}`);
      finish(null, null, false);
    });
    child.once("exit", (code, signal) => finish(code, signal, false));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, "SIGKILL", true);
    }, HOUDINI_PROBE_TIMEOUT_MS);
  });
}
