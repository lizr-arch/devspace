import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  buildCoachPack,
  type IncludedEntry,
} from "./context-pack.js";
import { parseCoachReply, type CoachReplySummary } from "./ingest.js";
import {
  createSensitiveOmission,
  type OmittedEntry,
} from "./policy.js";
import { expandHomePath } from "../roots.js";
import { devspaceConfigDir, loadDevspaceFiles } from "../user-config.js";

export type CoachSessionStatus = "WAITING_FOR_COACH" | "READY_FOR_NEXT_PACK";

const MAX_SESSION_PACKS = 8;
const MAX_SESSION_UNIQUE_FILES = 40;
const MAX_SESSION_CHARACTERS = 2_000_000;

export interface CoachSessionTurn {
  turn: number;
  task: string;
  manifestPath: string;
  createdAt: string;
  included: IncludedEntry[];
  omitted: OmittedEntry[];
  totalCharacters: number;
  requiresExpansionApproval: boolean;
}

export interface CoachSessionReplyRecord {
  turn: number;
  replyPath: string;
  createdAt: string;
  diagnosisCount: number;
  referencedFileCount: number;
  nextReadCount: number;
  patchPlanCount: number;
  verificationCommandCount: number;
}

export interface CoachSessionDeniedRequest {
  request: string;
  reason: string;
  createdAt: string;
}

export interface CoachSessionState {
  version: 1;
  sessionId: string;
  sessionDir: string;
  repoPath: string;
  initialTask: string;
  currentTask: string;
  budget: number;
  createdAt: string;
  updatedAt: string;
  status: CoachSessionStatus;
  pendingRequests: string[];
  deniedRequests: CoachSessionDeniedRequest[];
  turns: CoachSessionTurn[];
  replies: CoachSessionReplyRecord[];
}

export interface CoachSessionContext {
  sessionId: string;
  sessionDir: string;
  sessionStatePath: string;
}

export interface StartCoachSessionInput {
  repoPath: string;
  task: string;
  budget?: number;
  env?: NodeJS.ProcessEnv;
}

export interface StartCoachSessionResult extends CoachSessionContext {
  pack: string;
  packPath: string;
  manifestPath: string;
  state: CoachSessionState;
  requiresExpansionApproval: boolean;
}

