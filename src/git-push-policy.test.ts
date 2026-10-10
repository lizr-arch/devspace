import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { fetchGit, pushGit } from "./git-tools.js";
import {
  exposedToolNames,
  gitRemotePolicyForWorkspace,
  toolNamesFor,
} from "./server/server-helpers.js";
import {
  commitFile,
  createRemoteFixture,
  expectCode,
  git,
  revParse,
  TestSuite,
} from "./git-test-helpers.js";

const suite = new TestSuite();
const test = suite.test.bind(suite);

const configRoot = mkdtempSync(join(tmpdir(), "devspace-git-policy-"));
const repositoryRoot = join(configRoot, "repo");
const configDir = join(configRoot, "config");
writeFileSync(join(configRoot, "placeholder"), "");
import { mkdirSync } from "node:fs";
mkdirSync(repositoryRoot, { recursive: true });
mkdirSync(configDir, { recursive: true });

const ownerToken = "test-owner-token-that-is-long-enough";

function writePolicyConfig(policy: unknown): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ allowedRoots: [repositoryRoot], gitRemoteWrite: policy }),
  );
}

function loadPolicyConfig(policy: unknown) {
  writePolicyConfig(policy);
  return loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
  });
}

const completePolicy = {
  enabled: true,
  approvedRemotes: ["origin"],
  approvedDestinationBranches: [
    "feat/wego-p0-gui-performance",
    "fix/wego-p1-locale-native-crash",
    "devspace/integration/TriaRegna-TriaRegna-b58942f7",
  ],
  approvedRepositoryRoots: [repositoryRoot],
  approvedRemoteUrls: {
    origin: [
      "https://cnb.cool/hesans/TriaRegna",
      "https://cnb.cool/hesans/TriaRegna.git",
    ],
  },
};

