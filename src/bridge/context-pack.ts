import { opendir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { assertAllowedPath } from "../roots.js";
import {
  createSensitiveOmission,
  isDeniedDirectoryName,
  isLikelyTextFile,
  loadCoachPackPolicy,
  loadRepoIgnoreRules,
  shouldIgnoreRepoPath,
  type CoachPackPolicy,
  type OmittedEntry,
} from "./policy.js";

export interface CoachPackInput {
  repoPath: string;
  task: string;
  budget?: number;
  env?: NodeJS.ProcessEnv;
}

export interface IncludedEntry {
  path: string;
  lineStart: number;
  lineEnd: number;
  reason: string;
  characters: number;
}

export interface CoachPackManifest {
  version: number;
  generatedAt: string;
  repoPath: string;
  task: string;
  budget: number;
  limits: {
    maxFiles: number;
    maxLinesPerFile: number;
    maxTotalCharacters: number;
  };
  included: IncludedEntry[];
  omitted: OmittedEntry[];
  requiresExpansionApproval: boolean;
}

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
  content: string;
  reason: string;
  score: number;
}

export interface BuiltCoachPack {
  pack: string;
  manifest: CoachPackManifest;
}

interface TaskProfile {
  wantsTests: boolean;
  wantsDocs: boolean;
  wantsReports: boolean;
  prefersSource: boolean;
}

export async function buildCoachPack(
  input: CoachPackInput,
): Promise<BuiltCoachPack> {
  const policy = loadCoachPackPolicy(input.env);
  const repoPath = assertAllowedPath(input.repoPath, policy.allowedRoots);
  const budget = normalizeBudget(input.budget, policy);
  const keywords = extractKeywords(input.task);
  const taskProfile = analyzeTaskProfile(input.task, keywords);
  const ignoreRules = loadRepoIgnoreRules(repoPath);
  const candidates: CandidateFile[] = [];
  const omitted: OmittedEntry[] = [];

  await walkRepo(
    repoPath,
    repoPath,
    ignoreRules,
    candidates,
    omitted,
    keywords,
    taskProfile,
  );

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.relativePath.localeCompare(right.relativePath);
  });

  const manifest: CoachPackManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoPath,
    task: input.task,
    budget,
    limits: {
      maxFiles: policy.maxFiles,
      maxLinesPerFile: policy.maxLinesPerFile,
      maxTotalCharacters: budget,
    },
    included: [],
    omitted,
    requiresExpansionApproval: false,
  };

  const header = buildPackHeader(repoPath, input.task, budget);
  if (header.truncatedTask) {
    manifest.requiresExpansionApproval = true;
  }
  const sections: string[] = [header.text];

  let consumedCharacters = sections.join("\n").length;

  for (const candidate of candidates) {
    if (manifest.included.length >= policy.maxFiles) {
      manifest.requiresExpansionApproval = true;
      manifest.omitted.push({
        path: candidate.relativePath,
        reason: "File ceiling reached; explicit expansion approval required",
      });
      continue;
    }

    const selection = selectFittingSnippet(
      candidate,
      keywords,
      policy.maxLinesPerFile,
      sections,
      budget,
    );
    if (!selection) {
      manifest.requiresExpansionApproval = true;
      manifest.omitted.push({
        path: candidate.relativePath,
        reason: "Character ceiling reached; explicit expansion approval required",
      });
      continue;
    }

    sections.push(selection.text);
    sections.push("");
    consumedCharacters = sections.join("\n").length;
    manifest.included.push({
      path: candidate.relativePath,
      lineStart: selection.snippet.lineStart,
      lineEnd: selection.snippet.lineEnd,
      reason: candidate.reason,
      characters: selection.text.length,
    });
  }

  let pack = sections.join("\n");
  const omittedSummary = renderOmittedSummary(manifest.omitted);
  if (omittedSummary) {
    const separator = pack.endsWith("\n") ? "" : "\n";
    if (pack.length + separator.length + omittedSummary.length <= budget) {
      pack += `${separator}${omittedSummary}`;
    } else {
      manifest.requiresExpansionApproval = true;
      const compactNotice = "Omitted summary truncated to stay within budget.";
      if (pack.length + separator.length + compactNotice.length <= budget) {
        pack += `${separator}${compactNotice}`;
      }
    }
  }

  if (manifest.included.length === 0) {
    const emptyNotice =
      "No eligible files were selected. Narrow the task or approve a larger pack.";
    const separator = pack.endsWith("\n") ? "" : "\n";
    if (pack.length + separator.length + emptyNotice.length <= budget) {
      pack += `${separator}${emptyNotice}`;
    } else {
      manifest.requiresExpansionApproval = true;
    }
  }

  return {
    pack,
    manifest,
  };
}

