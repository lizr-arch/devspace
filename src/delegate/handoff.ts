import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DelegateContract,
  StopConditions,
  AutonomyMode,
  HandoffPackage,
} from "./schemas.js";
import {
  validateDelegateContract,
  validateStopConditions,
} from "./validators.js";

const CEO_DIR = ".devspace/ceo";

const REQUIRED_FILES = [
  "brainstorm_summary.md",
  "user_intent.md",
  "architecture_decision.md",
  "ceo_charter.md",
  "delegate_contract.md",
  "autonomy_policy.md",
  "review_policy.md",
  "stop_conditions.md",
  "task_plan.md",
  "first_task.md",
];

export interface HandoffValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function getTemplatesDir(): string {
  const currentDir =
    typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "..", "templates", "ceo");
}

export function ensureCeoDir(): void {
  if (!existsSync(CEO_DIR)) {
    mkdirSync(CEO_DIR, { recursive: true });
  }
}

export function copyTemplate(templateName: string, targetName?: string): void {
  const templatesDir = getTemplatesDir();
  const source = join(templatesDir, templateName);
  const target = join(CEO_DIR, targetName || templateName);

  if (!existsSync(source)) {
    throw new Error(`Template not found: ${source}`);
  }

  const content = readFileSync(source, "utf-8");
  writeFileSync(target, content, "utf-8");
}

export function initializeHandoffPackage(): void {
  ensureCeoDir();

  for (const template of REQUIRED_FILES) {
    copyTemplate(template);
  }
}

export function readDelegateContract(): DelegateContract | null {
  const contractPath = join(CEO_DIR, "delegate_contract.md");
  if (!existsSync(contractPath)) {
    return null;
  }

  const content = readFileSync(contractPath, "utf-8");

  const canDo = extractList(content, "What User Proxy CAN Do");
  const cannotDo = extractList(content, "What User Proxy CANNOT Do");
  const mustTrigger = extractList(content, "MUST Trigger NEED_USER When");

  const riskMatch = content.match(/## Acceptable Risk Level\n(.+)/);
  const riskLevel = (riskMatch?.[1]?.trim() || "low") as
    "low" | "medium" | "high";

  const scopeMatch = content.match(/## Maximum Auto Scope\n(.+)/);
  const maxScope = scopeMatch?.[1]?.trim() || "";

  const contract: DelegateContract = {
    can_do: canDo,
    cannot_do: cannotDo,
    must_trigger_need_user: mustTrigger,
    acceptable_risk_level: riskLevel,
    max_auto_scope: maxScope,
  };

  return contract;
}

export function readStopConditions(): StopConditions | null {
  const conditionsPath = join(CEO_DIR, "stop_conditions.md");
  if (!existsSync(conditionsPath)) {
    return null;
  }

  const content = readFileSync(conditionsPath, "utf-8");

  const doneConditions = extractList(content, "DONE Conditions");
  const blockedConditions = extractList(content, "BLOCKED Conditions");
  const needUserConditions = extractList(content, "NEED_USER Conditions");
  const safetyStopConditions = extractList(content, "SAFETY_STOP Conditions");

  const maxRoundsMatch = content.match(/Max Rounds\s*\|\s*(\d+)/);
  const maxFailuresMatch = content.match(
    /Max Consecutive Failures\s*\|\s*(\d+)/,
  );
  const maxRuntimeMatch = content.match(/Max Runtime\s*\|\s*(\d+)/);
  const maxChangesMatch = content.match(/Max File Changes\s*\|\s*(\d+)/);

  const conditions: StopConditions = {
    done_conditions: doneConditions,
    blocked_conditions: blockedConditions,
    need_user_conditions: needUserConditions,
    safety_stop_conditions: safetyStopConditions,
    budget_stop: {
      max_rounds: parseInt(maxRoundsMatch?.[1] || "10"),
      max_failures: parseInt(maxFailuresMatch?.[1] || "3"),
      max_runtime_seconds: parseInt(maxRuntimeMatch?.[1] || "3600"),
      max_file_changes: parseInt(maxChangesMatch?.[1] || "50"),
    },
  };

  return conditions;
}

export function readAutonomyPolicy(): AutonomyMode {
  const policyPath = join(CEO_DIR, "autonomy_policy.md");
  if (!existsSync(policyPath)) {
    return "manual";
  }

  const content = readFileSync(policyPath, "utf-8");
  const modeMatch = content.match(/## Current Mode\n(.+)/);
  const mode = modeMatch?.[1]?.trim();

  if (mode && ["manual", "guided", "delegate", "free"].includes(mode)) {
    return mode as AutonomyMode;
  }

  return "manual";
}

export function validateHandoffPackage(): HandoffValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const file of REQUIRED_FILES) {
    const filePath = join(CEO_DIR, file);
    if (!existsSync(filePath)) {
      errors.push(`Missing required file: ${file}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  const contract = readDelegateContract();
  if (contract) {
    if (!validateDelegateContract(contract)) {
      errors.push("Invalid delegate_contract.md format");
    }
  } else {
    errors.push("Cannot read delegate_contract.md");
  }

  const conditions = readStopConditions();
  if (conditions) {
    if (!validateStopConditions(conditions)) {
      errors.push("Invalid stop_conditions.md format");
    }
  } else {
    errors.push("Cannot read stop_conditions.md");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function extractList(content: string, sectionName: string): string[] {
  const sectionRegex = new RegExp(
    `## ${sectionName}\\n([\\s\\S]*?)(?=\\n##|$)`,
  );
  const sectionMatch = content.match(sectionRegex);

  if (!sectionMatch) {
    return [];
  }

  const section = sectionMatch[1];
  const items: string[] = [];

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.substring(2));
    }
  }

  return items;
}

export function updateBrainstormSummary(summary: string): void {
  const filePath = join(CEO_DIR, "brainstorm_summary.md");
  writeFileSync(filePath, summary, "utf-8");
}

export function updateUserIntent(intent: string): void {
  const filePath = join(CEO_DIR, "user_intent.md");
  writeFileSync(filePath, intent, "utf-8");
}

export function updateArchitectureDecision(decision: string): void {
  const filePath = join(CEO_DIR, "architecture_decision.md");
  writeFileSync(filePath, decision, "utf-8");
}

export function updateTaskPlan(plan: string): void {
  const filePath = join(CEO_DIR, "task_plan.md");
  writeFileSync(filePath, plan, "utf-8");
}

export function updateFirstTask(task: string): void {
  const filePath = join(CEO_DIR, "first_task.md");
  writeFileSync(filePath, task, "utf-8");
}
