import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = join(
  dirname(require.resolve("tsx/package.json")),
  "dist",
  "cli.mjs",
);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "devspace-coach-commands-test-"));

async function writeFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await mkdir(join(repoRoot, "credentials"), { recursive: true });
  await mkdir(join(repoRoot, ".trae"), { recursive: true });
  await mkdir(join(repoRoot, "docs"), { recursive: true });
  await writeFile(
    join(repoRoot, "AGENTS.md"),
    [
      "# Repo Instructions",
      "",
      "- Prefer coach-pack for manual context bridging.",
      "- Keep bridge mode read-only.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "README.md"),
    [
      "# DevSpace Fixture",
      "",
      "This fixture explains how coach pack can summarize local code context.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "docs", "collaboration-workflow.md"),
    [
      "# Collaboration Workflow",
      "",
      "bridge read-only boundary bridge read-only boundary",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "src", "coach.ts"),
    [
      "export function describeCoachPack(): string {",
      '  return "coach pack reads local code and prepares context";',
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "src", "config.ts"),
    [
      "export const coachConfig = {",
      "  mode: 'read-only',",
      "  budget: 4000,",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, ".env"),
    "OPENAI_API_KEY=sk-test-should-not-leak\n",
  );
  await writeFile(
    join(repoRoot, ".trae", "notes.md"),
    [
      "# Bridge Notes",
      "",
      "read-only boundary bridge bridge bridge",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, ".env.production"),
    "OPENAI_API_KEY=sk-test-should-not-leak-again\n",
  );
  await writeFile(
    join(repoRoot, "credentials", "client.key"),
    "very-secret-key\n",
  );
}

async function writeRankingFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, "src", "bridge"), { recursive: true });
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await mkdir(join(repoRoot, "docs"), { recursive: true });
  await mkdir(join(repoRoot, "reports"), { recursive: true });
  await writeFile(
    join(repoRoot, "AGENTS.md"),
    [
      "# Ranking Fixture",
      "",
      "- Explain code boundaries from source first.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "src", "coach-commands.test.ts"),
    [
      "test('Explain bridge read-only boundary', () => {",
      "  expect(true).toBe(true);",
      "});",
      "",
    ].join("\n"),
  );

  const largeBridgeSource = [
    "export function buildBridgeBoundarySummary(): string {",
    "  return READ_ONLY_BOUNDARY;",
    "}",
    "",
    ...Array.from(
      { length: 120 },
      (_, index) => `const bridgePaddingBefore${index} = ${index};`,
    ),
    "export const READ_ONLY_BOUNDARY = 'bridge read-only boundary';",
    ...Array.from(
      { length: 120 },
      (_, index) => `const bridgePaddingAfter${index} = ${index};`,
    ),
    "",
  ].join("\n");

  await writeFile(
    join(repoRoot, "src", "bridge", "context-pack.ts"),
    largeBridgeSource,
  );
  await writeFile(
    join(repoRoot, "src", "bridge", "policy.ts"),
    [
      "export const boundaryPolicy = {",
      "  mode: 'read-only',",
      "  area: 'bridge',",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "src", "bridge", "commands.ts"),
    [
      'import { buildBridgeBoundarySummary } from "./context-pack.js";',
      "",
      "export async function runBridgeCommand(): Promise<string> {",
      "  return buildBridgeBoundarySummary();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "docs", "local-coach-bridge.md"),
    [
      "# Local Coach Bridge",
      "",
      "bridge read-only boundary",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "reports", "final_self_audit.md"),
    [
      "# Final Audit",
      "",
      "bridge read-only boundary",
      "",
    ].join("\n"),
  );
}

async function writePreciseBudgetFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, "src", "bridge"), { recursive: true });
  await writeFile(
    join(repoRoot, "src", "bridge", "boundary.ts"),
    [
      "export const bridgeBoundary = {",
      "  mode: 'read-only',",
      "  summary: 'bridge boundary',",
      "};",
      "",
    ].join("\n"),
  );
}

async function writeEnvExampleFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await writeFile(
    join(repoRoot, ".env.example"),
    [
      "API_BASE_URL=https://example.test",
      "FEATURE_FLAG_BRIDGE=true",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repoRoot, "src", "config.ts"),
    [
      "export const exampleConfigPath = '.env.example';",
      "",
    ].join("\n"),
  );
}