export interface IngestCoachSessionInput {
  session: string;
  replyPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface IngestCoachSessionResult extends CoachSessionContext {
  summary: CoachReplySummary;
  state: CoachSessionState;
}

export interface NextCoachSessionPackInput {
  session: string;
  task?: string;
  budget?: number;
  env?: NodeJS.ProcessEnv;
}

export interface NextCoachSessionPackResult extends CoachSessionContext {
  pack: string;
  packPath: string;
  manifestPath: string;
  task: string;
  state: CoachSessionState;
  requiresExpansionApproval: boolean;
}

export interface CoachSessionUsage {
  packCount: number;
  uniqueFileCount: number;
  totalCharacters: number;
}

export interface CoachSessionStatusSnapshot extends CoachSessionContext {
  state: CoachSessionState;
  usage: CoachSessionUsage;
}

export async function startCoachSession(
  input: StartCoachSessionInput,
): Promise<StartCoachSessionResult> {
  const sessionRoot = resolveCoachSessionRoot(input.env);
  const sessionId = createSessionId();
  const sessionDir = join(sessionRoot, sessionId);
  const sessionStatePath = join(sessionDir, "session.json");
  await mkdir(sessionDir, { recursive: true });

  const packResult = await buildCoachPack({
    repoPath: input.repoPath,
    task: input.task,
    budget: input.budget,
    env: input.env,
  });

  const turn = 1;
  const packPath = join(sessionDir, formatPackName(turn));
  const manifestPath = deriveManifestPath(packPath);
  await writeFile(
    manifestPath,
    JSON.stringify(packResult.manifest, null, 2),
    "utf-8",
  );

  const now = new Date().toISOString();
  const state: CoachSessionState = {
    version: 1,
    sessionId,
    sessionDir,
    repoPath: packResult.manifest.repoPath,
    initialTask: input.task,
    currentTask: input.task,
    budget: packResult.manifest.budget,
    createdAt: now,
    updatedAt: now,
    status: "WAITING_FOR_COACH",
    pendingRequests: [],
    deniedRequests: [],
    turns: [
      {
        turn,
        task: input.task,
        manifestPath,
        createdAt: now,
        included: packResult.manifest.included,
        omitted: packResult.manifest.omitted,
        totalCharacters: packResult.pack.length,
        requiresExpansionApproval: packResult.manifest.requiresExpansionApproval,
      },
    ],
    replies: [],
  };
  enforceSessionDisclosureBudget(state);
  await saveCoachSessionState(sessionStatePath, state);

  return {
    sessionId,
    sessionDir,
    sessionStatePath,
    pack: packResult.pack,
    packPath,
    manifestPath,
    state,
    requiresExpansionApproval: packResult.manifest.requiresExpansionApproval,
  };
}

export async function ingestCoachSessionReply(
  input: IngestCoachSessionInput,
): Promise<IngestCoachSessionResult> {
  const resolved = resolveCoachSession(input.session, input.env);
  const state = await readCoachSessionState(resolved.sessionStatePath);
  const replyMarkdown = await readFile(resolve(input.replyPath), "utf-8");
  const summary = parseCoachReply(replyMarkdown);
  const requestClassification = classifyContextRequests(
    state.repoPath,
    collectContextRequests(summary),
  );
  const replyTurn = state.replies.length + 1;

  const now = new Date().toISOString();
  const updatedState: CoachSessionState = {
    ...state,
    updatedAt: now,
    status: "READY_FOR_NEXT_PACK",
    pendingRequests: requestClassification.allowed,
    deniedRequests: [
      ...state.deniedRequests,
      ...requestClassification.denied.map((entry) => ({
        ...entry,
        createdAt: now,
      })),
    ],
    replies: [
      ...state.replies,
      {
        turn: replyTurn,
        replyPath: resolve(input.replyPath),
        createdAt: now,
        diagnosisCount: summary.diagnosis.length,
        referencedFileCount: summary.referencedFiles.length,
        nextReadCount: summary.proposedNextReads.length,
        patchPlanCount: summary.proposedPatchPlan.length,
        verificationCommandCount: summary.verificationCommands.length,
      },
    ],
  };
  await saveCoachSessionState(resolved.sessionStatePath, updatedState);

  return {
    ...resolved,
    summary,
    state: updatedState,
  };
}

export async function createNextCoachSessionPack(
  input: NextCoachSessionPackInput,
): Promise<NextCoachSessionPackResult> {
  const resolved = resolveCoachSession(input.session, input.env);
  const state = await readCoachSessionState(resolved.sessionStatePath);
  const task = input.task?.trim() || buildFollowupTask(state, state.pendingRequests);

  if (!task) {
    throw new Error(
      "No follow-up context available. Ingest a coach reply or pass --task.",
    );
  }

  const budget = input.budget ?? state.budget;
  const turn = state.turns.length + 1;
  const packResult = await buildCoachPack({
    repoPath: state.repoPath,
    task,
    budget,
    env: input.env,
  });
  const packPath = join(resolved.sessionDir, formatPackName(turn));
  const manifestPath = deriveManifestPath(packPath);
  await writeFile(
    manifestPath,
    JSON.stringify(packResult.manifest, null, 2),
    "utf-8",
  );

  const now = new Date().toISOString();
  const updatedState: CoachSessionState = {
    ...state,
    currentTask: task,
    budget: packResult.manifest.budget,
    updatedAt: now,
    status: "WAITING_FOR_COACH",
    pendingRequests: [],
    turns: [
      ...state.turns,
      {
        turn,
        task,
        manifestPath,
        createdAt: now,
        included: packResult.manifest.included,
        omitted: packResult.manifest.omitted,
        totalCharacters: packResult.pack.length,
        requiresExpansionApproval: packResult.manifest.requiresExpansionApproval,
      },
    ],
  };
  enforceSessionDisclosureBudget(updatedState);
  await saveCoachSessionState(resolved.sessionStatePath, updatedState);

  return {
    ...resolved,
    pack: packResult.pack,
    packPath,
    manifestPath,
    task,
    state: updatedState,
    requiresExpansionApproval: packResult.manifest.requiresExpansionApproval,
  };
}

export async function getCoachSessionStatus(
  session: string,
  env?: NodeJS.ProcessEnv,
): Promise<CoachSessionStatusSnapshot> {
  const resolved = resolveCoachSession(session, env);
  const state = await readCoachSessionState(resolved.sessionStatePath);

  return {
    ...resolved,
    state,
    usage: calculateSessionUsage(state),
  };
}

function buildFollowupTask(
  state: CoachSessionState,
  allowedPendingRequests: string[],
): string {
  if (allowedPendingRequests.length === 0) return "";

  const lines = [`Original task: ${state.initialTask}`];
  if (allowedPendingRequests.length > 0) {
    lines.push(`Requested next reads: ${allowedPendingRequests.join(", ")}`);
  }

  return lines.join("\n");
}

function resolveCoachSessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configuredStateDir = loadDevspaceFiles(env).config.stateDir;
  const baseDir =
    env.DEVSPACE_COACH_SESSION_DIR ??
    (configuredStateDir
      ? join(configuredStateDir, "coach-sessions")
      : join(devspaceConfigDir(env), "coach-sessions"));

  return resolve(expandHomePath(baseDir));
}

