import type Database from "better-sqlite3";

export function migrateMcp(sql: Database.Database) {
  sql.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    last_used_at INTEGER, revoked_at INTEGER,
    rate_window INTEGER NOT NULL DEFAULT 0, rate_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS mcp_tokens_account ON mcp_tokens(account_id);`);
}
