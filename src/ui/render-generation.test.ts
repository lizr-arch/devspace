import assert from "node:assert/strict";
import type { ToolResultCard } from "./card-types.js";
import { RenderGenerationGate } from "./render-generation.js";

const gate = new RenderGenerationGate();
const container = {} as HTMLElement;
const results = [
  "resume_workspace",
  "project_memory_preflight",
  "read",
  "grep",
].map((tool) => ({ tool }) satisfies ToolResultCard);

gate.nextResult();
const resumeToken = gate.beginPayload(results[0], container);
gate.nextResult();
const memoryToken = gate.beginPayload(results[1], container);
gate.nextResult();
const readToken = gate.beginPayload(results[2], container);
gate.nextResult();
const grepToken = gate.beginPayload(results[3], container);

assert.equal(gate.isCurrent(resumeToken, results[3], container), false);
assert.equal(gate.isCurrent(memoryToken, results[3], container), false);
assert.equal(gate.isCurrent(readToken, results[3], container), false);
assert.equal(gate.isCurrent(grepToken, results[3], container), true);

const replacementContainer = {} as HTMLElement;
const replacementToken = gate.beginPayload(results[3], replacementContainer);
assert.equal(gate.isCurrent(grepToken, results[3], container), false);
assert.equal(
  gate.isCurrent(replacementToken, results[3], replacementContainer),
  true,
);

gate.invalidatePayload();
assert.equal(
  gate.isCurrent(replacementToken, results[3], replacementContainer),
  false,
);