function normalizeBudget(
  budget: number | undefined,
  policy: CoachPackPolicy,
): number {
  if (budget === undefined) return policy.maxTotalCharacters;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error(`Invalid --budget value: ${budget}`);
  }
  return Math.min(budget, policy.maxTotalCharacters);
}

async function walkRepo(
  repoRoot: string,
  currentDir: string,
  ignoreRules: ReturnType<typeof loadRepoIgnoreRules>,
  candidates: CandidateFile[],
  omitted: OmittedEntry[],
  keywords: string[],
  taskProfile: TaskProfile,
): Promise<void> {
  const entries = await opendir(currentDir);

  for await (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    const relativePath = relative(repoRoot, absolutePath).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      if (isDeniedDirectoryName(entry.name)) continue;
      if (shouldIgnoreRepoPath(relativePath, true, ignoreRules)) continue;
      await walkRepo(
        repoRoot,
        absolutePath,
        ignoreRules,
        candidates,
        omitted,
        keywords,
        taskProfile,
      );
      continue;
    }

    if (!entry.isFile()) continue;
    if (shouldIgnoreRepoPath(relativePath, false, ignoreRules)) continue;

    const sensitiveOmission = createSensitiveOmission(relativePath);
    if (sensitiveOmission) {
      omitted.push(sensitiveOmission);
      continue;
    }

    if (!isLikelyTextFile(relativePath)) continue;

    const content = await readFile(absolutePath, "utf-8");
    const score = scoreCandidate(relativePath, content, keywords, taskProfile);
    if (score <= 0) continue;

    candidates.push({
      absolutePath,
      relativePath,
      content,
      reason: buildReason(relativePath, keywords),
      score,
    });
  }
}

function extractKeywords(task: string): string[] {
  const lowerTask = task.toLowerCase();
  const latinTokens = lowerTask.match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? [];
  const cjkTokens = task.match(/[\u4e00-\u9fff]{2,}/gu) ?? [];
  return Array.from(new Set([...latinTokens, ...cjkTokens]));
}

function analyzeTaskProfile(task: string, keywords: string[]): TaskProfile {
  const lowerTask = task.toLowerCase();
  const keywordSet = new Set(keywords.map((keyword) => keyword.toLowerCase()));
  const hasKeyword = (...values: string[]): boolean =>
    values.some(
      (value) => keywordSet.has(value) || lowerTask.includes(value),
    );

  const wantsTests = hasKeyword(
    "test",
    "tests",
    "spec",
    "specs",
    "vitest",
    "jest",
    "playwright",
    "coverage",
    "regression",
  );
  const wantsDocs = hasKeyword(
    "doc",
    "docs",
    "readme",
    "manual",
    "guide",
    "tutorial",
  );
  const wantsReports = hasKeyword("report", "reports", "audit", "postmortem");

  return {
    wantsTests,
    wantsDocs,
    wantsReports,
    prefersSource: !wantsDocs && !wantsReports,
  };
}

