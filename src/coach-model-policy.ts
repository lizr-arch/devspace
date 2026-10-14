/** Strict, user-approved Codex model and reasoning contract.
 * No fallback to unapproved or cached model aliases.
 * Model+effort are selected by the remote Coach on task creation.
 */
export const CODEX_MODELS = ["gpt-6-luna", "gpt-6.1-sol"] as const;
export const CODEX_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
export type CodexModel = typeof CODEX_MODELS[number];
export type CodexEffort = typeof CODEX_EFFORTS[number];
export interface CodexSelection { model: CodexModel; reasoningEffort: CodexEffort; }
export const DEFAULT_CODEX_SELECTION: Readonly<CodexSelection> =
  Object.freeze({model:"gpt-6-luna", reasoningEffort:"medium"});
export function validateCodexSelection(selection: {model:unknown;reasoningEffort:unknown}): asserts selection is CodexSelection {
  if(!CODEX_MODELS.includes(selection.model as CodexModel) ||
     !CODEX_EFFORTS.includes(selection.reasoningEffort as CodexEffort))
    throw new TypeError("CODEX_INVALID_MODEL_OR_REASONING_EFFORT");
}
