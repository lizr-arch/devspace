import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const GIT_USER_NAME = "DevSpace Remote Test";
export const GIT_USER_EMAIL = "devspace-remote-test@example.com";

export interface RemoteFixture {
  root: string;
  bare: string;
  producer: string;
  client: string;
  cleanup(): Promise<void>;
}

export interface LocalFixture {
  root: string;
  cleanup(): Promise<void>;
}

export interface RepositorySnapshot {
  head: string;
  branch: string;
  indexTree: string;
  status: string;
  diff: string;
}

export type TestCase = {
  name: string;
  run: () => Promise<void>;
};

export class TestSuite {
  readonly tests: TestCase[] = [];

  test(name: string, run: () => Promise<void>): void {
    this.tests.push({ name, run });
  }

  async runAll(suiteName: string): Promise<void> {
    const failures: Array<{ name: string; error: unknown }> = [];
    for (const candidate of this.tests) {
      try {
        await candidate.run();
        console.log(`[PASS] ${candidate.name}`);
      } catch (error) {
        failures.push({ name: candidate.name, error });
        console.error(
          `[FAIL] ${candidate.name}\n${
            error instanceof Error ? (error.stack ?? error.message) : String(error)
          }`,
        );
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ error }) => error),
        `${failures.length}/${this.tests.length} ${suiteName} integration tests failed`,
      );
    }

    console.log(`${suiteName} passed (${this.tests.length}/${this.tests.length})`);
  }
}

/**
 * Destination branch used by the push fixtures.
 *
 * Remote write policy refuses protected default branches (`main`/`master`) in
 * the standing allowlist, so the fixtures push to a scoped integration branch
 * instead. The client's local HEAD stays on `main`; only the destination ref
 * changes, which keeps every other assertion in these suites intact.
 */
export const TEST_DESTINATION_BRANCH = "devspace/integration/fixture";

export async function createRemoteFixture(label: string): Promise<RemoteFixture> {
  const root = await mkdtemp(join(tmpdir(), `devspace-${label}-`));
  const bare = join(root, "remote.git");
  const producer = join(root, "producer");
  const client = join(root, "client");
  await mkdir(producer);
  await git(root, ["init", "--bare", "--initial-branch=main", bare]);
  await initializeRepository(producer);
  await writeFile(join(producer, "base.txt"), "base\n");
  await git(producer, ["add", "--", "base.txt"]);
  await git(producer, ["commit", "-m", "initial"]);
  await git(producer, ["remote", "add", "origin", bare]);
  await git(producer, ["push", "-u", "origin", "main"]);
  // Seed the scoped destination branch on the remote so a fast-forward target
  // exists. It starts at the same commit as main.
  await git(producer, [
    "push",
    "origin",
    `main:refs/heads/${TEST_DESTINATION_BRANCH}`,
  ]);
  await git(root, ["clone", "--branch", "main", "--", bare, client]);
  await configureIdentity(client);
  await git(client, ["fetch", "--no-tags", "origin"]);
  await git(client, [
    "branch",
    "--track",
    TEST_DESTINATION_BRANCH,
    `origin/${TEST_DESTINATION_BRANCH}`,
  ]);
  await configureIdentity(client);
  return {
    root,
    bare,
    producer,
    client,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createLocalFixture(label: string): Promise<LocalFixture> {
  const root = await mkdtemp(join(tmpdir(), `devspace-${label}-`));
  await initializeRepository(root);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "--", "base.txt"]);
  await git(root, ["commit", "-m", "initial"]);
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createDivergedFixture(label: string): Promise<LocalFixture> {
  const fixture = await createLocalFixture(label);
  await git(fixture.root, ["switch", "-c", "feature"]);
  await commitFile(fixture.root, "feature.txt", "feature\n", "feature change");
  await git(fixture.root, ["switch", "main"]);
  await commitFile(fixture.root, "main.txt", "main\n", "main change");
  return fixture;
}

export async function initializeRepository(root: string): Promise<void> {
  await git(root, ["init", "--initial-branch=main"]);
  await configureIdentity(root);
}

export async function configureIdentity(root: string): Promise<void> {
  await git(root, ["config", "user.name", GIT_USER_NAME]);
  await git(root, ["config", "user.email", GIT_USER_EMAIL]);
}

export async function commitFile(
  root: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(root, path), content);
  await git(root, ["add", "--", path]);
  await git(root, ["commit", "-m", message]);
  return revParse(root, "HEAD");
}

export async function snapshotRepository(root: string): Promise<RepositorySnapshot> {
  return {
    head: await revParse(root, "HEAD"),
    branch: (await git(root, ["branch", "--show-current"])).trim(),
    indexTree: (await git(root, ["write-tree"])).trim(),
    status: await git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    diff: await git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "HEAD",
      "--",
    ]),
  };
}

export async function installRemoteHook(
  fixture: RemoteFixture,
  content: string,
): Promise<void> {
  await writeExecutable(join(fixture.bare, "hooks", "pre-receive"), content);
}

export async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

export async function revParse(root: string, ref: string): Promise<string> {
  return (await git(root, ["rev-parse", "--verify", ref])).trim();
}

export async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout;
}

export async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    assert.ok(
      error instanceof Error,
      `Expected ${code}, received ${String(error)}`,
    );
    assert.match(error.message, new RegExp(`^${escapeRegex(code)}:`));
    return error;
  }
  assert.fail(`Expected ${code}, but the operation succeeded`);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
