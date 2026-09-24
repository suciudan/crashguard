"use server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ActionError, runAction } from "@/lib/action-guard";
import { requireProject, projectScope } from "@/lib/access";
import {
  listTelemetry,
  telemetryDetail,
  telemetryDb,
  telemetryKinds,
  recordRelease,
  playbackEvents,
} from "@/lib/telemetry";
import { uploadSourceMap } from "@/lib/sourcemaps";
import { validateWebhook } from "@/lib/jobs";
function projectId(value: unknown) {
  const id = z.number().int().positive().parse(value);
  requireProject(id);
  return id;
}
export async function getTelemetry(input: {
  project?: number;
  kind: string;
  q?: string;
  offset?: number;
  trace?: string;
  event?: string;
}) {
  return runAction(() =>
    listTelemetry(
      z
        .object({
          project: z.number().int().positive().optional(),
          kind: z.enum(telemetryKinds),
          q: z.string().max(200).optional(),
          offset: z.number().int().min(0).max(1000000).optional(),
          trace: z
            .string()
            .regex(/^[a-f0-9]{32}$/i)
            .optional(),
          event: z
            .string()
            .regex(/^[a-f0-9]{32}$/i)
            .optional(),
        })
        .parse(input),
    ),
  );
}
export async function getTelemetryDetail(id: number) {
  return runAction(() => {
    const row = telemetryDetail(z.number().int().positive().parse(id));
    if (!row) throw new ActionError("Telemetry not found.");
    const job = telemetryDb()
      .prepare("SELECT id,status,error,result FROM jobs WHERE dedup=?")
      .get(`minidump:${id}`) as
      | { id: number; status: string; error: string; result: string | null }
      | undefined;
    return {
      row,
      processing: job
        ? { ...job, result: job.result ? JSON.parse(job.result) : null }
        : null,
    };
  });
}
export async function downloadAttachment(id: number) {
  return runAction(() => {
    const file = telemetryDb()
      .prepare(
        `SELECT name,binary FROM telemetry WHERE id=? AND kind='attachment' AND ${projectScope()}`,
      )
      .get(z.number().int().positive().parse(id)) as
      { name: string; binary: Buffer } | undefined;
    if (!file) throw new ActionError("Attachment not found.");
    return { name: file.name, data: file.binary.toString("base64") };
  });
}
export async function getReplay(id: number) {
  return runAction(() => {
    const row = telemetryDetail(z.number().int().positive().parse(id));
    if (!row || !["replay_event", "replay_recording"].includes(row.kind))
      throw new ActionError("Replay not found.");
    const replayId = String(row.payload.replay_id || row.event_id);
    const parts = telemetryDb()
      .prepare(
        "SELECT payload FROM telemetry WHERE project_id=? AND kind='replay_recording' AND external_id LIKE ? ORDER BY CAST(json_extract(payload,'$.segment_id') AS INTEGER)",
      )
      .all(row.project_id, `${replayId}:%`) as { payload: string }[];
    if (
      parts.reduce((size, p) => size + Buffer.byteLength(p.payload), 0) >
      64 * 1024 * 1024
    )
      throw new ActionError(
        "This replay exceeds the 64 MB playback limit. Open a shorter recording.",
      );
    const records = parts.map((p) => JSON.parse(p.payload));
    const segments = records.map((p) => p.segment_id as number);
    return {
      events: playbackEvents(
        records.flatMap(
          (p) =>
            p.events as { type: number; timestamp: number; data: unknown }[],
        ),
      ),
      incomplete: !segments.length || segments.some((n, i) => n !== i),
    };
  });
}
export async function getReleases(project?: number) {
  return runAction(() => {
    if (project) projectId(project);
    return telemetryDb()
      .prepare(
        `SELECT r.*, p.name AS project_name,
      (SELECT COUNT(*) FROM events e WHERE e.project_id=r.project_id AND e.release=r.version) AS events,
      (SELECT COUNT(*) FROM source_maps s WHERE s.project_id=r.project_id AND s.release=r.version) AS maps
      FROM releases r JOIN projects p ON p.id=r.project_id WHERE ${projectScope("r.project_id")} ${project ? "AND r.project_id=?" : ""} ORDER BY r.created_at DESC LIMIT 200`,
      )
      .all(...(project ? [project] : [])) as {
      id: number;
      project_id: number;
      project_name: string;
      version: string;
      created_at: string;
      finalized_at: string | null;
      url: string;
      notes: string;
      events: number;
      maps: number;
    }[];
  });
}
export async function saveRelease(input: {
  project: number;
  version: string;
  notes: string;
  url: string;
  finalized: boolean;
}) {
  return runAction(() => {
    const data = z
      .object({
        project: z.number(),
        version: z.string().trim().min(1).max(300),
        notes: z.string().max(10000),
        url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
        finalized: z.boolean(),
      })
      .parse(input);
    projectId(data.project);
    recordRelease(data.project, data.version);
    telemetryDb()
      .prepare(
        "UPDATE releases SET notes=?,url=?,finalized_at=CASE WHEN ? THEN COALESCE(finalized_at,?) ELSE NULL END WHERE project_id=? AND version=?",
      )
      .run(
        data.notes,
        data.url,
        data.finalized ? 1 : 0,
        new Date().toISOString(),
        data.project,
        data.version,
      );
    return { ok: true };
  });
}
export async function addSourceMap(form: FormData) {
  return runAction(async () => {
    const project = projectId(Number(form.get("project")));
    const file = form.get("file");
    if (!(file instanceof File) || file.size > 20 * 1024 * 1024)
      throw new ActionError("Select a source map smaller than 20 MB.");
    const release = z
      .string()
      .max(300)
      .parse(form.get("release") || "");
    const filename = z
      .string()
      .max(2000)
      .parse(form.get("filename") || "");
    const debugId = z
      .string()
      .max(100)
      .parse(form.get("debugId") || "");
    try {
      uploadSourceMap(project, release, filename, debugId, await file.text());
    } catch (e) {
      throw new ActionError(
        e instanceof Error ? e.message : "Invalid source map.",
      );
    }
    recordRelease(project, release);
    return { ok: true };
  });
}
export async function getSourceMaps(project?: number) {
  return runAction(() => {
    if (project) projectId(project);
    return telemetryDb()
      .prepare(
        `SELECT id,project_id,release,filename,debug_id,created_at FROM source_maps WHERE ${projectScope()} ${project ? "AND project_id=?" : ""} ORDER BY id DESC LIMIT 200`,
      )
      .all(...(project ? [project] : [])) as {
      id: number;
      project_id: number;
      release: string;
      filename: string;
      debug_id: string;
      created_at: string;
    }[];
  });
}
export async function deleteSourceMap(id: number) {
  return runAction(() => {
    telemetryDb()
      .prepare(`DELETE FROM source_maps WHERE id=? AND ${projectScope()}`)
      .run(z.number().int().positive().parse(id));
    return { ok: true };
  });
}
export async function getAlerts() {
  return runAction(() => ({
    rules: telemetryDb()
      .prepare(
        `SELECT id,project_id,name,url,enabled,minimum_level FROM alert_rules WHERE ${projectScope()} ORDER BY id DESC`,
      )
      .all() as {
      id: number;
      project_id: number;
      name: string;
      url: string;
      enabled: number;
      minimum_level: string;
    }[],
    deliveries: telemetryDb()
      .prepare(
        `SELECT id,status,attempts,error,created_at,json_extract(payload,'$.rule') AS rule,json_extract(payload,'$.issue') AS issue FROM jobs WHERE kind='alert' AND ${jobScope()} ORDER BY id DESC LIMIT 100`,
      )
      .all() as {
      id: number;
      status: string;
      attempts: number;
      error: string;
      created_at: number;
      rule: number;
      issue: number;
    }[],
  }));
}
export async function addAlert(input: {
  project: number;
  name: string;
  url: string;
  level: string;
}) {
  return runAction(async () => {
    const data = z
      .object({
        project: z.number(),
        name: z.string().trim().min(1).max(100),
        url: z.url().max(2000),
        level: z.enum(["warning", "error", "fatal"]),
      })
      .parse(input);
    projectId(data.project);
    try {
      await validateWebhook(data.url);
    } catch (e) {
      throw new ActionError((e as Error).message);
    }
    const secret = randomBytes(32).toString("hex");
    telemetryDb()
      .prepare(
        "INSERT INTO alert_rules(project_id,name,url,secret,minimum_level) VALUES(?,?,?,?,?)",
      )
      .run(data.project, data.name, data.url, secret, data.level);
    return { secret };
  });
}
export async function setAlertEnabled(id: number, enabled: boolean) {
  return runAction(() => {
    telemetryDb()
      .prepare(
        `UPDATE alert_rules SET enabled=? WHERE id=? AND ${projectScope()}`,
      )
      .run(
        z.boolean().parse(enabled) ? 1 : 0,
        z.number().int().positive().parse(id),
      );
    return { ok: true };
  });
}
export async function retryJob(id: number) {
  return runAction(() => {
    const result = telemetryDb()
      .prepare(
        `UPDATE jobs SET status='pending',attempts=0,available_at=?,error='',result=NULL WHERE id=? AND status='failed' AND ${jobScope()}`,
      )
      .run(Date.now(), z.number().int().positive().parse(id));
    if (!result.changes)
      throw new ActionError("Only failed jobs can be retried.");
    return { ok: true };
  });
}
export async function findRelatedReplay(project: number, replayId: string) {
  return runAction(() => {
    projectId(project);
    z.string()
      .regex(/^[a-f0-9]{32}$/i)
      .parse(replayId);
    const row = telemetryDb()
      .prepare(
        "SELECT id FROM telemetry WHERE project_id=? AND kind='replay_event' AND external_id LIKE ? ORDER BY id DESC LIMIT 1",
      )
      .get(project, `${replayId}:%`) as { id: number } | undefined;
    if (!row) throw new ActionError("Replay has not arrived yet.");
    return row.id;
  });
}

function jobScope() {
  return `((kind='alert' AND json_extract(payload,'$.rule') IN (SELECT id FROM alert_rules WHERE ${projectScope()})) OR (kind='minidump' AND json_extract(payload,'$.attachment') IN (SELECT id FROM telemetry WHERE ${projectScope()})))`;
}
