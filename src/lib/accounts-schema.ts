import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export function migrateAccounts(sql: Database.Database) {
  sql
    .transaction(() => {
      sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL,
        user_handle TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('owner','member')),
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_passkeys (
        credential_id TEXT PRIMARY KEY REFERENCES passkeys(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts(id));
      CREATE INDEX IF NOT EXISTS account_passkeys_account ON account_passkeys(account_id);
      CREATE TABLE IF NOT EXISTS project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id),
        account_id INTEGER NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, account_id));
      CREATE TABLE IF NOT EXISTS project_invitations (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
        token_hash TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES accounts(id),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        accepted_by INTEGER REFERENCES accounts(id), accepted_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS auth_enrollments (
        token_hash TEXT PRIMARY KEY REFERENCES auth_challenges(token_hash) ON DELETE CASCADE,
        data TEXT NOT NULL);
    `);
      if (
        sql
          .prepare("SELECT 1 FROM schema_migrations WHERE name='accounts-v1'")
          .get()
      )
        return;
      const legacy = sql
        .prepare("SELECT user_id FROM auth_identity WHERE id=1")
        .get() as { user_id: string } | undefined;
      const handle = legacy?.user_id || randomBytes(32).toString("base64url");
      sql
        .prepare(
          "INSERT INTO accounts(id,name,user_handle,role,created_at) VALUES(1,'Workspace owner',?,'owner',?)",
        )
        .run(handle, Date.now());
      sql
        .prepare("INSERT OR IGNORE INTO auth_identity(id,user_id) VALUES(1,?)")
        .run(handle);
      sql.exec(
        "INSERT INTO account_passkeys SELECT id,1 FROM passkeys; INSERT INTO schema_migrations VALUES('accounts-v1');",
      );
    })
    .immediate();
}