function scoreCandidate(
  relativePath: string,
  content: string,
  keywords: string[],
  taskProfile: TaskProfile,
): number {
  const lowerPath = relativePath.toLowerCase();
  const lowerContent = content.toLowerCase();
  const pathSegments = lowerPath.split(/[\/._-]+/u).filter(Boolean);
  let score = 0;

  for (const keyword of keywords) {
    const keywordLower = keyword.toLowerCase();
    if (pathSegments.includes(keywordLower)) {
      score += 18;
    } else if (lowerPath.includes(keywordLower)) {
      score += 10;
    }
    if (lowerContent.includes(keywordLower)) score += 3;
  }

  const baseName = basename(relativePath).toLowerCase();
  if (baseName === "agents.md") score += taskProfile.prefersSource ? 1 : 4;
  if (baseName === "readme.md") score += taskProfile.wantsDocs ? 8 : 2;
  if (baseName === "package.json") score += 4;
  if (score > 0) {
    if (isSourcePath(lowerPath)) {
      score += taskProfile.prefersSource ? 14 : 8;
    }
    if (isCodeLikePath(lowerPath)) {
      score += taskProfile.prefersSource ? 4 : 1;
    }
    if (isTestPath(lowerPath)) {
      score += taskProfile.wantsTests ? 8 : -10;
    }
    if (lowerPath.startsWith("docs/")) {
      score += taskProfile.wantsDocs ? 6 : -10;
    }
    if (lowerPath.startsWith("reports/")) {
      score += taskProfile.wantsReports ? 6 : -12;
    }
    if (baseName === "readme.md" && !taskProfile.wantsDocs) {
      score -= 4;
    }
  }

  return score;
}

function buildReason(relativePath: string, keywords: string[]): string {
  const lowerPath = relativePath.toLowerCase();
  const matched = keywords.filter((keyword) =>
    lowerPath.includes(keyword.toLowerCase()),
  );

  if (matched.length > 0) {
    return `Matched task keywords: ${matched.join(", ")}`;
  }

  return "Selected as repo-local supporting context";
}

function selectSnippet(
  candidate: CandidateFile,
  keywords: string[],
  lineCount: number,
): {
  lineStart: number;
  lineEnd: number;
  lines: string[];
} {
  const lines = candidate.content.split(/\r?\n/u);
  const matchIndex = findMatchLineIndex(lines, keywords);
  const contextBefore = Math.max(0, Math.floor((lineCount - 1) / 2));
  const lineStart = Math.max(1, matchIndex - contextBefore);
  const lineEnd = Math.min(lines.length, lineStart + lineCount - 1);

  return {
    lineStart,
    lineEnd,
    lines: lines.slice(lineStart - 1, lineEnd),
  };
}

function findMatchLineIndex(lines: string[], keywords: string[]): number {
  if (keywords.length === 0) return 1;

  let bestIndex = 1;
  let bestScore = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lowerLine = lines[index]?.toLowerCase() ?? "";
    let lineScore = 0;
    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();
      if (lowerLine.includes(keywordLower)) {
        lineScore += keywordLower.length;
      }
    }
    if (lineScore > bestScore) {
      bestScore = lineScore;
      bestIndex = index + 1;
    }
  }

  return bestScore > 0 ? bestIndex : 1;
}

function renderSnippet(
  relativePath: string,
  snippet: { lineStart: number; lineEnd: number; lines: string[] },
): string {
  const language = inferFenceLanguage(relativePath);
  const numbered = snippet.lines
    .map((line, index) => `${snippet.lineStart + index} | ${line}`)
    .join("\n");

  return [
    `## ${relativePath} (${snippet.lineStart}-${snippet.lineEnd})`,
    "",
    `\`\`\`${language}`,
    numbered,
    "```",
  ].join("\n");
}

function inferFenceLanguage(relativePath: string): string {
  if (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) {
    return "ts";
  }
  if (relativePath.endsWith(".js") || relativePath.endsWith(".jsx")) {
    return "js";
  }
  if (relativePath.endsWith(".json")) {
    return "json";
  }
  if (relativePath.endsWith(".md")) {
    return "md";
  }
  return "text";
}

function renderOmittedSummary(entries: OmittedEntry[]): string {
  if (entries.length === 0) return "";

  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }

  return [
    "## Omitted Summary",
    "",
    ...Array.from(counts.entries()).map(
      ([reason, count]) => `- ${reason}: ${count}`,
    ),
    "",
  ].join("\n");
}

