import type { RunnerInput, RunnerStatus } from "./codex-agent-runner.js";
import type { CodexSelection } from "./coach-model-policy.js";
import type { StoredCodexConfig } from "./coach-review-events.js";

export type Awaitable<T> = T | Promise<T>;
/** Both the in-process compatibility adapter and the UDS worker client fit this API. */
export interface CodexAgentControl {
  start(input: RunnerInput): Awaitable<RunnerStatus>;
  run(input: RunnerInput): Promise<RunnerStatus>;
  status(operationId: string, workspaceId?: string): Awaitable<RunnerStatus>;
  getReviewRecommendation(operationId:string,workspaceId:string):Awaitable<{decision:"APPROVED"|"REWORK"|"BLOCKED";reason:string}|undefined>;
  stop(operationId: string, workspaceId?: string): Promise<boolean>;
  queueNextSelection(input: {workspaceId:string;operationId:string;expectedRevision:number;selection:CodexSelection}): Awaitable<StoredCodexConfig>;
  activeOperationsForWorkspace(workspaceId: string): string[];
  close(): Promise<void>;
}