function resolveCoachSession(
  session: string,
  env: NodeJS.ProcessEnv = process.env,
): CoachSessionContext {
  const candidate = resolve(expandHomePath(session));
  const sessionDir = existsSync(candidate)
    ? candidate
    : join(resolveCoachSessionRoot(env), session);
  const sessionStatePath = join(sessionDir, "session.json");

  if (!existsSync(sessionStatePath)) {
    throw new Error(`Unknown coach session: ${session}`);
  }

  return {
    sessionId: sessionDir.split(/[\\/]/u).pop() ?? session,
    sessionDir,
    sessionStatePath,
  };
}

async function readCoachSessionState(
  sessionStatePath: string,
): Promise<CoachSessionState> {
  return JSON.parse(
    await readFile(sessionStatePath, "utf-8"),
  ) as CoachSessionState;
}

async function saveCoachSessionState(
  sessionStatePath: string,
  state: CoachSessionState,
): Promise<void> {
  await writeFile(sessionStatePath, JSON.stringify(state, null, 2), "utf-8");
}

function calculateSessionUsage(state: CoachSessionState): CoachSessionUsage {
  const uniqueFiles = new Set<string>();
  let totalCharacters = 0;

  for (const turn of state.turns) {
    totalCharacters += turn.totalCharacters;
    for (const entry of turn.included) {
      uniqueFiles.add(entry.path);
    }
  }

  return {
    packCount: state.turns.length,
    uniqueFileCount: uniqueFiles.size,
    totalCharacters,
  };
}

function enforceSessionDisclosureBudget(state: CoachSessionState): void {
  const usage = calculateSessionUsage(state);

  if (usage.packCount > MAX_SESSION_PACKS) {
    throw new Error(
      `Coach session exceeded max packs (${MAX_SESSION_PACKS}). Start a new session.`,
    );
  }
  if (usage.uniqueFileCount > MAX_SESSION_UNIQUE_FILES) {
    throw new Error(
      `Coach session exceeded max unique files (${MAX_SESSION_UNIQUE_FILES}). Start a new session.`,
    );
  }
  if (usage.totalCharacters > MAX_SESSION_CHARACTERS) {
    throw new Error(
      `Coach session exceeded max extracted characters (${MAX_SESSION_CHARACTERS}). Start a new session.`,
    );
  }
}

function collectContextRequests(summary: CoachReplySummary): string[] {
  const requests = [
    ...summary.proposedNextReads,
    ...summary.referencedFiles.map((entry) =>
      entry.line ? `${entry.path}:${entry.line}` : entry.path,
    ),
  ];

  return Array.from(
    new Set(requests.map((entry) => entry.trim()).filter(Boolean)),
  );
}

function classifyContextRequests(
  repoPath: string,
  requests: string[],
): {
  allowed: string[];
  denied: Array<{ request: string; reason: string }>;
} {
  const allowed: string[] = [];
  const denied: Array<{ request: string; reason: string }> = [];

  for (const request of requests) {
    const normalized = normalizeRequestedPath(request);
    if (!normalized) continue;

    const deniedReason = getDeniedRequestReason(repoPath, normalized);
    if (deniedReason) {
      denied.push({ request, reason: deniedReason });
      continue;
    }

    allowed.push(normalized);
  }

  return {
    allowed: Array.from(new Set(allowed)),
    denied,
  };
}

function normalizeRequestedPath(request: string): string {
  return request
    .trim()
    .replace(/^`(.+)`$/u, "$1")
    .replace(/:(\d+)$/u, "")
    .replaceAll("\\", "/");
}

function getDeniedRequestReason(
  repoPath: string,
  request: string,
): string | null {
  const lowerRequest = request.toLowerCase();
  if (lowerRequest.includes("skill")) {
    return "Skills are not available in coach-session mode";
  }
  if (basename(lowerRequest) === "agents.md") {
    return "AGENTS.md is not included by default in coach-session mode";
  }
  if (request.includes("..")) {
    return "Parent-path traversal is not allowed";
  }
  if (createSensitiveOmission(request)) {
    return "Sensitive path request denied";
  }
  if (looksAbsolutePath(request)) {
    const absolutePath = resolve(request);
    const relativePath = relative(repoPath, absolutePath);
    if (relativePath.startsWith("..") || relativePath.includes(":")) {
      return "Outside-root path request denied";
    }
  }

  return null;
}

function looksAbsolutePath(request: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(request) || request.startsWith("/");
}

function createSessionId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/gu, "")
    .slice(0, 14);
  return `coach-${timestamp}-${randomBytes(3).toString("hex")}`;
}

function formatPackName(turn: number): string {
  return `pack-${formatTurn(turn)}.md`;
}

function formatTurn(turn: number): string {
  return String(turn).padStart(3, "0");
}

function deriveManifestPath(packPath: string): string {
  return packPath.replace(/\.md$/u, ".manifest.json");
}
