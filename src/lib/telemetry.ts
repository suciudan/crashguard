import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { db, saveEvents } from "./db";
import { scrub, validateEvent } from "./events";
import type { SentryEvent, SidebarSections } from "./types";

export type Item = {
  type: string;
  headers: Record<string, unknown>;
  payload: Buffer;
};
export const telemetryKinds = [
  "transaction",
  "log",
  "attachment",
  "replay_event",
  "replay_recording",
  "profile",
  "profile_chunk",
] as const;
export type TelemetryKind = (typeof telemetryKinds)[number];
export type TelemetryRow = {
  id: number;
  project_id: number;
  kind: TelemetryKind;
  external_id: string;
  event_id: string;
  trace_id: string;
  name: string;
  environment: string;
  release: string;
  occurred_at: string;
  received_at: string;
  duration: number;
  size: number;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
};
const initialized = new WeakSet<ReturnType<typeof db>>();
export function telemetryDb() {
  const sql = db();
  if (initialized.has(sql)) return sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL, external_id TEXT NOT NULL, event_id TEXT NOT NULL DEFAULT '',
      trace_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, environment TEXT NOT NULL DEFAULT '',
      release TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
      duration REAL NOT NULL DEFAULT 0, size INTEGER NOT NULL, metadata TEXT NOT NULL,
      payload TEXT NOT NULL, binary BLOB, UNIQUE(project_id, kind, external_id));
    CREATE INDEX IF NOT EXISTS telemetry_filter ON telemetry(project_id, kind, received_at);
    CREATE INDEX IF NOT EXISTS telemetry_kind ON telemetry(kind);
    CREATE INDEX IF NOT EXISTS telemetry_event ON telemetry(project_id, event_id);
    CREATE INDEX IF NOT EXISTS telemetry_trace ON telemetry(project_id, trace_id);
    CREATE TABLE IF NOT EXISTS releases (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), version TEXT NOT NULL,
      created_at TEXT NOT NULL, finalized_at TEXT, url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      UNIQUE(project_id,version));
    CREATE TABLE IF NOT EXISTS source_maps (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), release TEXT NOT NULL,
      filename TEXT NOT NULL, debug_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(project_id,release,filename,debug_id));
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      url TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      minimum_level TEXT NOT NULL DEFAULT 'error');
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, dedup TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '', result TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,available_at);
  `);
  initialized.add(sql);
  return sql;
}
export function sidebarSections(): SidebarSections {
  // Workspace navigation is independent of issue filters and time ranges.
  const row = telemetryDb()
    .prepare(
      `SELECT
    EXISTS(SELECT 1 FROM telemetry WHERE kind = 'transaction') AS transactions,
    EXISTS(SELECT 1 FROM telemetry WHERE kind = 'log') AS logs,
    EXISTS(SELECT 1 FROM telemetry WHERE kind IN ('replay_event', 'replay_recording')) AS replays,
    EXISTS(SELECT 1 FROM telemetry WHERE kind IN ('profile', 'profile_chunk')) AS profiles,
    EXISTS(SELECT 1 FROM telemetry WHERE kind = 'attachment') AS attachments,
    EXISTS(SELECT 1 FROM releases) AS releases,
    EXISTS(SELECT 1 FROM source_maps) AS sourcemaps,
    EXISTS(SELECT 1 FROM alert_rules) AS alerts
  `,
    )
    .get() as Record<keyof SidebarSections, number>;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Boolean(value)]),
  ) as SidebarSections;
}
const object = z.record(z.string(), z.unknown());
const hex = z.string().regex(/^[a-f0-9]{32}$/i);
const timestamp = z.number().finite().nonnegative();
const text = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.slice(0, 1000) : fallback;
const json = (bytes: Buffer) =>
  object.parse(JSON.parse(bytes.toString("utf8")));
const id = (value: unknown) => hex.parse(value).toLowerCase();
const date = (value: unknown) => {
  const d = new Date(
    typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? value
        : Date.now(),
  );
  if (!Number.isFinite(d.getTime())) throw new Error("Invalid timestamp");
  return d.toISOString();
};
export function enqueue(kind: string, dedup: string, payload: unknown) {
  telemetryDb()
    .prepare(
      "INSERT OR IGNORE INTO jobs(kind,dedup,payload,available_at,created_at) VALUES(?,?,?,?,?)",
    )
    .run(kind, dedup, JSON.stringify(payload), Date.now(), Date.now());
}
export function recordRelease(project: number, version: string) {
  if (version)
    telemetryDb()
      .prepare(
        "INSERT OR IGNORE INTO releases(project_id,version,created_at) VALUES(?,?,?)",
      )
      .run(project, version, new Date().toISOString());
}
export function decodeRecording(bytes: Buffer) {
  const boundary = bytes.indexOf(10);
  if (boundary < 0 || boundary > 8192)
    throw new Error("Invalid recording header");
  const header = json(bytes.subarray(0, boundary));
  const segment = z.number().int().nonnegative().parse(header.segment_id);
  let data = bytes.subarray(boundary + 1);
  if (data[0] !== 91)
    data = inflateSync(data, { maxOutputLength: 32 * 1024 * 1024 });
  const events = z
    .array(
      z
        .object({
          type: z.number().int(),
          timestamp: z.number().finite(),
          data: z.unknown(),
        })
        .passthrough(),
    )
    .max(100000)
    .parse(JSON.parse(data.toString()));
  return { segment, events };
}
export function playbackEvents(
  events: { type: number; timestamp: number; data: unknown }[],
) {
  // Sentry's custom breadcrumb/performance events use epoch seconds; rrweb uses milliseconds.
  return events
    .map((event) =>
      event.type === 5 && event.timestamp < 100_000_000_000
        ? { ...event, timestamp: event.timestamp * 1000 }
        : event,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}
export function saveEnvelope(
  project: number,
  headers: Record<string, unknown>,
  items: Item[],
) {
  // Validate every item before entering the transaction; malformed batches never partly commit.
  const rows: Omit<TelemetryRow, "id" | "project_id" | "received_at">[] = [];
  const binaries = new Map<number, Buffer>();
  const events: SentryEvent[] = [];
  let expandedBytes = 0;
  const discarded: string[] = [];
  const envelopeId = headers.event_id === undefined ? "" : id(headers.event_id);
  const replayMetadata = items.find((i) => i.type === "replay_event");
  const replay = replayMetadata ? json(replayMetadata.payload) : undefined;
  const add = (
    item: Item,
    value: Record<string, unknown>,
    external: string,
    name: string,
    duration = 0,
    binary?: Buffer,
  ) => {
    expandedBytes += binary?.length ?? Buffer.byteLength(JSON.stringify(value));
    if (expandedBytes > 64 * 1024 * 1024)
      throw new Error("Expanded telemetry exceeds 64 MB");
    if (binary) binaries.set(rows.length, binary);
    const context = object.safeParse(value.contexts).data;
    const trace = object.safeParse(context?.trace).data;
    const attributes = object.safeParse(value.attributes).data;
    const attribute = (key: string) => {
      const v = attributes?.[key];
      return typeof v === "object" && v ? (v as { value?: unknown }).value : v;
    };
    rows.push({
      kind: item.type as TelemetryKind,
      external_id: external,
      event_id: envelopeId,
      trace_id: text(value.trace_id || trace?.trace_id),
      name: name.slice(0, 1000),
      environment: text(value.environment || attribute("sentry.environment")),
      release: text(value.release || attribute("sentry.release")),
      occurred_at: date(value.timestamp || value.start_timestamp),
      duration,
      size: binary?.length ?? Buffer.byteLength(JSON.stringify(value)),
      metadata: scrub(item.headers) as Record<string, unknown>,
      payload: scrub(value) as Record<string, unknown>,
    });
  };
  for (const item of items) {
    if (item.type === "event") {
      if (item.payload.length > 1024 * 1024)
        throw new Error("Error events exceed the 1 MB limit");
      const value = json(item.payload);
      value.event_id ||= envelopeId || randomUUID().replaceAll("-", "");
      value.sdk ||= headers.sdk;
      events.push(validateEvent(value));
    } else if (item.type === "transaction") {
      const value = json(item.payload);
      const start = timestamp.parse(value.start_timestamp),
        end = timestamp.parse(value.timestamp);
      if (end < start) throw new Error("Transaction ends before it starts");
      const spans = z
        .array(object)
        .max(10000)
        .parse(value.spans ?? []);
      for (const span of spans) {
        timestamp.parse(span.start_timestamp);
        timestamp.parse(span.timestamp);
        z.string()
          .regex(/^[a-f0-9]{16}$/i)
          .parse(span.span_id);
      }
      add(
        item,
        value,
        id(value.event_id || envelopeId),
        text(value.transaction, "Transaction"),
        (end - start) * 1000,
      );
    } else if (item.type === "log") {
      const container = json(item.payload);
      if (
        container.version !== undefined &&
        container.version !== 1 &&
        container.version !== 2
      )
        throw new Error("Unsupported log version");
      const logs = z.array(object).max(1000).parse(container.items);
      logs.forEach((log, index) => {
        timestamp.parse(log.timestamp);
        z.string().max(1000000).parse(log.body);
        z.enum([
          "trace",
          "debug",
          "info",
          "warn",
          "warning",
          "error",
          "fatal",
        ]).parse(log.level);
        add(
          item,
          log,
          createHash("sha256")
            .update(item.payload)
            .update(String(index))
            .digest("hex"),
          text(log.body),
        );
      });
    } else if (item.type === "attachment") {
      if (!envelopeId) throw new Error("Attachment requires an event ID");
      const filename = text(item.headers.filename, "attachment.bin");
      const isDump = item.headers.attachment_type === "event.minidump";
      if (isDump && item.payload.subarray(0, 4).toString() !== "MDMP")
        throw new Error("Invalid minidump signature");
      add(
        item,
        {},
        `${envelopeId}:${createHash("sha256").update(filename).update(item.payload).digest("hex")}`,
        filename,
        0,
        item.payload,
      );
    } else if (item.type === "replay_event") {
      const value = json(item.payload);
      const segment = z.number().int().nonnegative().parse(value.segment_id);
      add(
        item,
        value,
        `${id(value.replay_id || envelopeId)}:${segment}`,
        text((value.urls as unknown[])?.[0], "Replay"),
      );
    } else if (item.type === "replay_recording") {
      const decoded = decodeRecording(item.payload);
      const replayId = id(replay?.replay_id || envelopeId);
      if (replay && replay.segment_id !== decoded.segment)
        throw new Error("Replay segment mismatch");
      add(
        item,
        {
          ...replay,
          replay_id: replayId,
          segment_id: decoded.segment,
          events: decoded.events,
        },
        `${replayId}:${decoded.segment}`,
        `Segment ${decoded.segment}`,
      );
    } else if (item.type === "profile" || item.type === "profile_chunk") {
      const value = json(item.payload);
      const profile = object.parse(value.profile ?? value);
      z.array(object).min(1).max(250000).parse(profile.samples);
      z.array(object).max(100000).parse(profile.frames);
      z.array(z.array(z.number().int().nonnegative()).max(1000))
        .max(100000)
        .parse(profile.stacks);
      const stacks = profile.stacks as number[][],
        frames = profile.frames as unknown[];
      if (stacks.some((stack) => stack.some((i) => i >= frames.length)))
        throw new Error("Invalid profile frame reference");
      for (const sample of profile.samples as Record<string, unknown>[]) {
        const stackId = z.number().int().nonnegative().parse(sample.stack_id);
        if (stackId >= stacks.length)
          throw new Error("Invalid profile stack reference");
      }
      add(
        item,
        value,
        id(value.chunk_id || value.event_id || envelopeId),
        text(value.platform, "Profile"),
      );
    } else discarded.push(item.type);
  }
  const sql = telemetryDb();
  return sql.transaction(() => {
    const fresh = events.filter(
      (e) =>
        !sql
          .prepare("SELECT 1 FROM events WHERE project_id=? AND event_id=?")
          .get(project, String(e.event_id).replaceAll("-", "").toLowerCase()),
    );
    const ids = saveEvents(project, events);
    for (const event of fresh) {
      recordRelease(project, event.release || "");
      const stored = sql
        .prepare(
          "SELECT issue_id,payload FROM events WHERE project_id=? AND event_id=?",
        )
        .get(
          project,
          String(event.event_id).replaceAll("-", "").toLowerCase(),
        ) as { issue_id: number; payload: string };
      const rules = sql
        .prepare(
          "SELECT id,minimum_level FROM alert_rules WHERE project_id=? AND enabled=1",
        )
        .all(project) as { id: number; minimum_level: string }[];
      const levels: Record<string, number> = {
        debug: 0,
        log: 1,
        info: 1,
        warning: 2,
        error: 3,
        fatal: 4,
      };
      for (const rule of rules)
        if (
          (levels[event.level || "error"] ?? 3) >=
          (levels[rule.minimum_level] ?? 3)
        )
          enqueue("alert", `alert:${rule.id}:${project}:${event.event_id}`, {
            rule: rule.id,
            project,
            issue: stored.issue_id,
            event: JSON.parse(stored.payload),
          });
    }
    let accepted = ids.length;
    rows.forEach((row, index) => {
      const result = sql
        .prepare(
          `INSERT OR IGNORE INTO telemetry(project_id,kind,external_id,event_id,trace_id,name,environment,release,occurred_at,received_at,duration,size,metadata,payload,binary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          project,
          row.kind,
          row.external_id,
          row.event_id,
          row.trace_id,
          row.name,
          row.environment,
          row.release,
          row.occurred_at,
          new Date().toISOString(),
          row.duration,
          row.size,
          JSON.stringify(row.metadata),
          JSON.stringify(row.payload),
          binaries.get(index) ?? null,
        );
      accepted++;
      recordRelease(project, row.release);
      if (result.changes && row.metadata.attachment_type === "event.minidump")
        enqueue("minidump", `minidump:${result.lastInsertRowid}`, {
          attachment: Number(result.lastInsertRowid),
          project,
          eventId: row.event_id,
        });
    });
    return { id: ids[0] || envelopeId || null, accepted, discarded };
  })();
}
export function listTelemetry(input: {
  project?: number;
  kind: string;
  q?: string;
  offset?: number;
  trace?: string;
  event?: string;
}) {
  const where = ["kind = ?"],
    args: (number | string)[] = [input.kind];
  if (input.project) {
    where.push("project_id=?");
    args.push(input.project);
  }
  if (input.q) {
    where.push("name LIKE ?");
    args.push(`%${input.q}%`);
  }
  if (input.trace) {
    where.push("trace_id=?");
    args.push(input.trace);
  }
  if (input.event) {
    where.push("event_id=?");
    args.push(input.event);
  }
  const sql = telemetryDb(),
    filter = where.join(" AND ");
  const total = (
    sql
      .prepare(`SELECT COUNT(*) AS total FROM telemetry WHERE ${filter}`)
      .get(...args) as { total: number }
  ).total;
  const rows = sql
    .prepare(
      `SELECT id,project_id,kind,external_id,event_id,trace_id,name,environment,release,occurred_at,received_at,duration,size,metadata FROM telemetry WHERE ${filter} ORDER BY received_at DESC,id DESC LIMIT 50 OFFSET ?`,
    )
    .all(...args, input.offset || 0) as (Omit<
    TelemetryRow,
    "metadata" | "payload"
  > & { metadata: string })[];
  return {
    total,
    rows: rows.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    })),
  };
}
export function telemetryDetail(id: number): TelemetryRow | null {
  const row = telemetryDb()
    .prepare(
      "SELECT id,project_id,kind,external_id,event_id,trace_id,name,environment,release,occurred_at,received_at,duration,size,metadata,payload FROM telemetry WHERE id=?",
    )
    .get(id) as
    | (Omit<TelemetryRow, "metadata" | "payload"> & {
        metadata: string;
        payload: string;
      })
    | undefined;
  return row
    ? {
        ...row,
        metadata: JSON.parse(row.metadata),
        payload: JSON.parse(row.payload),
      }
    : null;
}
