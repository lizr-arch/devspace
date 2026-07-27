import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyProductEdition,
  inspectHoudini,
  redactHoudiniDiagnostic,
} from "./houdini.js";
import { RunnerRegistry } from "./runner-registry.js";

const root = mkdtempSync(join(tmpdir(), "devspace-houdini-"));
const fakeHython = join(root, "hython");
const fakeHbatch = join(root, "hbatch");

try {
  for (const executable of [fakeHython, fakeHbatch]) {
    writeFileSync(
      executable,
      `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("Houdini 20.5.410 Test");
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(executable, 0o755);
  }

  const installed = new RunnerRegistry({
    hython: { executable: fakeHython },
    hbatch: { executable: fakeHbatch },
  });
  const available = await inspectHoudini(installed, {
    hostArchitecture: "arm64",
    probe: async () => ({
      code: 0,
      signal: null,
      output:
        '__DEVSPACE_HOUDINI_PREFLIGHT__{"architecture":"arm64","licenseCategory":"licenseCategoryType.Indie","version":"20.5.410"}\nLICENSE_KEY=SHOULD-NOT-LEAK',
      timedOut: false,
      truncated: false,
    }),
  });
  assert.equal(available.hythonAvailable, true);
  assert.equal(available.hbatchAvailable, true);
  assert.equal(available.version, "20.5.410");
  assert.equal(available.hostArchitecture, "arm64");
  assert.equal(available.executableArchitecture, "arm64");
  assert.equal(available.productEdition, "indie");
  assert.equal(available.licenseStatus, "available");
  assert.doesNotMatch(available.diagnostic, /SHOULD-NOT-LEAK/);

  const unavailableLicense = await inspectHoudini(installed, {
    probe: async () => ({
      code: 1,
      signal: null,
      output:
        "Unable to acquire a license. LICENSE_KEY=ABCD-EFGH-IJKL account=artist@example.test",
      timedOut: false,
      truncated: false,
    }),
  });
  assert.equal(unavailableLicense.licenseStatus, "unavailable");
  assert.equal(unavailableLicense.productEdition, "unknown");
  assert.doesNotMatch(unavailableLicense.diagnostic, /ABCD|artist/);

  const missing = await inspectHoudini(
    new RunnerRegistry({
      hython: { executable: join(root, "missing-hython") },
      hbatch: { executable: join(root, "missing-hbatch") },
    }),
  );
  assert.equal(missing.hythonAvailable, false);
  assert.equal(missing.hbatchAvailable, false);
  assert.equal(missing.licenseStatus, "unknown");
  assert.equal(missing.productEdition, "unknown");

  assert.equal(classifyProductEdition("Commercial"), "commercial");
  assert.equal(classifyProductEdition("Houdini Engine"), "engine");
  assert.equal(
    classifyProductEdition("licenseCategoryType.Apprentice"),
    "apprentice_non_commercial",
  );
  const redacted = redactHoudiniDiagnostic(
    "license_key=AAAA-BBBB-CCCC token=secret Bearer abc.def.ghi",
  );
  assert.doesNotMatch(redacted, /AAAA|secret|abc\.def/);
  assert.match(redacted, /\[REDACTED\]/);

  console.log("houdini preflight tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
