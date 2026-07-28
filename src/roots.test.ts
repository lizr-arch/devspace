import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAllowedPath,
  effectiveAdditionalRootAccess,
  expandHomePath,
  normalizeAdditionalRoots,
  resolveAllowedPath,
} from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(
  expandHomePath("~/personal/devspace"),
  resolve(home, "personal", "devspace"),
);
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

assert.deepEqual(normalizeAdditionalRoots([{ path: "/reference" }]), [
  { path: resolve("/reference"), access: "inherit" },
]);
assert.equal(effectiveAdditionalRootAccess("inherit", true), "read_write");
assert.equal(effectiveAdditionalRootAccess("read_write", false), "read_only");
assert.equal(effectiveAdditionalRootAccess("read_only", true), "read_only");
