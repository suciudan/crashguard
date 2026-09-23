import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { createHmac } from "node:crypto";
import ipaddr from "ipaddr.js";
import { db } from "./db";
import { telemetryDb, saveEnvelope } from "./telemetry";
import type { SentryEvent, Frame } from "./types";

export async function validateWebhook(value: string) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP(S) webhook without URL credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowed = (process.env.ALERT_WEBHOOK_HOSTS || "")
    .split(",")
    .map((s) => s.trim())
    .includes(host);
  const addresses = await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => {
      const ip = ipaddr.process(address);
      return !allowed && ip.range() !== "unicast";
    })
  )
    throw new Error(
      "Private webhook hosts must be explicitly listed in ALERT_WEBHOOK_HOSTS.",
    );
  return { url, address: addresses[0] };
}
export async function deliverWebhook(
  url: string,
  secret: string,
  payload: string,
  deliveryId: number,
) {
  const target = await validateWebhook(url);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  await new Promise<void>((resolve, reject) => {
    // Pin the validated DNS result for this connection; never follow redirects.
    const req = (target.url.protocol === "https:" ? https : http).request(
      target.url,
      {
        method: "POST",
        agent: false,
        timeout: 10000,
        lookup: (_hostname, _options, callback) =>
          callback(null, [target.address]),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-crashguard-delivery": String(deliveryId),
          "x-crashguard-timestamp": timestamp,
          "x-crashguard-signature": `sha256=${signature}`,
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
          resolve();
        else reject(new Error(`Webhook returned HTTP ${res.statusCode}`));
        res.destroy();
      },
    );
    req.on("timeout", () => req.destroy(new Error("Webhook timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}
type Job = {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
  created_at: number;
  result: string | null;
};
type NativeResult = {
  status: string;
  request_id?: string;
  message?: string;
  stacktraces?: { is_requesting?: boolean; frames: Frame[] }[];
  modules?: unknown[];
  signal?: number;
  crash_reason?: string;
  os?: unknown;
};
async function processDump(
  job: Job,
  input: { attachment: number; project: number; eventId: string },
) {
  const base = process.env.SYMBOLICATOR_URL;
  if (!base)
    throw new Error("Set SYMBOLICATOR_URL to process native minidumps.");
  const previous = job.result ? (JSON.parse(job.result) as NativeResult) : null;
  let response: Response;
  if (previous?.request_id)
    response = await fetch(
      new URL(
        `/requests/${encodeURIComponent(previous.request_id)}?timeout=5`,
        base,
      ),
      { signal: AbortSignal.timeout(15000) },
    );
  else {
    const attachment = telemetryDb()
      .prepare("SELECT binary FROM telemetry WHERE id=? AND project_id=?")
      .get(input.attachment, input.project) as { binary: Buffer } | undefined;
    if (!attachment) throw new Error("Minidump attachment is missing.");
    const form = new FormData();
    form.set(
      "upload_file_minidump",
      new Blob([new Uint8Array(attachment.binary)]),
      "crash.dmp",
    );
    form.set("platform", JSON.stringify("native"));
    if (process.env.SYMBOLICATOR_SOURCES)
      form.set("sources", process.env.SYMBOLICATOR_SOURCES);
    response = await fetch(
      new URL(`/minidump?timeout=5&scope=crashguard-${input.project}`, base),
      { method: "POST", body: form, signal: AbortSignal.timeout(15000) },
    );
  }
  if (response.status === 404 && previous?.request_id) {
    telemetryDb().prepare("UPDATE jobs SET result=NULL WHERE id=?").run(job.id);
    throw new Error("Symbolicator restarted; resubmitting minidump.");
  }
  if (!response.ok)
    throw new Error(`Symbolicator returned HTTP ${response.status}`);
  const result = (await response.json()) as NativeResult;
  if (result.status === "pending" && result.request_id) {
    if (Date.now() - job.created_at > 3600000)
      throw new Error("Symbolication exceeded one hour.");
    telemetryDb()
      .prepare(
        "UPDATE jobs SET status='pending',available_at=?,result=?,attempts=MAX(0,attempts-1) WHERE id=?",
      )
      .run(Date.now() + 3000, JSON.stringify(result), job.id);
    return false;
  }
  if (!["complete", "completed"].includes(result.status))
    throw new Error(`Symbolication failed: ${result.message || result.status}`);
  const raw = db()
    .prepare("SELECT payload FROM events WHERE project_id=? AND event_id=?")
    .get(input.project, input.eventId) as { payload: string } | undefined;
  const event: SentryEvent = raw
    ? JSON.parse(raw.payload)
    : { event_id: input.eventId, platform: "native", level: "fatal" };
  const stack =
    result.stacktraces?.find((s) => s.is_requesting) || result.stacktraces?.[0];
  const exception = {
    type: result.crash_reason || "NativeCrash",
    value: result.signal ? `Signal ${result.signal}` : "Native process crashed",
    stacktrace: { frames: [...(stack?.frames || [])].reverse() },
    mechanism: { type: "minidump", handled: false },
  };
  event.exception = { values: [exception] };
  event.debug_meta = { images: result.modules || [] };
  event.contexts = { ...event.contexts, os: result.os };
  if (raw)
    db()
      .prepare("UPDATE events SET payload=? WHERE project_id=? AND event_id=?")
      .run(JSON.stringify(event), input.project, input.eventId);
  else
    saveEnvelope(input.project, {}, [
      {
        type: "event",
        headers: { type: "event" },
        payload: Buffer.from(JSON.stringify(event)),
      },
    ]);
  telemetryDb()
    .prepare("UPDATE jobs SET result=? WHERE id=?")
    .run(JSON.stringify(result), job.id);
  return true;
}
export async function runJobs(limit = 10) {
  const sql = telemetryDb();
  for (let n = 0; n < limit; n++) {
    const job = sql
      .prepare(
        `UPDATE jobs SET status='running',attempts=attempts+1,available_at=? WHERE id=(SELECT id FROM jobs WHERE (status='pending' OR status='running') AND available_at<=? ORDER BY id LIMIT 1) RETURNING *`,
      )
      .get(Date.now() + 120000, Date.now()) as Job | undefined;
    if (!job) break;
    try {
      const input = JSON.parse(job.payload);
      if (job.kind === "alert") {
        const rule = sql
          .prepare("SELECT url,secret,enabled,name FROM alert_rules WHERE id=?")
          .get(input.rule) as
          | { url: string; secret: string; enabled: number; name: string }
          | undefined;
        if (rule?.enabled) {
          const origin =
            process.env.APP_URL || "http://localhost:5000";
          await deliverWebhook(
            rule.url,
            rule.secret,
            JSON.stringify({
              action: "event.created",
              rule: rule.name,
              project: input.project,
              issue: input.issue,
              event: input.event,
              url: `${origin}/?issue=${input.issue}&event=${input.event.event_id}`,
            }),
            job.id,
          );
        }
      } else if (job.kind === "minidump") {
        if (!(await processDump(job, input))) continue;
      } else throw new Error("Unknown job type");
      sql
        .prepare("UPDATE jobs SET status='complete',error='' WHERE id=?")
        .run(job.id);
    } catch (error) {
      sql
        .prepare("UPDATE jobs SET status=?,available_at=?,error=? WHERE id=?")
        .run(
          job.attempts >= 8 ? "failed" : "pending",
          Date.now() + Math.min(3600000, 1000 * 2 ** job.attempts),
          error instanceof Error ? error.message.slice(0, 500) : "Job failed",
          job.id,
        );
    }
  }
}
export function startJobs() {
  const global = globalThis as typeof globalThis & {
    crashguardJobs?: ReturnType<typeof setInterval>;
  };
  if (global.crashguardJobs) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runJobs();
    } catch (error) {
      console.error("Background jobs failed", error);
    } finally {
      busy = false;
    }
  };
  global.crashguardJobs = setInterval(() => void tick(), 3000);
  global.crashguardJobs.unref();
  void tick();
}
