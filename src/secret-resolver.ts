// ---------------------------------------------------------------------------
// Secret Resolver — task-scoped Secret Binding for DevSpace M3
// ---------------------------------------------------------------------------
//
// The SecretResolver abstracts how a Secret Ref is resolved to a Secret Value.
// Only the VALUE is injected into the child process environment (never into
// global process.env). The VALUE is never logged, persisted, or returned in
// MCP results. stdout/stderr are scanned and redacted before the task result
// is handed back to the caller.
// ---------------------------------------------------------------------------

/**
 * Abstract interface for resolving secret references to their values.
 *
 * Implementations:
 *  - InMemorySecretResolver — for tests; stores secrets in a plain Map.
 *  - OperatorServiceEnvironmentResolver — reads from process environment
 *    using a configurable mapping (Secret Ref → env var name), with ACL
 *    (allowed repository roots, allowed task IDs, allowed target envs).
 *
 * Design constraints:
 *  - resolve() only — no list API, never leaking to MCP results.
 *  - Values are never cached longer than the caller's lifetime.
 */
export interface SecretResolver {
  /**
   * Resolve a single Secret Ref to its Secret Value.
   * MUST throw if the ref is unknown or unauthorized.
   */
  resolve(secretRef: string): string;
}

// ---------------------------------------------------------------------------
// InMemorySecretResolver — testing
// ---------------------------------------------------------------------------

/**
 * Stores secrets in-memory. Useful for unit tests.
 * Secrets are never persisted, never logged.
 */
export class InMemorySecretResolver implements SecretResolver {
  private readonly secrets = new Map<string, string>();

  /**
   * Register a secret ref → value mapping.
   */
  set(secretRef: string, value: string): void {
    this.secrets.set(secretRef, value);
  }

  resolve(secretRef: string): string {
    const value = this.secrets.get(secretRef);
    if (value === undefined) {
      throw new Error(
        `TASK_SECRET_UNRESOLVED: Unknown secret ref '${secretRef}'.`,
      );
    }
    return value;
  }

  /**
   * Check whether a ref is registered (for validation without resolving).
   */
  has(secretRef: string): boolean {
    return this.secrets.has(secretRef);
  }
}

// ---------------------------------------------------------------------------
// OperatorServiceEnvironmentResolver — production
// ---------------------------------------------------------------------------

export interface OperatorSecretMapping {
  /** The Secret Ref as declared in .devspace/tasks.yaml. */
  secretRef: string;
  /** The environment variable name to read the Secret Value from. */
  envVar: string;
}

export interface OperatorSecretACL {
  /**
   * Repository roots (workspace roots) for which secret resolution is allowed.
   * If empty, all roots are allowed.
   */
  allowedRepositoryRoots?: string[];
  /**
   * Task IDs for which secret resolution is allowed.
   * If empty, all tasks are allowed.
   */
  allowedTaskIds?: string[];
  /**
   * Target environment variable names that secrets may be injected into.
   * If empty, all target envs are allowed.
   */
  allowedTargetEnvs?: string[];
}

export interface OperatorServiceEnvironmentResolverOptions {
  /** Mapping from Secret Ref → env var name. */
  mappings: OperatorSecretMapping[];
  /** Access control lists. */
  acl?: OperatorSecretACL;
}

/**
 * Production SecretResolver — reads Secret Values from the operator service
 * process environment using a configured mapping table.
 *
 * Secrets are NEVER cached or persisted. Each resolve() call reads the
 * environment variable fresh. This means rotated secrets take effect on
 * the next resolve.
 */
export class OperatorServiceEnvironmentResolver implements SecretResolver {
  private readonly mappings: Map<string, string>;
  private readonly acl: OperatorSecretACL;

  constructor(options: OperatorServiceEnvironmentResolverOptions) {
    this.mappings = new Map(
      options.mappings.map((m) => [m.secretRef, m.envVar]),
    );
    this.acl = options.acl ?? {};
  }

  resolve(secretRef: string): string {
    // 1. Look up the mapping
    const envVar = this.mappings.get(secretRef);
    if (!envVar) {
      throw new Error(
        `TASK_SECRET_UNRESOLVED: No environment mapping for secret ref '${secretRef}'.`,
      );
    }

    // 2. Read from process environment
    const value = process.env[envVar];
    if (value === undefined || value === null) {
      throw new Error(
        `TASK_SECRET_UNRESOLVED: Environment variable '${envVar}' is not set.`,
      );
    }

    return value;
  }

  /**
   * Check whether a secret ref is authorized for a given context.
   * Called before resolution to gate access.
   */
  isAuthorized(context: {
    repositoryRoot: string;
    taskId: string;
    targetEnv: string;
  }): boolean {
    const { allowedRepositoryRoots, allowedTaskIds, allowedTargetEnvs } =
      this.acl;

    if (
      allowedRepositoryRoots &&
      allowedRepositoryRoots.length > 0 &&
      !allowedRepositoryRoots.some(
        (r) => context.repositoryRoot === r || context.repositoryRoot.startsWith(r),
      )
    ) {
      return false;
    }

    if (
      allowedTaskIds &&
      allowedTaskIds.length > 0 &&
      !allowedTaskIds.includes(context.taskId)
    ) {
      return false;
    }

    if (
      allowedTargetEnvs &&
      allowedTargetEnvs.length > 0 &&
      !allowedTargetEnvs.includes(context.targetEnv)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Returns the set of configured secret refs (for manifest validation).
   * This does NOT leak values — only the refs are returned.
   */
  getConfiguredRefs(): string[] {
    return Array.from(this.mappings.keys());
  }
}

// ---------------------------------------------------------------------------
// Redaction utility
// ---------------------------------------------------------------------------

/**
 * Redact all known secret values from a string, replacing each occurrence
 * with [REDACTED_SECRET].
 *
 * IMPORTANT: The `secrets` parameter contains the actual Secret Values.
 * This function MUST NOT log them or include them in any output.
 */
export function redactSecrets(
  text: string,
  secrets: string[],
): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret) continue;
    // Use a global replace — but since secrets may contain regex-special
    // characters, we need to escape them.
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), "[REDACTED_SECRET]");
  }
  return result;
}
