import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { normalizeEvent } from "./events";
import type {
  Project,
  SentryEvent,
  Issue,
  StoredEvent,
  DashboardData,
} from "./types";
let instance: Database.Database;
export function db() {
  if (instance) return instance;
  const path = resolve(
    /* turbopackIgnore: true */ process.env.DATABASE_PATH ||
      "./data/crashguard.sqlite",
  );
  mkdirSync(dirname(path), { recursive: true });
  instance = new Database(path);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  instance.pragma("busy_timeout = 5000");
  instance.exec(`
    CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, platform TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS issues (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), fingerprint TEXT NOT NULL, title TEXT NOT NULL, culprit TEXT NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unresolved', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(project_id, fingerprint));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id), issue_id INTEGER NOT NULL REFERENCES issues(id), received_at TEXT NOT NULL, occurred_at TEXT NOT NULL, environment TEXT NOT NULL, release TEXT NOT NULL, user_key TEXT, payload TEXT NOT NULL, UNIQUE(project_id, event_id));
    CREATE INDEX IF NOT EXISTS events_issue ON events(issue_id, received_at);
    CREATE INDEX IF NOT EXISTS events_time ON events(received_at);
    CREATE INDEX IF NOT EXISTS events_project_time ON events(project_id, received_at);
    CREATE TABLE IF NOT EXISTS rate_limits (project_id INTEGER PRIMARY KEY REFERENCES projects(id), window INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_identity (id INTEGER PRIMARY KEY CHECK(id = 1), user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_challenges (token_hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, session_hash TEXT, expires_at INTEGER NOT NULL);
  `);
  return instance;
}
export function createProject(name: string, platform: string): Project {
  const result = db()
    .prepare(
      "INSERT INTO projects(name, platform, public_key, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      name,
      platform,
      randomBytes(16).toString("hex"),
      new Date().toISOString(),
    );
  return getProject(Number(result.lastInsertRowid))!;
}
export function getProject(id: number) {
  return db().prepare("SELECT * FROM projects WHERE id = ?").get(id) as
    Project | undefined;
}
export function projects() {
  return db()
    .prepare(
      "SELECT p.*, (SELECT COUNT(*) FROM events e WHERE e.project_id = p.id) AS event_count FROM projects p ORDER BY p.id",
    )
    .all() as Project[];
}
export function takeRateLimit(projectId: number) {
  const minute = Math.floor(Date.now() / 60000);
  const configured = Number(process.env.INGEST_RATE_LIMIT || 120);
  const limit =
    Number.isFinite(configured) && configured > 0 ? configured : 120;
  return db().transaction(() => {
    db()
      .prepare(
        "INSERT INTO rate_limits VALUES (?, ?, 1) ON CONFLICT(project_id) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END, window = excluded.window",
      )
      .run(projectId, minute);
    return (
      (
        db()
          .prepare("SELECT count FROM rate_limits WHERE project_id = ?")
          .get(projectId) as { count: number }
      ).count <= limit
    );
  })();
}
export function saveEvents(projectId: number, inputs: SentryEvent[]) {
  const normalized = inputs.map(normalizeEvent);
  return db().transaction(() =>
    normalized.map((n) => {
      const existing = db()
        .prepare("SELECT id FROM events WHERE project_id = ? AND event_id = ?")
        .get(projectId, n.event.event_id!);
      if (existing) return n.event.event_id!;
      const now = new Date().toISOString();
      db()
        .prepare(
          `INSERT INTO issues(project_id, fingerprint, title, culprit, level, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, fingerprint) DO UPDATE SET last_seen = excluded.last_seen, title = excluded.title, culprit = excluded.culprit, level = excluded.level, status = CASE WHEN issues.status = 'resolved' THEN 'unresolved' ELSE issues.status END`,
        )
        .run(projectId, n.fingerprint, n.title, n.culprit, n.level, now, now);
      const issue = db()
        .prepare(
          "SELECT id FROM issues WHERE project_id = ? AND fingerprint = ?",
        )
        .get(projectId, n.fingerprint) as { id: number };
      db()
        .prepare(
          "INSERT INTO events(event_id, project_id, issue_id, received_at, occurred_at, environment, release, user_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          n.event.event_id!,
          projectId,
          issue.id,
          now,
          n.occurred,
          n.event.environment || "production",
          n.event.release || "",
          n.userKey,
          JSON.stringify(n.event),
        );
      return n.event.event_id!;
    }),
  )();
}
export function dashboard(
  params: URLSearchParams,
): Omit<DashboardData, "sections"> {
  const hours = [24, 168, 720].includes(Number(params.get("hours")))
    ? Number(params.get("hours"))
    : 24;
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const where = ["e.received_at >= ?"];
  const args: (string | number)[] = [since];
  if (params.get("project")) {
    where.push("e.project_id = ?");
    args.push(Number(params.get("project")) || -1);
  }
  if (params.get("environment")) {
    where.push("e.environment = ?");
    args.push(params.get("environment")!);
  }
  if (params.get("release")) {
    where.push("e.release = ?");
    args.push(params.get("release")!);
  }
  const base = where.join(" AND ");
  const stats = db()
    .prepare(
      `SELECT COUNT(*) AS events, COUNT(DISTINCT e.issue_id) AS issues, COUNT(DISTINCT CASE WHEN i.status = 'unresolved' THEN i.id END) AS active, COUNT(DISTINCT e.user_key) AS users, COUNT(DISTINCT CASE WHEN i.status = 'resolved' THEN i.id END) AS resolved FROM events e JOIN issues i ON i.id=e.issue_id WHERE ${base}`,
    )
    .get(...args) as DashboardData["stats"];
  const activity = db()
    .prepare(
      `SELECT substr(e.received_at,1,13) AS hour, COUNT(*) AS count FROM events e WHERE ${base} GROUP BY hour ORDER BY hour`,
    )
    .all(...args) as DashboardData["activity"];
  if (params.get("status") && params.get("status") !== "all") {
    where.push("i.status = ?");
    args.push(params.get("status")!);
  }
  if (params.get("q")) {
    where.push("(i.title LIKE ? OR i.culprit LIKE ? OR p.name LIKE ?)");
    const q = `%${params.get("q")!.slice(0, 200)}%`;
    args.push(q, q, q);
  }
  const join = `FROM issues i JOIN projects p ON p.id = i.project_id JOIN events e ON e.issue_id = i.id WHERE ${where.join(" AND ")}`;
  const total = (
    db()
      .prepare(`SELECT COUNT(DISTINCT i.id) AS total ${join}`)
      .get(...args) as { total: number }
  ).total;
  const offset = Math.max(
    0,
    Math.min(1000000, Math.floor(Number(params.get("offset")) || 0)),
  );
  const order =
    params.get("sort") === "frequency"
      ? "event_count DESC, last_seen DESC"
      : "last_seen DESC";
  const issues = db()
    .prepare(
      `SELECT i.*, p.name AS project_name, p.platform, COUNT(*) AS event_count, COUNT(DISTINCT e.user_key) AS user_count, MAX(e.received_at) AS last_seen, CASE WHEN COUNT(DISTINCT e.environment) > 1 THEN 'multiple' ELSE MIN(e.environment) END AS environment ${join} GROUP BY i.id ORDER BY ${order} LIMIT 30 OFFSET ?`,
    )
    .all(...args, offset) as Issue[];
  const environments = (
    db()
      .prepare(
        "SELECT 'production' AS environment UNION SELECT environment FROM events ORDER BY environment",
      )
      .all() as { environment: string }[]
  ).map((e) => e.environment);
  return { projects: projects(), issues, total, stats, activity, environments };
}
export function issueDetail(id: number, eventId?: string) {
  const issue = db()
    .prepare(
      "SELECT i.*, p.name AS project_name, p.platform, (SELECT COUNT(*) FROM events WHERE issue_id = i.id) AS event_count, (SELECT COUNT(DISTINCT user_key) FROM events WHERE issue_id = i.id) AS user_count FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = ?",
    )
    .get(id) as Issue | undefined;
  if (!issue) return null;
  const events = db()
    .prepare(
      "SELECT * FROM events WHERE issue_id = ? ORDER BY received_at DESC, id DESC LIMIT 50",
    )
    .all(id) as (Omit<StoredEvent, "payload"> & { payload: string })[];
  // A shared occurrence stays accessible even after it leaves the latest 50.
  if (eventId && !events.some((event) => event.event_id === eventId)) {
    const selected = db()
      .prepare("SELECT * FROM events WHERE issue_id = ? AND event_id = ?")
      .get(id, eventId) as (typeof events)[number] | undefined;
    if (selected) events.push(selected);
  }
  return {
    issue,
    events: events.map((e) => ({
      ...e,
      payload: JSON.parse(e.payload) as SentryEvent,
    })),
  };
}
export function setStatus(id: number, status: string) {
  return db()
    .prepare("UPDATE issues SET status = ? WHERE id = ?")
    .run(status, id).changes;
}
