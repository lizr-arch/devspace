import assert from "node:assert/strict";
import * as z from "zod/v4";
import {
  IMPORT_PNG_FILE_PARAMS_META,
  openAiFileInputSchema,
} from "./openai-file.js";

const schema = z.toJSONSchema(openAiFileInputSchema, { io: "input" }) as {
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
  "download_url",
  "file_id",
  "file_name",
  "mime_type",
]);
assert.deepEqual([...(schema.required ?? [])].sort(), [
  "download_url",
  "file_id",
]);
assert.equal(schema.additionalProperties, false);
assert.deepEqual(IMPORT_PNG_FILE_PARAMS_META, {
  "openai/fileParams": ["file"],
});

console.log("OpenAI file schema tests passed");
