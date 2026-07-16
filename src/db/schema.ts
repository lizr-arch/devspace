import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const oauthClients = sqliteTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientJson: text("client_json").notNull(),
  issuedAt: integer("issued_at").notNull(),
});

export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  scopesJson: text("scopes_json").notNull(),
  expiresAt: integer("expires_at").notNull(),
  resource: text("resource"),
});

export const oauthRefreshTokens = sqliteTable("oauth_refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  scopesJson: text("scopes_json").notNull(),
  expiresAt: integer("expires_at").notNull(),
  resource: text("resource"),
});

export const projectMemoryReceipts = sqliteTable(
  "project_memory_receipts",
  {
    receiptId: text("receipt_id").primaryKey(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    taskSha256: text("task_sha256").notNull(),
    receiptJson: text("receipt_json").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("project_memory_receipts_workspace_idx").on(
      table.workspaceSessionId,
      table.createdAt,
    ),
    index("project_memory_receipts_expiry_idx").on(table.expiresAt),
  ],
);

export const projectMemoryActiveState = sqliteTable(
  "project_memory_active_state",
  {
    workspaceSessionId: text("workspace_session_id")
      .primaryKey()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    receiptId: text("receipt_id").references(
      () => projectMemoryReceipts.receiptId,
    ),
    decision: text("decision").notNull(),
    wouldDeny: integer("would_deny").notNull(),
    denialReasonsJson: text("denial_reasons_json").notNull(),
    bundleDeliveredAt: text("bundle_delivered_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("project_memory_active_receipt_idx").on(table.receiptId)],
);

export const projectMemoryAccessEvents = sqliteTable(
  "project_memory_access_events",
  {
    id: text("id").primaryKey(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    receiptId: text("receipt_id"),
    eventType: text("event_type").notNull(),
    toolName: text("tool_name"),
    outcome: text("outcome").notNull(),
    detailsJson: text("details_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("project_memory_access_workspace_idx").on(
      table.workspaceSessionId,
      table.createdAt,
    ),
    index("project_memory_access_receipt_idx").on(table.receiptId),
  ],
);

export const projectMemoryPrivilegeAuthorizations = sqliteTable(
  "project_memory_privilege_authorizations",
  {
    authorizationId: text("authorization_id").primaryKey(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    taskSha256: text("task_sha256").notNull(),
    mode: text("mode").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("project_memory_privilege_workspace_idx").on(
      table.workspaceSessionId,
      table.expiresAt,
    ),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
