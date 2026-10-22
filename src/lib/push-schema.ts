import type Database from "better-sqlite3";

export function migratePush(sql: Database.Database) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS push_vapid (
      id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
      last_test_at INTEGER);
    CREATE INDEX IF NOT EXISTS push_subscriptions_account ON push_subscriptions(account_id);
    CREATE TABLE IF NOT EXISTS push_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE, event_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('new','reopened','test')),
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '',
      UNIQUE(subscription_id,issue_id,event_id));
    CREATE INDEX IF NOT EXISTS push_deliveries_pending ON push_deliveries(status,available_at);
  `);
}

// Called inside the same transaction as issue/event ingestion. No network work
// happens here, so delivery survives restarts without slowing down SDK ingestion.
export function enqueueIssueNotifications(
  sql: Database.Database,
  projectId: number,
  issueId: number,
  eventId: string,
  kind: "new" | "reopened",
) {
  const now = Date.now();
  sql
    .prepare(
      `INSERT OR IGNORE INTO push_deliveries
    (subscription_id,issue_id,event_id,kind,available_at,created_at)
    SELECT s.id,?,?,?,?,? FROM push_subscriptions s JOIN accounts a ON a.id=s.account_id
    WHERE (s.expires_at IS NULL OR s.expires_at>?)
      AND EXISTS (SELECT 1 FROM account_passkeys k WHERE k.account_id=a.id)
      AND (a.role='owner' OR EXISTS (
        SELECT 1 FROM project_members m WHERE m.account_id=a.id AND m.project_id=?))`,
    )
    .run(issueId, eventId, kind, now, now, now, projectId);
}
