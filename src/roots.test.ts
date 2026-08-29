import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAllowedPath,
  canonicalRootPath,
  effectiveAdditionalRootAccess,
  expandHomePath,
  isPathInsideAnyRoot,
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

// Regression: a canonical (realpath-resolved) path must still be accepted when
// the configured root traverses a symlink (macOS /var/folders vs /private/var).
{
  const realDir = mkdtempSync(join(tmpdir(), "devspace-roots-canonical-"));
  const linkDir = join(realDir, "..", `devspace-roots-link-${Date.now()}`);
  let linked = false;
  try {
    try {
      symlinkSync(realDir, linkDir, "dir");
      linked = true;
    } catch {
      // Some filesystems disallow symlinks; skip the link variants.
    }
    const linkedRoot = linked ? linkDir : realDir;
    mkdirSync(join(realDir, "nested"), { recursive: true });
    writeFileSync(join(realDir, "nested", "file.txt"), "ok\n");

    // Root registered via the symlinked path; path already canonical.
    const canonicalFile = resolve(realDir, "nested", "file.txt");
    assert.equal(
      isPathInsideAnyRoot(canonicalFile, [linkedRoot]),
      true,
      "canonical path must match symlinked root",
    );
    assert.equal(isPathInsideAnyRoot(canonicalFile, [realDir]), true);
    assert.equal(
      canonicalRootPath(linkedRoot),
      resolve(realpathSync(realDir)),
    );

    // Non-canonical path against canonical root must also match.
    assert.equal(
      isPathInsideAnyRoot(resolve(linkedRoot, "nested", "file.txt"), [realDir]),
      true,
    );
    // Outside paths stay rejected in all variants.
    assert.equal(isPathInsideAnyRoot(resolve(realDir, ".."), [realDir]), false);
    assert.equal(
      assertAllowedPath(canonicalFile, [linkedRoot]),
      canonicalFile,
    );
  } finally {
    if (linked) rmSync(linkDir, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  }
}