function buildPackHeader(
  repoPath: string,
  task: string,
  budget: number,
): { text: string; truncatedTask: boolean } {
  const titleLine = "# DevSpace Coach Pack";
  const repoLine = `Repo folder: ${basename(repoPath)}`;
  const budgetLine = `Budget: ${budget} characters`;
  let taskLine = task;
  let truncatedTask = false;
  let header = composeHeader(titleLine, taskLine, repoLine, budgetLine);

  while (header.length > budget && taskLine.length > 0) {
    taskLine = truncateText(task, Math.max(0, taskLine.length - (header.length - budget) - 3));
    truncatedTask = true;
    header = composeHeader(titleLine, taskLine, repoLine, budgetLine);
  }

  if (header.length <= budget) {
    return { text: header, truncatedTask };
  }

  truncatedTask = true;
  header = composeHeader(titleLine, "", repoLine, budgetLine);
  if (header.length <= budget) {
    return { text: header, truncatedTask };
  }

  header = composeHeader(titleLine, "", "", budgetLine);
  if (header.length <= budget) {
    return { text: header, truncatedTask };
  }

  header = composeHeader(titleLine, "", "", "");
  if (header.length <= budget) {
    return { text: header, truncatedTask };
  }

  return {
    text: titleLine.slice(0, budget),
    truncatedTask,
  };
}

function composeHeader(
  titleLine: string,
  taskLine: string,
  repoLine: string,
  budgetLine: string,
): string {
  const lines = [titleLine];
  if (taskLine) lines.push(`Task: ${taskLine}`);
  if (repoLine) lines.push(repoLine);
  if (budgetLine) lines.push(budgetLine);
  lines.push("");
  return lines.join("\n");
}

function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function selectFittingSnippet(
  candidate: CandidateFile,
  keywords: string[],
  maxLines: number,
  currentSections: string[],
  budget: number,
): {
  snippet: { lineStart: number; lineEnd: number; lines: string[] };
  text: string;
} | null {
  for (const lineCount of buildSnippetLinePlan(candidate.relativePath, maxLines)) {
    const snippet = selectSnippet(candidate, keywords, lineCount);
    const text = renderSnippet(candidate.relativePath, snippet);
    if (wouldFitWithinBudget(currentSections, text, budget)) {
      return { snippet, text };
    }
  }

  return null;
}

function buildSnippetLinePlan(relativePath: string, maxLines: number): number[] {
  const lowerPath = relativePath.toLowerCase();
  const preferred = isSourcePath(lowerPath)
    ? [80, 48, 32, 24, 16, 12, 8]
    : lowerPath.startsWith("docs/") || lowerPath.startsWith("reports/")
      ? [32, 20, 16, 12, 8]
      : isTestPath(lowerPath)
        ? [24, 16, 12, 8]
        : [48, 32, 24, 16, 12, 8];

  return Array.from(
    new Set([maxLines, ...preferred.filter((value) => value < maxLines)]),
  ).filter((value) => value > 0);
}

function isSourcePath(lowerPath: string): boolean {
  return (
    lowerPath.startsWith("src/") ||
    lowerPath.startsWith("lib/") ||
    lowerPath.startsWith("app/") ||
    lowerPath.startsWith("server/")
  );
}

function isTestPath(lowerPath: string): boolean {
  return (
    lowerPath.startsWith("tests/") ||
    lowerPath.startsWith("test/") ||
    lowerPath.includes(".test.") ||
    lowerPath.includes(".spec.")
  );
}

function isCodeLikePath(lowerPath: string): boolean {
  return (
    lowerPath.endsWith(".ts") ||
    lowerPath.endsWith(".tsx") ||
    lowerPath.endsWith(".js") ||
    lowerPath.endsWith(".jsx") ||
    lowerPath.endsWith(".py") ||
    lowerPath.endsWith(".rs") ||
    lowerPath.endsWith(".go") ||
    lowerPath.endsWith(".java") ||
    lowerPath.endsWith(".c") ||
    lowerPath.endsWith(".cc") ||
    lowerPath.endsWith(".cpp") ||
    lowerPath.endsWith(".cs")
  );
}

function wouldFitWithinBudget(
  currentSections: string[],
  nextSection: string,
  budget: number,
): boolean {
  return [...currentSections, nextSection, ""].join("\n").length <= budget;
}
