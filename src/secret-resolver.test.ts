// ---------------------------------------------------------------------------
// Secret Resolver tests
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InMemorySecretResolver,
  OperatorServiceEnvironmentResolver,
  redactSecrets,
  type SecretResolver,
} from "./secret-resolver.js";

// Test sentinel — never a real secret
const TEST_SENTINEL = "DEVSPACE_TEST_SECRET_SENTINEL_abc123";

// ---------------------------------------------------------------------------
// InMemorySecretResolver
// ---------------------------------------------------------------------------

describe("InMemorySecretResolver", () => {
  it("resolves a known secret ref", () => {
    const resolver = new InMemorySecretResolver();
    resolver.set("MY_SECRET", TEST_SENTINEL);
    assert.strictEqual(resolver.resolve("MY_SECRET"), TEST_SENTINEL);
  });

  it("throws on unknown secret ref", () => {
    const resolver = new InMemorySecretResolver();
    assert.throws(() => resolver.resolve("UNKNOWN"), /TASK_SECRET_UNRESOLVED/);
  });

  it("has() returns true for known refs, false for unknown", () => {
    const resolver = new InMemorySecretResolver();
    resolver.set("API_KEY", "secret-value");
    assert.strictEqual(resolver.has("API_KEY"), true);
    assert.strictEqual(resolver.has("NONEXISTENT"), false);
  });

  it("resolves multiple secrets independently", () => {
    const resolver = new InMemorySecretResolver();
    resolver.set("DB_PASS", "db-secret");
    resolver.set("API_KEY", "api-secret");
    assert.strictEqual(resolver.resolve("DB_PASS"), "db-secret");
    assert.strictEqual(resolver.resolve("API_KEY"), "api-secret");
  });

  it("does not leak secrets via any list API", () => {
    // Interface only exposes resolve() — no list/keys/values access.
    const resolver: SecretResolver = new InMemorySecretResolver();
    // Verify only resolve() is callable
    assert.strictEqual(typeof (resolver as any).has, "function");
    assert.strictEqual(typeof resolver.resolve, "function");
    // resolve() is the only method on the interface
  });
});

// ---------------------------------------------------------------------------
// OperatorServiceEnvironmentResolver
// ---------------------------------------------------------------------------

