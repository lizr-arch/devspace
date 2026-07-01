export interface ReferencedFile {
  path: string;
  line?: number;
}

export interface CoachReplySummary {
  diagnosis: string[];
  referencedFiles: ReferencedFile[];
  proposedNextReads: string[];
  proposedPatchPlan: string[];
  verificationCommands: string[];
}

interface MarkdownSection {
  heading: string;
  body: string[];
}

export function parseCoachReply(markdown: string): CoachReplySummary {
  const sections = splitMarkdownSections(markdown);
  const diagnosis = extractListLikeSection(sections, [
    "diagnosis",
    "诊断",
    "root cause",
    "analysis",
  ]);
  const proposedNextReads = extractListLikeSection(sections, [
    "next reads",
    "read next",
    "继续看",
    "建议阅读",
  ]);
  const proposedPatchPlan = extractListLikeSection(sections, [
    "patch plan",
    "implementation plan",
    "修改方案",
    "修复方案",
  ]);
  const verificationCommands = extractVerificationCommands(sections);
  const referencedFiles = extractReferencedFiles(
    collectSectionBody(sections, ["referenced files", "files referenced", "引用文件"]),
  );

  return {
    diagnosis,
    referencedFiles,
    proposedNextReads,
    proposedPatchPlan,
    verificationCommands,
  };
}

function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/u);
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection = { heading: "summary", body: [] };

  for (const line of lines) {
    const match = /^#{1,6}\s+(.+)$/u.exec(line.trim());
    if (match) {
      sections.push(current);
      current = { heading: match[1]!.trim(), body: [] };
      continue;
    }
    current.body.push(line);
  }

  sections.push(current);
  return sections;
}

function extractListLikeSection(
  sections: MarkdownSection[],
  aliases: string[],
): string[] {
  return dedupeStrings(
    collectSectionBody(sections, aliases)
      .flatMap((body) => extractListItems(body))
      .filter(Boolean),
  );
}

function collectSectionBody(
  sections: MarkdownSection[],
  aliases: string[],
): string[] {
  const normalizedAliases = aliases.map((entry) => entry.toLowerCase());
  return sections
    .filter((section) =>
      normalizedAliases.some((alias) =>
        section.heading.toLowerCase().includes(alias),
      ),
    )
    .map((section) => section.body.join("\n"));
}

function extractListItems(body: string): string[] {
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletItems = lines
    .map((line) => /^[-*]\s+(.+)$/u.exec(line) ?? /^\d+\.\s+(.+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => match[1]!.trim());

  if (bulletItems.length > 0) return bulletItems;

  return lines.filter((line) => !line.startsWith("```"));
}

function extractVerificationCommands(sections: MarkdownSection[]): string[] {
  const bodies = collectSectionBody(sections, ["verification", "verify", "验证", "tests"]);
  const commands: string[] = [];

  for (const body of bodies) {
    const codeBlocks = [...body.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/gu)];
    for (const match of codeBlocks) {
      const block = match[1] ?? "";
      commands.push(
        ...block
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    }

    if (commands.length === 0) {
      commands.push(...extractListItems(body));
    }
  }

  return dedupeStrings(commands);
}

function extractReferencedFiles(bodies: string[]): ReferencedFile[] {
  const seen = new Set<string>();
  const files: ReferencedFile[] = [];

  for (const body of bodies) {
    for (const item of extractListItems(body)) {
      const normalizedItem = item.replace(/^`(.+)`$/u, "$1").trim();
      if (!normalizedItem) continue;

      const lineMatch = /:(\d+)$/u.exec(normalizedItem);
      const path = (
        lineMatch
          ? normalizedItem.slice(0, lineMatch.index)
          : normalizedItem
      )
        .trim()
        .replaceAll("\\", "/");

      if (!path) continue;

      const key = `${path}:${lineMatch?.[1] ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({
        path,
        line: lineMatch?.[1] ? Number(lineMatch[1]) : undefined,
      });
    }
  }

  return files;
}

function dedupeStrings(entries: string[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    values.push(entry);
  }

  return values;
}
