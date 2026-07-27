import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import {
  loadSkills,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export function loadWorkspaceSkills(
  config: ServerConfig,
  cwd: string,
): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  return loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: config.skillPaths,
    includeDefaults: true,
  });
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const requestedPath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (requestedPath !== skillFilePath) continue;

    const canonicalBaseDir = canonicalPath(skill.baseDir);
    const canonicalSkillFile = canonicalPath(skill.filePath);
    if (!canonicalBaseDir || !canonicalSkillFile) return undefined;
    if (!isPathInsideRoot(canonicalSkillFile, canonicalBaseDir))
      return undefined;

    return {
      absolutePath: canonicalSkillFile,
      skill,
      isSkillFile: true,
    };
  }

  const canonicalRequestedPath = canonicalPath(requestedPath);
  if (!canonicalRequestedPath) return undefined;

  for (const skill of skills) {
    const canonicalBaseDir = canonicalPath(skill.baseDir);
    if (!canonicalBaseDir) continue;
    if (!activatedSkillDirs.has(canonicalBaseDir)) continue;
    if (!isPathInsideRoot(canonicalRequestedPath, canonicalBaseDir)) continue;

    return {
      absolutePath: canonicalRequestedPath,
      skill,
      isSkillFile: false,
    };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  const canonicalBaseDir = canonicalPath(skill.baseDir);
  if (canonicalBaseDir) activatedSkillDirs.add(canonicalBaseDir);
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath
      .slice(home.length + 1)
      .split(sep)
      .join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}

function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync(resolve(expandHomePath(path)));
  } catch {
    return undefined;
  }
}