try {
  const enabled = loadPolicyConfig(completePolicy);
  assert.equal(enabled.gitRemoteWrite.enabled, true);
  assert.equal(enabled.gitRemoteWrite.allowForce, false);
  assert.equal(enabled.gitRemoteWrite.requireFastForward, true);
  assert.equal(enabled.gitRemoteWrite.requireCleanWorkspace, true);
  assert.equal(enabled.gitRemoteWrite.requireExpectedRemoteSha, true);
  assert.deepEqual(enabled.gitRemoteWrite.approvedRemotes, ["origin"]);
  assert.equal(
    enabled.gitRemoteWrite.approvedDestinationBranches.includes("main"),
    false,
    "main must never be in the default approved destination branches",
  );

  // The git_push tool only exists once the operator policy is enabled AND
  // fully specified; the default (disabled) posture hides it entirely.
  const toolNames = toolNamesFor(enabled);
  assert.equal(
    exposedToolNames(enabled, toolNames).includes("git_push"),
    true,
    "an enabled policy must expose git_push",
  );
  const disabled = loadPolicyConfig({ ...completePolicy, enabled: false });
  assert.equal(
    exposedToolNames(disabled, toolNamesFor(disabled)).includes("git_push"),
    false,
    "a disabled policy must not advertise git_push",
  );

  // Fail-closed configuration validation.
  assert.throws(
    () =>
      loadPolicyConfig({
        ...completePolicy,
        approvedRemoteUrls: {},
      }),
    /Enabled gitRemoteWrite requires/,
  );
  assert.throws(
    () =>
      loadPolicyConfig({
        ...completePolicy,
        approvedDestinationBranches: [],
      }),
    /Enabled gitRemoteWrite requires/,
  );
  assert.throws(
    () =>
      loadPolicyConfig({
        ...completePolicy,
        approvedRepositoryRoots: [],
      }),
    /Enabled gitRemoteWrite requires/,
  );
  assert.throws(
    () => loadPolicyConfig({ ...completePolicy, allowForce: true }),
    /allowForce must remain false/,
  );
  assert.throws(
    () => loadPolicyConfig({ ...completePolicy, requireFastForward: false }),
    /requireFastForward must remain true/,
  );
  assert.throws(
    () =>
      loadPolicyConfig({ ...completePolicy, requireCleanWorkspace: false }),
    /requireCleanWorkspace must remain true/,
  );
  assert.throws(
    () =>
      loadPolicyConfig({
        ...completePolicy,
        requireExpectedRemoteSha: false,
      }),
    /requireExpectedRemoteSha must remain true/,
  );
  assert.throws(
    () =>
      loadPolicyConfig({
        ...completePolicy,
        approvedDestinationBranches: ["main..evil"],
      }),
    /Invalid approved Git destination branch/,
  );
  assert.throws(
    () =>
      loadPolicyConfig({
        ...completePolicy,
        approvedRemoteUrls: {
          origin: ["https://cnb.cool/hesans/TriaRegna"],
          upstream: ["https://cnb.cool/hesans/Other"],
        },
      }),
    /Invalid approved Git remote URL binding/,
  );
  assert.throws(
    () =>
      loadPolicyConfig({
        ...completePolicy,
        approvedRemoteUrls: {
          origin: ["https://user:secret@cnb.cool/hesans/TriaRegna"],
        },
      }),
    /Invalid approved Git remote URL/,
  );
  assert.throws(
    () =>
      loadPolicyConfig({
        ...completePolicy,
        approvedRepositoryRoots: [join(configRoot, "elsewhere")],
      }),
    /outside allowed roots/,
  );

  // Repository-level policy: disabled, unapproved, and approved roots.
  const repositoryPolicy = loadPolicyConfig(completePolicy);
  assert.throws(
    () =>
      gitRemotePolicyForWorkspace(
        loadPolicyConfig({ ...completePolicy, enabled: false }),
        { root: repositoryRoot },
      ),
    /GIT_REMOTE_POLICY_DISABLED/,
  );
  assert.throws(
    () =>
      gitRemotePolicyForWorkspace(repositoryPolicy, {
        root: join(configRoot, "not-approved"),
      }),
    /GIT_REPOSITORY_NOT_APPROVED/,
  );
  // A managed worktree is authorized through its approved source repository.
  const worktreePolicy = gitRemotePolicyForWorkspace(repositoryPolicy, {
    root: join(configRoot, "worktrees", "TriaRegna-b58942f7"),
    sourceRoot: repositoryRoot,
  });
  assert.deepEqual(worktreePolicy.approvedRemotes, ["origin"]);
  assert.equal(
    worktreePolicy.approvedDestinationBranches.includes("main"),
    false,
  );

  // ---- Behavioural rejection matrix against a local bare remote ----------
  await test("git_push refuses refspec, force, deletion, and tag shapes", async () => {
    const fixture = await createRemoteFixture("push-shapes");
    try {
      const remoteSha = await revParse(fixture.bare, "refs/heads/main");
      const localSha = await commitFile(
        fixture.client,
        "client.txt",
        "client update\n",
        "client update",
      );
      await git(fixture.client, ["remote", "add", "upstream", fixture.bare]);
      const refsBefore = await git(fixture.bare, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ]);

      const base = {
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["main"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      };

      // No arbitrary refspec can be smuggled through sourceRef.
      await expectCode(
        pushGit({ ...base, sourceRef: "HEAD:refs/heads/evil" }),
        "GIT_SOURCE_REF_INVALID",
      );
      await expectCode(
        pushGit({ ...base, sourceRef: "+HEAD" }),
        "GIT_SOURCE_REF_INVALID",
      );
      // Force and deletion shapes are not valid branch names.
      for (const destinationBranch of [
        "+main",
        ":main",
        "--delete",
        "-f",
        "main:evil",
      ]) {
        await expectCode(
          pushGit({ ...base, destinationBranch }),
          "GIT_DESTINATION_BRANCH_INVALID",
        );
      }
      // Arbitrary remotes, URLs, and hosts are rejected.
      for (const remote of [
        "+origin",
        "https://evil.example/hesans/TriaRegna.git",
        "file:///tmp/evil.git",
        "--upload-pack=/bin/sh",
      ]) {
        await expectCode(
          pushGit({ ...base, remote }),
          "GIT_REMOTE_INVALID",
        );
      }
      // An existing but unapproved remote is refused.
      await expectCode(
        pushGit({ ...base, remote: "upstream" }),
        "GIT_REMOTE_NOT_APPROVED",
      );
      assert.equal(
        await git(fixture.bare, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ]),
        refsBefore,
        "every rejected push must leave the remote refs untouched",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await test("git_push refuses a source ref that is not the workspace HEAD", async () => {
    const fixture = await createRemoteFixture("push-source-head");
    try {
      const remoteSha = await revParse(fixture.bare, "refs/heads/main");
      await git(fixture.client, ["switch", "-c", "side"]);
      await commitFile(fixture.client, "side.txt", "side\n", "side commit");
      await git(fixture.client, ["switch", "main"]);
      const localSha = await commitFile(
        fixture.client,
        "client.txt",
        "client update\n",
        "client update",
      );
      await expectCode(
        pushGit({
          workspaceRoot: fixture.client,
          approvedRemotes: ["origin"],
          approvedDestinationBranches: ["main"],
          sourceRef: "side",
          destinationBranch: "main",
          expectedLocalSha: localSha,
          expectedRemoteSha: remoteSha,
        }),
        "GIT_SOURCE_NOT_HEAD",
      );
      assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
    } finally {
      await fixture.cleanup();
    }
  });

  await test("git_push refuses an unapproved destination even when it exists remotely", async () => {
    const fixture = await createRemoteFixture("push-main-denied");
    try {
      const remoteSha = await revParse(fixture.bare, "refs/heads/main");
      const localSha = await commitFile(
        fixture.client,
        "client.txt",
        "client update\n",
        "client update",
      );
      // Simulate the production policy: only the P0/P1 feature branches are
      // approved, so a push aimed at main is refused before any remote I/O.
      await expectCode(
        pushGit({
          workspaceRoot: fixture.client,
          approvedRemotes: ["origin"],
          approvedDestinationBranches: [
            "feat/wego-p0-gui-performance",
            "fix/wego-p1-locale-native-crash",
          ],
          destinationBranch: "main",
          expectedLocalSha: localSha,
          expectedRemoteSha: remoteSha,
        }),
        "GIT_DESTINATION_BRANCH_NOT_APPROVED",
      );
      assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
    } finally {
      await fixture.cleanup();
    }
  });

  await test("git_push refuses a remote URL that is not the exact approved binding", async () => {
    const fixture = await createRemoteFixture("push-exact-url");
    try {
      const remoteSha = await revParse(fixture.bare, "refs/heads/main");
      const localSha = await commitFile(
        fixture.client,
        "client.txt",
        "client update\n",
        "client update",
      );
      await expectCode(
        pushGit({
          workspaceRoot: fixture.client,
          approvedRemotes: ["origin"],
          approvedRemoteUrls: {
            origin: [`${fixture.bare}-near-miss`],
          },
          approvedDestinationBranches: ["main"],
          destinationBranch: "main",
          expectedLocalSha: localSha,
          expectedRemoteSha: remoteSha,
        }),
        "GIT_REMOTE_URL_MISMATCH",
      );
      assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
    } finally {
      await fixture.cleanup();
    }
  });

  await test("git_fetch does not prune by default and refuses stale HEAD", async () => {
    const fixture = await createRemoteFixture("fetch-no-prune");
    try {
      await git(fixture.producer, ["switch", "-c", "obsolete"]);
      const obsoleteSha = await commitFile(
        fixture.producer,
        "obsolete.txt",
        "obsolete\n",
        "obsolete branch",
      );
      await git(fixture.producer, ["push", "-u", "origin", "obsolete"]);
      await fetchGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        prune: false,
      });
      assert.equal(
        await revParse(fixture.client, "refs/remotes/origin/obsolete"),
        obsoleteSha,
      );
      await git(fixture.producer, ["push", "origin", "--delete", "obsolete"]);

      // No explicit prune flag: the default must not delete tracking refs.
      const defaultFetch = await fetchGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
      });
      assert.equal(defaultFetch.prune, false);
      assert.deepEqual(defaultFetch.deletedRefs, []);
      assert.equal(
        await revParse(fixture.client, "refs/remotes/origin/obsolete"),
        obsoleteSha,
        "an unqualified fetch must leave remote-tracking refs in place",
      );

      // An explicit prune still reports and removes the stale ref.
      const explicit = await fetchGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        prune: true,
      });
      assert.deepEqual(explicit.deletedRefs, [
        { ref: "refs/remotes/origin/obsolete", before: obsoleteSha },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  await test("git_fetch/git_push refuse repository-local transport and credential config", async () => {
    const fixture = await createRemoteFixture("push-local-config");
    try {
      const remoteSha = await revParse(fixture.bare, "refs/heads/main");
      const localSha = await commitFile(
        fixture.client,
        "client.txt",
        "client update\n",
        "client update",
      );
      const hostile: Array<[string, string]> = [
        ["http.sslVerify", "false"],
        ["core.sshCommand", "/bin/sh"],
        ["core.fsmonitor", "/bin/sh"],
        ["credential.helper", "!echo stolen"],
        ["remote.origin.uploadpack", "/bin/sh"],
        ["remote.origin.proxy", "http://127.0.0.1:1"],
        [
          "url.https://evil.example/.insteadOf",
          "https://cnb.cool/hesans/TriaRegna",
        ],
      ];
      for (const [key, value] of hostile) {
        await git(fixture.client, ["config", "--local", key, value]);
        await expectCode(
          fetchGit({
            workspaceRoot: fixture.client,
            approvedRemotes: ["origin"],
            remote: "origin",
          }),
          "GIT_REMOTE_CONFIG_REJECTED",
        );
        await expectCode(
          pushGit({
            workspaceRoot: fixture.client,
            approvedRemotes: ["origin"],
            approvedDestinationBranches: ["main"],
            destinationBranch: "main",
            expectedLocalSha: localSha,
            expectedRemoteSha: remoteSha,
          }),
          "GIT_REMOTE_CONFIG_REJECTED",
        );
        // Unset works because the key resolves case-insensitively.
        await git(fixture.client, ["config", "--local", "--unset", key]);
      }
      assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
      // The repository is only rejected for remote I/O, never mutated.
      const status = await git(fixture.client, ["status", "--porcelain=v1"]);
      assert.equal(status.trim(), "");
    } finally {
      await fixture.cleanup();
    }
  });

  await suite.runAll("git-push-policy");
} finally {
  rmSync(configRoot, { recursive: true, force: true });
}
