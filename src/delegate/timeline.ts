import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ConversationEntry, GlobalState } from "./schemas.js";
import { validateConversationEntry, validateState } from "./validators.js";

const DELEGATE_DIR = ".devspace";

export interface TimelineEntry {
  time: string;
  role: string;
  type: string;
  status: string;
  title: string;
}

export interface TimelineSummary {
  mode: string;
  status: string;
  active_task: string;
  rounds: number;
  stop_reason: string | null;
  entries: TimelineEntry[];
}

export function loadConversation(limit: number = 50): ConversationEntry[] {
  const conversationPath = join(DELEGATE_DIR, "conversation.jsonl");

  if (!existsSync(conversationPath)) {
    return [];
  }

  const content = readFileSync(conversationPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  const entries: ConversationEntry[] = [];

  for (const line of lines.slice(-limit)) {
    try {
      const entry = JSON.parse(line);
      if (validateConversationEntry(entry)) {
        entries.push(entry);
      }
    } catch {
      // Skip invalid lines
    }
  }

  return entries;
}

export function loadState(): GlobalState | null {
  const statePath = join(DELEGATE_DIR, "state.json");

  if (!existsSync(statePath)) {
    return null;
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  return validateState(state) ? state : null;
}

export function formatTimelineEntry(entry: ConversationEntry): TimelineEntry {
  const time = new Date(entry.timestamp).toLocaleTimeString();

  return {
    time,
    role: entry.role,
    type: entry.type,
    status: entry.status || "",
    title: entry.title,
  };
}

export function getTimelineSummary(limit: number = 20): TimelineSummary {
  const state = loadState();
  const entries = loadConversation(limit);

  return {
    mode: state?.mode || "unknown",
    status: state?.status || "unknown",
    active_task: state?.active_task_id || "None",
    rounds: entries.length,
    stop_reason: state?.stop_reason || null,
    entries: entries.map(formatTimelineEntry),
  };
}

export function renderTimeline(limit: number = 20): string {
  const summary = getTimelineSummary(limit);

  const lines: string[] = [
    "=== Delegate Timeline ===",
    "",
    `Mode: ${summary.mode}`,
    `Status: ${summary.status}`,
    `Active Task: ${summary.active_task}`,
    `Stop Reason: ${summary.stop_reason || "None"}`,
    "",
    "--- Recent Events ---",
    "",
  ];

  if (summary.entries.length === 0) {
    lines.push("No events recorded yet.");
  } else {
    for (const entry of summary.entries) {
      const role = entry.role.padEnd(20);
      const type = entry.type.padEnd(10);
      const status = entry.status ? ` [${entry.status}]` : "";
      lines.push(`[${entry.time}] ${role} ${type}${status} ${entry.title}`);
    }
  }

  return lines.join("\n");
}
