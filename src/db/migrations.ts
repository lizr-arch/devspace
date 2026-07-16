import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "project-memory-shadow-state",
    up: migrateProjectMemoryShadowState,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite
          .prepare("select version from devspace_schema_migrations")
          .all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(
    sqlite,
    "workspace_sessions",
    "mode",
    "text not null default 'checkout'",
  );
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(
    sqlite,
    "workspace_sessions",
    "managed",
    "text not null default 'false'",
  );
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateProjectMemoryShadowState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists project_memory_receipts (
      receipt_id text primary key,
      workspace_session_id text not null,
      mode text not null,
      task_sha256 text not null,
      receipt_json text not null,
      expires_at text not null,
      created_at text not null,
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists project_memory_receipts_workspace_idx
      on project_memory_receipts(workspace_session_id, created_at desc);
    create index if not exists project_memory_receipts_expiry_idx
      on project_memory_receipts(expires_at);

    create table if not exists project_memory_active_state (
      workspace_session_id text primary key,
      receipt_id text,
      decision text not null,
      would_deny integer not null,
      denial_reasons_json text not null,
      bundle_delivered_at text,
      updated_at text not null,
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade,
      foreign key (receipt_id)
        references project_memory_receipts(receipt_id)
    );

    create index if not exists project_memory_active_receipt_idx
      on project_memory_active_state(receipt_id);

    create table if not exists project_memory_access_events (
      id text primary key,
      workspace_session_id text not null,
      receipt_id text,
      event_type text not null,
      tool_name text,
      outcome text not null,
      details_json text not null,
      created_at text not null,
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists project_memory_access_workspace_idx
      on project_memory_access_events(workspace_session_id, created_at desc);
    create index if not exists project_memory_access_receipt_idx
      on project_memory_access_events(receipt_id);

    create table if not exists project_memory_privilege_authorizations (
      authorization_id text primary key,
      workspace_session_id text not null,
      task_sha256 text not null,
      mode text not null,
      expires_at text not null,
      consumed_at text,
      created_at text not null,
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists project_memory_privilege_workspace_idx
      on project_memory_privilege_authorizations(workspace_session_id, expires_at);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