function extractLineValue(output: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^${escapedLabel}:\\s+(.+)$`, "mu").exec(output);
  assert.ok(match, `Expected output line for ${label}`);
  return match[1]!.trim();
}

function extractCoachPack(output: string): string {
  const match =
    /----- BEGIN COACH PACK -----\r?\n([\s\S]*?)\r?\n----- END COACH PACK -----/u.exec(
      output,
    );
  assert.ok(match, "Expected coach pack block in command output");
  return match[1]!;
}

try {
  const repoRoot = join(root, "repo");
  const outsideRoot = join(root, "outside");
  const packPath = join(root, "coach_pack.md");
  const manifestPath = join(root, "coach_pack.manifest.json");
  const replyPath = join(root, "coach_reply.md");

  await writeFixtureRepo(repoRoot);
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(outsideRoot, "secret.ts"), "export const secret = 1;\n");

  const packResult = await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      repoRoot,
      "--task",
      "Explain how coach pack reads config and source files",
      "--budget",
      "4000",
      "--out",
      packPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: repoRoot,
      },
    },
  );

  assert.match(packResult.stdout, /coach_pack\.md/i);

  const pack = await readFile(packPath, "utf-8");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

  assert.match(pack, /Explain how coach pack reads config and source files/);
  assert.match(pack, /src\/coach\.ts|src\\coach\.ts/);
  assert.match(pack, /src\/config\.ts|src\\config\.ts/);
  assert.doesNotMatch(pack, /OPENAI_API_KEY/);
  assert.doesNotMatch(pack, /\.trae\/notes\.md|\.trae\\notes\.md/);
  assert.doesNotMatch(pack, /\.env\.production/);
  assert.doesNotMatch(pack, /client\.key/);

  assert.equal(manifest.repoPath, repoRoot);
  assert.equal(manifest.task, "Explain how coach pack reads config and source files");
  assert.equal(Array.isArray(manifest.included), true);
  assert.equal(manifest.included.length > 0, true);
  assert.equal(
    manifest.omitted.every(
      (entry: { path: string }) =>
        !entry.path.includes(".env.production") &&
        !entry.path.includes("client.key"),
    ),
    true,
  );
  assert.equal(
    manifest.omitted.some(
      (entry: { path: string; reason: string }) =>
        /redacted/i.test(entry.path) &&
        /Sensitive file matched but omitted/i.test(entry.reason),
    ),
    true,
  );

  const tinyBudgetRepo = join(root, "tiny-budget-repo");
  await mkdir(tinyBudgetRepo, { recursive: true });
  for (let index = 0; index < 8; index += 1) {
    await writeFile(
      join(tinyBudgetRepo, `.env.${index}`),
      `SECRET_${index}=value\n`,
    );
  }
  const tinyBudgetPackPath = join(root, "tiny_budget_pack.md");
  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      tinyBudgetRepo,
      "--task",
      "nohits",
      "--budget",
      "200",
      "--out",
      tinyBudgetPackPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: `${repoRoot},${tinyBudgetRepo}`,
      },
    },
  );
  const tinyBudgetPack = await readFile(tinyBudgetPackPath, "utf-8");
  assert.equal(tinyBudgetPack.length <= 200, true);

  const longTaskPackPath = join(root, "long_task_pack.md");
  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      tinyBudgetRepo,
      "--task",
      "x".repeat(500),
      "--budget",
      "200",
      "--out",
      longTaskPackPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: `${repoRoot},${tinyBudgetRepo}`,
      },
    },
  );
  const longTaskPack = await readFile(longTaskPackPath, "utf-8");
  assert.equal(longTaskPack.length <= 200, true);

  const rankingPackPath = join(root, "ranking_pack.md");
  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      repoRoot,
      "--task",
      "Explain bridge read-only boundary",
      "--budget",
      "650",
      "--out",
      rankingPackPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: repoRoot,
      },
    },
  );
  const rankingPack = await readFile(rankingPackPath, "utf-8");
  assert.match(rankingPack, /src\/config\.ts|src\\config\.ts/);
  assert.doesNotMatch(
    rankingPack,
    /docs\/collaboration-workflow\.md|docs\\collaboration-workflow\.md/,
  );
  assert.doesNotMatch(rankingPack, /\.trae\/notes\.md|\.trae\\notes\.md/);

  const realisticRankingRepoRoot = join(root, "ranking-repo");
  await writeRankingFixtureRepo(realisticRankingRepoRoot);
  const realisticRankingPackPath = join(root, "realistic_ranking_pack.md");
  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      realisticRankingRepoRoot,
      "--task",
      "Explain bridge read-only boundary",
      "--budget",
      "1500",
      "--out",
      realisticRankingPackPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: `${repoRoot},${realisticRankingRepoRoot}`,
      },
    },
  );
  const realisticRankingPack = await readFile(realisticRankingPackPath, "utf-8");
  assert.match(
    realisticRankingPack,
    /src\/bridge\/context-pack\.ts|src\\bridge\\context-pack\.ts/,
  );
  assert.doesNotMatch(
    realisticRankingPack,
    /src\/coach-commands\.test\.ts|src\\coach-commands\.test\.ts/,
  );
  assert.doesNotMatch(
    realisticRankingPack,
    /src\/bridge\/commands\.ts|src\\bridge\\commands\.ts/,
  );
  assert.doesNotMatch(
    realisticRankingPack,
    /reports\/final_self_audit\.md|reports\\final_self_audit\.md/,
  );

  const singleSlotRankingPackPath = join(root, "single_slot_ranking_pack.md");
  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      realisticRankingRepoRoot,
      "--task",
      "Explain bridge read-only boundary",
      "--budget",
      "700",
      "--out",
      singleSlotRankingPackPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: `${repoRoot},${realisticRankingRepoRoot}`,
      },
    },
  );
  const singleSlotRankingPack = await readFile(singleSlotRankingPackPath, "utf-8");
  assert.match(
    singleSlotRankingPack,
    /src\/bridge\/context-pack\.ts|src\\bridge\\context-pack\.ts/,
  );
  assert.doesNotMatch(
    singleSlotRankingPack,
    /src\/bridge\/commands\.ts|src\\bridge\\commands\.ts/,
  );

  const preciseBudgetRepoRoot = join(root, "precise-budget-repo");
  await writePreciseBudgetFixtureRepo(preciseBudgetRepoRoot);
  const baselineBudgetPackPath = join(root, "baseline_budget_pack.md");
  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      preciseBudgetRepoRoot,
      "--task",
      "Explain bridge read-only boundary",
      "--budget",
      "1200",
      "--out",
      baselineBudgetPackPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: `${repoRoot},${realisticRankingRepoRoot},${preciseBudgetRepoRoot}`,
      },
    },
  );
  const baselineBudgetPack = await readFile(baselineBudgetPackPath, "utf-8");
  const tightBudgetPackPath = join(root, "tight_budget_included_pack.md");
  const tightBudget = Math.max(1, baselineBudgetPack.length - 1);
  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      preciseBudgetRepoRoot,
      "--task",
      "Explain bridge read-only boundary",
      "--budget",
      String(tightBudget),
      "--out",
      tightBudgetPackPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: `${repoRoot},${realisticRankingRepoRoot},${preciseBudgetRepoRoot}`,
      },
    },
  );
  const tightBudgetPack = await readFile(tightBudgetPackPath, "utf-8");
  assert.equal(tightBudgetPack.length <= tightBudget, true);

  const envExampleRepoRoot = join(root, "env-example-repo");
  await writeEnvExampleFixtureRepo(envExampleRepoRoot);
  const envExamplePackPath = join(root, "env_example_pack.md");
  const envExampleManifestPath = join(root, "env_example_pack.manifest.json");
  await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-pack",
      "--path",
      envExampleRepoRoot,
      "--task",
      "Explain env example defaults",
      "--budget",
      "1200",
      "--out",
      envExamplePackPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: `${repoRoot},${realisticRankingRepoRoot},${preciseBudgetRepoRoot},${envExampleRepoRoot}`,
      },
    },
  );
  const envExamplePack = await readFile(envExamplePackPath, "utf-8");
  const envExampleManifest = JSON.parse(await readFile(envExampleManifestPath, "utf-8"));
  assert.match(envExamplePack, /\.env\.example/);
  assert.equal(
    envExampleManifest.omitted.some(
      (entry: { reason: string }) =>
        /Sensitive file matched but omitted \(.env-family\)/i.test(entry.reason),
    ),
    false,
  );

  const coachSessionRoot = join(root, "coach-sessions");
  const coachSessionRepoRoot = join(root, "coach-session-repo");
  await writeFixtureRepo(coachSessionRepoRoot);
  const sessionStartResult = await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-session",
      "start",
      "--path",
      coachSessionRepoRoot,
      "--task",
      "Explain how coach pack reads config and source files",
      "--budget",
      "1200",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: coachSessionRepoRoot,
        DEVSPACE_COACH_SESSION_DIR: coachSessionRoot,
      },
    },
  );
  const sessionId = extractLineValue(sessionStartResult.stdout, "Created coach session");
  const sessionDir = extractLineValue(sessionStartResult.stdout, "Session dir");
  const sessionStatePath = join(sessionDir, "session.json");
  const initialPackPath = join(sessionDir, "pack-001.md");
  const initialManifestPath = join(sessionDir, "pack-001.manifest.json");
  const initialPack = extractCoachPack(sessionStartResult.stdout);
  const initialSessionState = JSON.parse(await readFile(sessionStatePath, "utf-8"));
  assert.equal(initialSessionState.sessionId, sessionId);
  assert.equal(initialSessionState.repoPath, coachSessionRepoRoot);
  assert.equal(initialSessionState.status, "WAITING_FOR_COACH");
  assert.equal(initialSessionState.turns.length, 1);
  assert.equal(existsSync(initialPackPath), false);
  assert.match(initialPack, /src\/coach\.ts|src\\coach\.ts/);
  assert.equal(JSON.parse(await readFile(initialManifestPath, "utf-8")).task.length > 0, true);

  const sessionReplyPath = join(root, "session_reply.md");
  await writeFile(
    sessionReplyPath,
    [
      "# Coach Reply",
      "",
      "## Diagnosis",
      "- The current context is enough for a follow-up pack.",
      "",
      "## Next Reads",
      "- src/config.ts",
      "- README.md",
      "",
      "## Patch Plan",
      "- Compare config defaults with README docs.",
      "",
    ].join("\n"),
  );

  const sessionIngestResult = await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-session",
      "ingest",
      "--session",
      sessionId,
      sessionReplyPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: coachSessionRepoRoot,
        DEVSPACE_COACH_SESSION_DIR: coachSessionRoot,
      },
    },
  );
  const ingestedSessionState = JSON.parse(await readFile(sessionStatePath, "utf-8"));
  assert.equal(ingestedSessionState.status, "READY_FOR_NEXT_PACK");
  assert.equal(ingestedSessionState.replies.length, 1);
  assert.equal(
    sessionIngestResult.stdout.includes(
      "Reply summary not persisted by default. Pass --out <file> to save it.",
    ),
    true,
  );
  assert.equal(existsSync(join(sessionDir, "reply-001.summary.json")), false);

  const sessionStatusResult = await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-session",
      "status",
      "--session",
      sessionId,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: coachSessionRepoRoot,
        DEVSPACE_COACH_SESSION_DIR: coachSessionRoot,
      },
    },
  );
  const sessionStatus = JSON.parse(sessionStatusResult.stdout);
  assert.equal(sessionStatus.sessionId, sessionId);
  assert.equal(sessionStatus.status, "READY_FOR_NEXT_PACK");
  assert.deepEqual(sessionStatus.pendingRequests, ["src/config.ts", "README.md"]);
  assert.deepEqual(sessionStatus.usage, {
    packCount: 1,
    uniqueFileCount: initialSessionState.turns[0].included.length,
    totalCharacters: initialSessionState.turns[0].totalCharacters,
  });
  assert.equal(sessionStatus.replies[0].diagnosisCount, 1);
  assert.equal(sessionStatus.replies[0].nextReadCount, 2);
  assert.equal(
    sessionStatusResult.stdout.includes(
      "Compare config defaults with README docs.",
    ),
    false,
  );
  assert.equal(
    sessionStatusResult.stdout.includes(
      "The current context is enough for a follow-up pack.",
    ),
    false,
  );

  const nextPackResult = await execFileAsync(
    process.execPath,
    [
      tsxCliPath,
      cliPath,
      "coach-session",
      "next-pack",
      "--session",
      sessionId,
      "--out",
      join(root, "next_session_pack.md"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DEVSPACE_ALLOWED_ROOTS: coachSessionRepoRoot,
        DEVSPACE_COACH_SESSION_DIR: coachSessionRoot,
      },
    },
  );
  const nextPackPath = extractLineValue(nextPackResult.stdout, "Wrote pack");
  const nextManifestPath = extractLineValue(nextPackResult.stdout, "Wrote manifest");
  const nextPack = await readFile(nextPackPath, "utf-8");
  const finalSessionState = JSON.parse(await readFile(sessionStatePath, "utf-8"));
  assert.match(nextPack, /src\/config\.ts|src\\config\.ts/);
  assert.equal(finalSessionState.turns.length, 2);
  assert.equal(finalSessionState.status, "WAITING_FOR_COACH");
  assert.equal(JSON.parse(await readFile(nextManifestPath, "utf-8")).task.includes("src/config.ts"), true);

  let deniedError: Error | undefined;
  try {
    await execFileAsync(
      process.execPath,
      [
        tsxCliPath,
        cliPath,
        "coach-pack",
        "--path",
        outsideRoot,
        "--task",
        "Explain outside root",
        "--budget",
        "4000",
        "--out",
        join(root, "outside_pack.md"),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DEVSPACE_ALLOWED_ROOTS: repoRoot,
        },
      },
    );
  } catch (error) {
    deniedError = error as Error;
  }
  assert.ok(deniedError);
  assert.match(String(deniedError), /outside allowed roots/i);

  await writeFile(
    replyPath,
    [
      "# Coach Reply",
      "",
      "## Diagnosis",
      "- The current context pack is missing one config edge case.",
      "",
      "## Referenced Files",
      "- src/config.ts:2",
      "- src/coach.ts:1",
      "",
      "## Next Reads",
      "- src/config.ts",
      "- AGENTS.md",
      "",
      "## Patch Plan",
      "- Add a stricter denylist helper.",
      "- Keep manifest metadata only.",
      "",
      "## Verification",
      "```bash",
      "rtk npm test",
      "rtk npm run lint",
      "```",
      "",
    ].join("\n"),
  );

  const ingestResult = await execFileAsync(
    process.execPath,
    [tsxCliPath, cliPath, "coach-ingest", replyPath],
    { cwd: root },
  );
  const ingest = JSON.parse(ingestResult.stdout);

  assert.deepEqual(ingest.diagnosis, [
    "The current context pack is missing one config edge case.",
  ]);
  assert.deepEqual(ingest.referencedFiles, [
    { path: "src/config.ts", line: 2 },
    { path: "src/coach.ts", line: 1 },
  ]);
  assert.deepEqual(ingest.proposedNextReads, ["src/config.ts", "AGENTS.md"]);
  assert.deepEqual(ingest.proposedPatchPlan, [
    "Add a stricter denylist helper.",
    "Keep manifest metadata only.",
  ]);
  assert.deepEqual(ingest.verificationCommands, [
    "rtk npm test",
    "rtk npm run lint",
  ]);

  await writeFile(
    replyPath,
    [
      "# Coach Reply",
      "",
      "## Referenced Files",
      "- Dockerfile",
      "- docs/Plan (draft).md:9",
      "- My Folder/My Notes.md:12",
      "- .gitignore",
      "",
      "## Verification",
      "- rtk npm test",
      "",
    ].join("\n"),
  );

  const orderedOutPath = join(root, "ingest_summary.json");
  const reorderedIngest = await execFileAsync(
    process.execPath,
    [tsxCliPath, cliPath, "coach-ingest", "--out", orderedOutPath, replyPath],
    { cwd: root },
  );
  const reorderedSummary = JSON.parse(reorderedIngest.stdout);
  assert.deepEqual(reorderedSummary.referencedFiles, [
    { path: "Dockerfile" },
    { path: "docs/Plan (draft).md", line: 9 },
    { path: "My Folder/My Notes.md", line: 12 },
    { path: ".gitignore" },
  ]);
  assert.deepEqual(reorderedSummary.verificationCommands, ["rtk npm test"]);
  assert.equal(JSON.parse(await readFile(orderedOutPath, "utf-8")).referencedFiles.length, 4);
} finally {
  await rm(root, { recursive: true, force: true });
}
