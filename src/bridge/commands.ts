import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { buildCoachPack } from "./context-pack.js";
import { parseCoachReply } from "./ingest.js";
import {
  createNextCoachSessionPack,
  getCoachSessionStatus,
  ingestCoachSessionReply,
  startCoachSession,
} from "./session.js";

export async function runCoachPackCommand(args: string[]): Promise<void> {
  const repoPath = requireOption(args, "--path");
  const task = requireOption(args, "--task");
  const outPath = resolve(requireOption(args, "--out"));
  const budgetValue = getOption(args, "--budget");
  const budget = budgetValue ? parsePositiveInteger(budgetValue, "--budget") : undefined;

  const result = await buildCoachPack({
    repoPath,
    task,
    budget,
  });

  const manifestPath = deriveManifestPath(outPath);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, result.pack, "utf-8");
  await writeFile(manifestPath, JSON.stringify(result.manifest, null, 2), "utf-8");

  console.log(`Wrote coach pack: ${outPath}`);
  console.log(`Wrote manifest: ${manifestPath}`);
  if (result.manifest.requiresExpansionApproval) {
    console.log("Pack hit a default ceiling; narrow the task or approve expansion.");
  }
}

export async function runCoachIngestCommand(args: string[]): Promise<void> {
  const replyPath = extractReplyPath(args, ["--out"]);
  if (!replyPath) {
    throw new Error("Missing coach reply path. Use: devspace coach-ingest <reply.md>");
  }

  const outPath = getOption(args, "--out");
  const markdown = await readFile(resolve(replyPath), "utf-8");
  const summary = parseCoachReply(markdown);
  const output = JSON.stringify(summary, null, 2);

  if (outPath) {
    const absoluteOutPath = resolve(outPath);
    await mkdir(dirname(absoluteOutPath), { recursive: true });
    await writeFile(absoluteOutPath, output, "utf-8");
  }

  process.stdout.write(output);
}

export async function runCoachSessionCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "start":
      await runCoachSessionStart(rest);
      return;
    case "ingest":
      await runCoachSessionIngest(rest);
      return;
    case "next-pack":
      await runCoachSessionNextPack(rest);
      return;
    case "status":
      await runCoachSessionStatus(rest);
      return;
    default:
      throw new Error(
        "Unknown coach-session command. Use 'start', 'ingest', 'next-pack', or 'status'.",
      );
  }
}

function getOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function requireOption(args: string[], name: string): string {
  const value = getOption(args, name)?.trim();
  if (!value) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${flagName} value: ${value}`);
  }
  return parsed;
}

async function runCoachSessionStart(args: string[]): Promise<void> {
  const repoPath = requireOption(args, "--path");
  const task = requireOption(args, "--task");
  const outPath = getOption(args, "--out");
  const budgetValue = getOption(args, "--budget");
  const budget = budgetValue ? parsePositiveInteger(budgetValue, "--budget") : undefined;
  const result = await startCoachSession({
    repoPath,
    task,
    budget,
    env: process.env,
  });

  console.log(`Created coach session: ${result.sessionId}`);
  console.log(`Session dir: ${result.sessionDir}`);
  console.log(`Session state: ${result.sessionStatePath}`);
  console.log(`Wrote manifest: ${result.manifestPath}`);
  await emitCoachPack(result.pack, outPath, result.packPath);
  if (result.requiresExpansionApproval) {
    console.log("Pack hit a default ceiling; narrow the task or approve expansion.");
  }
}

async function runCoachSessionIngest(args: string[]): Promise<void> {
  const session = requireOption(args, "--session");
  const outPath = getOption(args, "--out");
  const replyPath = extractReplyPath(args, ["--session", "--out"]);
  if (!replyPath) {
    throw new Error(
      "Missing coach reply path. Use: devspace coach-session ingest --session <id> <reply.md>",
    );
  }

  const result = await ingestCoachSessionReply({
    session,
    replyPath,
    env: process.env,
  });
  console.log(`Updated coach session: ${result.sessionId}`);
  console.log(`Session dir: ${result.sessionDir}`);
  console.log(`Session state: ${result.sessionStatePath}`);
  if (outPath) {
    const absoluteOutPath = resolve(outPath);
    await mkdir(dirname(absoluteOutPath), { recursive: true });
    await writeFile(
      absoluteOutPath,
      JSON.stringify(result.summary, null, 2),
      "utf-8",
    );
    console.log(`Wrote reply summary: ${absoluteOutPath}`);
  } else {
    console.log("Reply summary not persisted by default. Pass --out <file> to save it.");
  }
}

async function runCoachSessionNextPack(args: string[]): Promise<void> {
  const session = requireOption(args, "--session");
  const task = getOption(args, "--task");
  const outPath = getOption(args, "--out");
  const budgetValue = getOption(args, "--budget");
  const budget = budgetValue ? parsePositiveInteger(budgetValue, "--budget") : undefined;
  const result = await createNextCoachSessionPack({
    session,
    task,
    budget,
    env: process.env,
  });
  console.log(`Updated coach session: ${result.sessionId}`);
  console.log(`Session dir: ${result.sessionDir}`);
  console.log(`Session state: ${result.sessionStatePath}`);
  console.log(`Wrote manifest: ${result.manifestPath}`);
  await emitCoachPack(result.pack, outPath, result.packPath);
  if (result.requiresExpansionApproval) {
    console.log("Pack hit a default ceiling; narrow the task or approve expansion.");
  }
}

async function runCoachSessionStatus(args: string[]): Promise<void> {
  const session = requireOption(args, "--session");
  const snapshot = await getCoachSessionStatus(session, process.env);
  const output = {
    sessionId: snapshot.sessionId,
    sessionDir: snapshot.sessionDir,
    sessionStatePath: snapshot.sessionStatePath,
    repoPath: snapshot.state.repoPath,
    initialTask: snapshot.state.initialTask,
    budget: snapshot.state.budget,
    createdAt: snapshot.state.createdAt,
    updatedAt: snapshot.state.updatedAt,
    status: snapshot.state.status,
    usage: snapshot.usage,
    pendingRequests: snapshot.state.pendingRequests,
    deniedRequests: snapshot.state.deniedRequests,
    turns: snapshot.state.turns.map((turn) => ({
      turn: turn.turn,
      task: turn.task,
      manifestPath: turn.manifestPath,
      createdAt: turn.createdAt,
      includedCount: turn.included.length,
      omittedCount: turn.omitted.length,
      totalCharacters: turn.totalCharacters,
      requiresExpansionApproval: turn.requiresExpansionApproval,
    })),
    replies: snapshot.state.replies.map((reply) => ({
      turn: reply.turn,
      replyPath: reply.replyPath,
      createdAt: reply.createdAt,
      diagnosisCount: reply.diagnosisCount,
      referencedFileCount: reply.referencedFileCount,
      nextReadCount: reply.nextReadCount,
      patchPlanCount: reply.patchPlanCount,
      verificationCommandCount: reply.verificationCommandCount,
    })),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function emitCoachPack(
  pack: string,
  outPath: string | undefined,
  defaultPackPath: string,
): Promise<void> {
  if (outPath) {
    const absoluteOutPath = resolve(outPath);
    await mkdir(dirname(absoluteOutPath), { recursive: true });
    await writeFile(absoluteOutPath, pack, "utf-8");
    console.log(`Wrote pack: ${absoluteOutPath}`);
    return;
  }

  console.log("Pack is not persisted by default. Copy the pack below or pass --out <file>.");
  console.log(`Suggested pack path: ${defaultPackPath}`);
  process.stdout.write("----- BEGIN COACH PACK -----\n");
  process.stdout.write(pack);
  if (!pack.endsWith("\n")) {
    process.stdout.write("\n");
  }
  process.stdout.write("----- END COACH PACK -----\n");
}

function deriveManifestPath(outPath: string): string {
  const extension = extname(outPath);
  if (!extension) {
    return `${outPath}.manifest.json`;
  }

  return `${outPath.slice(0, -extension.length)}.manifest.json`;
}

function extractReplyPath(
  args: string[],
  optionFlagsToSkip: string[],
): string | undefined {
  const skipFlags = new Set(optionFlagsToSkip);
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current) continue;
    if (skipFlags.has(current)) {
      index += 1;
      continue;
    }
    if (!current.startsWith("-")) return current;
  }

  return undefined;
}
