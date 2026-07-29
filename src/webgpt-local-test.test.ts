import assert from "node:assert/strict";
import {
  WEBGPT_TEST_SECURITY_HEADERS,
  isWorkspaceAppTestResourceUri,
  prepareWebGptTestHostHtml,
} from "./webgpt-local-test.js";

const current = "ui://devspace/workspace-app-0123456789abcdef.html";
const legacy = "ui://devspace/workspace-app.html";

assert.equal(isWorkspaceAppTestResourceUri(current, current, legacy), true);
assert.equal(isWorkspaceAppTestResourceUri(legacy, current, legacy), true);
assert.equal(
  isWorkspaceAppTestResourceUri(
    "ui://devspace/workspace-app-fedcba9876543210.html",
    current,
    legacy,
  ),
  true,
);
assert.equal(
  isWorkspaceAppTestResourceUri(
    "ui://devspace/workspace-app-ABCDEF0123456789.html",
    current,
    legacy,
  ),
  false,
);
assert.equal(
  isWorkspaceAppTestResourceUri(
    "ui://other/workspace-app-0123456789abcdef.html",
    current,
    legacy,
  ),
  false,
);

assert.equal(
  prepareWebGptTestHostHtml("<html><head></head></html>"),
  '<html><head><base href="/app-test/"></head></html>',
);
assert.match(
  WEBGPT_TEST_SECURITY_HEADERS["Content-Security-Policy"],
  /frame-ancestors 'none'/,
);
assert.match(
  WEBGPT_TEST_SECURITY_HEADERS["Content-Security-Policy"],
  /frame-src 'self' data: blob:/,
);

console.log("webgpt local test helpers passed");
