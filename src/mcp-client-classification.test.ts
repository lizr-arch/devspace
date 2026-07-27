import assert from "node:assert/strict";
import { classifyMcpClient } from "./mcp-client-classification.js";

assert.deepEqual(
  classifyMcpClient({
    params: {
      clientInfo: { name: "devspace-tool-cards", version: "0.4.0" },
    },
  }),
  {
    source: "workspace_app",
    clientName: "devspace-tool-cards",
    clientVersion: "0.4.0",
  },
);
assert.equal(
  classifyMcpClient({
    params: { clientInfo: { name: "public-doctor", version: "1.0.0" } },
  }).source,
  "doctor",
);
assert.equal(
  classifyMcpClient({
    params: { clientInfo: { name: "devspace-test-reuse", version: "1" } },
  }).source,
  "test_client",
);
assert.equal(
  classifyMcpClient({
    params: { clientInfo: { name: "ChatGPT", version: "2026.7" } },
  }).source,
  "main_connector",
);
assert.deepEqual(classifyMcpClient({ params: {} }), { source: "unknown" });
assert.equal(
  classifyMcpClient({
    params: {
      clientInfo: {
        name: "client<script>alert(1)</script>",
        version: "v1\nAuthorization: secret",
      },
    },
  }).clientName,
  "client_script_alert_1___script_",
);