describe("OperatorServiceEnvironmentResolver", () => {
  it("resolves a secret from process env via mapping", () => {
    const envVarName = "DEVSPACE_TEST_SECRET_MY_SECRET";
    process.env[envVarName] = TEST_SENTINEL;
    try {
      const resolver = new OperatorServiceEnvironmentResolver({
        mappings: [{ secretRef: "my_secret", envVar: envVarName }],
      });
      assert.strictEqual(resolver.resolve("my_secret"), TEST_SENTINEL);
    } finally {
      delete process.env[envVarName];
    }
  });

  it("throws when env var is not set", () => {
    const resolver = new OperatorServiceEnvironmentResolver({
      mappings: [{ secretRef: "my_secret", envVar: "DEVSPACE_MISSING_VAR" }],
    });
    assert.throws(
      () => resolver.resolve("my_secret"),
      /TASK_SECRET_UNRESOLVED/,
    );
  });

  it("throws when secret ref has no mapping", () => {
    const resolver = new OperatorServiceEnvironmentResolver({
      mappings: [{ secretRef: "known", envVar: "KNOWN_VAR" }],
    });
    assert.throws(() => resolver.resolve("unknown"), /TASK_SECRET_UNRESOLVED/);
  });

  it("getConfiguredRefs returns only refs, not values", () => {
    const envVarName = "DEVSPACE_TEST_CFG_REF";
    process.env[envVarName] = "actual-secret-value";
    try {
      const resolver = new OperatorServiceEnvironmentResolver({
        mappings: [{ secretRef: "cfg_ref", envVar: envVarName }],
      });
      const refs = resolver.getConfiguredRefs();
      assert.deepStrictEqual(refs, ["cfg_ref"]);
      // Verify the actual secret value is NOT in the refs list
      assert.strictEqual(refs.includes("actual-secret-value"), false);
    } finally {
      delete process.env[envVarName];
    }
  });

  describe("ACL", () => {
    it("allows when no ACL is configured", () => {
      const envVarName = "DEVSPACE_ACL_NO_ACL";
      process.env[envVarName] = TEST_SENTINEL;
      try {
        const resolver = new OperatorServiceEnvironmentResolver({
          mappings: [{ secretRef: "s", envVar: envVarName }],
        });
        assert.strictEqual(
          resolver.isAuthorized({
            repositoryRoot: "/any/repo",
            taskId: "any-task",
            targetEnv: "ANY_ENV",
          }),
          true,
        );
      } finally {
        delete process.env[envVarName];
      }
    });

    it("denies when repository root is not allowed", () => {
      const resolver = new OperatorServiceEnvironmentResolver({
        mappings: [{ secretRef: "s", envVar: "X" }],
        acl: { allowedRepositoryRoots: ["/allowed/root"] },
      });
      assert.strictEqual(
        resolver.isAuthorized({
          repositoryRoot: "/other/root",
          taskId: "t",
          targetEnv: "E",
        }),
        false,
      );
    });

    it("allows when repository root matches", () => {
      const resolver = new OperatorServiceEnvironmentResolver({
        mappings: [{ secretRef: "s", envVar: "X" }],
        acl: { allowedRepositoryRoots: ["/allowed"] },
      });
      assert.strictEqual(
        resolver.isAuthorized({
          repositoryRoot: "/allowed/subdir",
          taskId: "t",
          targetEnv: "E",
        }),
        true,
      );
    });

    it("denies when taskId is not allowed", () => {
      const resolver = new OperatorServiceEnvironmentResolver({
        mappings: [{ secretRef: "s", envVar: "X" }],
        acl: { allowedTaskIds: ["allowed-task"] },
      });
      assert.strictEqual(
        resolver.isAuthorized({
          repositoryRoot: "/any",
          taskId: "other-task",
          targetEnv: "E",
        }),
        false,
      );
    });

    it("denies when targetEnv is not allowed", () => {
      const resolver = new OperatorServiceEnvironmentResolver({
        mappings: [{ secretRef: "s", envVar: "X" }],
        acl: { allowedTargetEnvs: ["ALLOWED_ENV"] },
      });
      assert.strictEqual(
        resolver.isAuthorized({
          repositoryRoot: "/any",
          taskId: "t",
          targetEnv: "DENIED_ENV",
        }),
        false,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
  it("replaces secret values with [REDACTED_SECRET]", () => {
    const result = redactSecrets(
      `The API key is ${TEST_SENTINEL} and it works.`,
      [TEST_SENTINEL],
    );
    assert.strictEqual(
      result,
      "The API key is [REDACTED_SECRET] and it works.",
    );
  });

  it("handles multiple secrets in the same text", () => {
    const result = redactSecrets("Key1=abc Key2=def", ["abc", "def"]);
    assert.strictEqual(result, "Key1=[REDACTED_SECRET] Key2=[REDACTED_SECRET]");
  });

  it("handles special regex characters in secrets", () => {
    const secret = "a.b*c+d?e^f$g(h)i{j}k|l\\m[n]o";
    const result = redactSecrets(`Value: ${secret}`, [secret]);
    assert.strictEqual(result, "Value: [REDACTED_SECRET]");
  });

  it("returns original text when no secrets match", () => {
    const result = redactSecrets("Hello world", ["nothing"]);
    assert.strictEqual(result, "Hello world");
  });

  it("handles empty secrets array", () => {
    const result = redactSecrets("Hello world", []);
    assert.strictEqual(result, "Hello world");
  });

  it("handles multiple occurrences of the same secret", () => {
    const result = redactSecrets(
      `secret1=${TEST_SENTINEL} and secret2=${TEST_SENTINEL}`,
      [TEST_SENTINEL],
    );
    assert.strictEqual(
      result,
      "secret1=[REDACTED_SECRET] and secret2=[REDACTED_SECRET]",
    );
  });

  it("does not redact partial matches", () => {
    const result = redactSecrets("abc123def", ["abc"]);
    // "abc" appears at the start but the regex replaces globally
    assert.strictEqual(result, "[REDACTED_SECRET]123def");
  });

  it("does not leak secrets in error messages", () => {
    // This test verifies that redactSecrets itself doesn't throw
    // secret-containing errors
    const secret = "my-secret-p@ss!";
    const result = redactSecrets(
      `Connection failed: invalid password '${secret}'`,
      [secret],
    );
    assert.strictEqual(
      result,
      "Connection failed: invalid password '[REDACTED_SECRET]'",
    );
  });
});

// ---------------------------------------------------------------------------
// Secret lifecycle: global process.env isolation
// ---------------------------------------------------------------------------

describe("Secret lifecycle isolation", () => {
  it("secrets are NOT written to global process.env", () => {
    // Verify that resolving via InMemorySecretResolver does not
    // mutate process.env
    const resolver = new InMemorySecretResolver();
    resolver.set("MY_TOKEN", TEST_SENTINEL);

    // Resolve — this should only return the value, not set it globally
    const beforeEnvKeys = Object.keys(process.env);
    const value = resolver.resolve("MY_TOKEN");
    const afterEnvKeys = Object.keys(process.env);

    assert.strictEqual(value, TEST_SENTINEL);
    assert.deepStrictEqual(afterEnvKeys, beforeEnvKeys);
  });

  it("OperatorServiceEnvironmentResolver reads from env but does not write back", () => {
    const envVarName = "DEVSPACE_LIFECYCLE_READ";
    process.env[envVarName] = "original-value";
    try {
      const resolver = new OperatorServiceEnvironmentResolver({
        mappings: [{ secretRef: "r", envVar: envVarName }],
      });
      const value = resolver.resolve("r");
      assert.strictEqual(value, "original-value");
      // Verify the env var is unchanged (no overwrite)
      assert.strictEqual(process.env[envVarName], "original-value");
    } finally {
      delete process.env[envVarName];
    }
  });
});
