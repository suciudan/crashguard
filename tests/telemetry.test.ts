import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";
import http from "node:http";
import { createProject, db, dashboard } from "../src/lib/db";
import {
  saveEnvelope,
  telemetryDb,
  listTelemetry,
  telemetryDetail,
  decodeRecording,
  playbackEvents,
} from "../src/lib/telemetry";
import { uploadSourceMap, symbolicateEvent } from "../src/lib/sourcemaps";
import { runJobs, validateWebhook } from "../src/lib/jobs";
const temp = mkdtempSync(join(tmpdir(), "crashguard-telemetry-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
});
const project = createProject("Telemetry", "node");
const eventId = "a".repeat(32),
  traceId = "b".repeat(32);
const item = (
  type: string,
  payload: unknown,
  headers: Record<string, unknown> = {},
) => ({
  type,
  headers: { type, ...headers },
  payload: Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload)),
});
test("transactions, batched logs and binary attachments persist atomically without creating issues", () => {
  const result = saveEnvelope(project.id, { event_id: eventId }, [
    item("transaction", {
      event_id: eventId,
      transaction: "GET /checkout",
      start_timestamp: 100,
      timestamp: 101,
      contexts: { trace: { trace_id: traceId } },
      spans: [
        {
          span_id: "c".repeat(16),
          start_timestamp: 100.1,
          timestamp: 100.2,
          op: "db",
        },
      ],
    }),
    item("log", {
      version: 2,
      items: [
        {
          timestamp: 100,
          level: "info",
          body: "Checkout started",
          trace_id: traceId,
          attributes: { password: { value: "secret", type: "string" } },
        },
        { timestamp: 101, level: "error", body: "Payment failed" },
      ],
    }),
    item("attachment", Buffer.from([0, 10, 255, 42]), {
      filename: "data.bin",
      content_type: "application/octet-stream",
    }),
  ]);
  assert.equal(result.accepted, 4);
  assert.equal(dashboard(new URLSearchParams()).stats.events, 0);
  const rows = listTelemetry({
    project: project.id,
    kind: "transaction",
    trace: traceId,
  }).rows;
  assert.equal(rows[0].duration, 1000);
  assert.equal(
    telemetryDetail(rows[0].id)?.payload.transaction,
    "GET /checkout",
  );
  assert.equal(listTelemetry({ project: project.id, kind: "log" }).total, 2);
  const log = listTelemetry({ kind: "log", trace: traceId }).rows[0];
  assert.equal(
    (telemetryDetail(log.id)?.payload.attributes as Record<string, unknown>)
      .password,
    "[Filtered]",
  );
  const file = telemetryDb()
    .prepare("SELECT binary FROM telemetry WHERE kind='attachment'")
    .get() as { binary: Buffer };
  assert.deepEqual(file.binary, Buffer.from([0, 10, 255, 42]));
  assert.throws(() =>
    saveEnvelope(project.id, {}, [
      item("event", { message: "do not persist" }),
      item("transaction", { timestamp: 0 }),
    ]),
  );
  assert.equal(dashboard(new URLSearchParams()).stats.events, 0);
});
test("retries deduplicate transactions, log batches, attachments and replay segments per project", () => {
  const payload = item("log", {
    items: [{ timestamp: 42, level: "info", body: "retry" }],
  });
  saveEnvelope(project.id, {}, [payload]);
  saveEnvelope(project.id, {}, [payload]);
  const other = createProject("Other", "node");
  saveEnvelope(other.id, {}, [payload]);
  assert.equal(
    listTelemetry({ project: project.id, kind: "log", q: "retry" }).total,
    1,
  );
  assert.equal(
    listTelemetry({ project: other.id, kind: "log", q: "retry" }).total,
    1,
  );
});
test("compressed replay records preserve segments and reject invalid compression", () => {
  const events = [
    {
      type: 4,
      timestamp: 1000,
      data: { href: "https://example.com", width: 800, height: 600 },
    },
    {
      type: 2,
      timestamp: 1001,
      data: { node: { type: 0, id: 1, childNodes: [] } },
    },
  ];
  const recording = Buffer.concat([
    Buffer.from('{"segment_id":0}\n'),
    deflateSync(Buffer.from(JSON.stringify(events))),
  ]);
  const batch = [
    item("replay_event", {
      replay_id: eventId,
      segment_id: 0,
      timestamp: 1,
      urls: ["https://example.com"],
    }),
    item("replay_recording", recording),
  ];
  saveEnvelope(project.id, { event_id: eventId }, batch);
  saveEnvelope(project.id, { event_id: eventId }, batch);
  assert.equal(listTelemetry({ kind: "replay_recording" }).total, 1);
  assert.deepEqual(decodeRecording(recording).events, events);
  assert.throws(() =>
    decodeRecording(Buffer.from('{"segment_id":0}\ninvalid')),
  );
  assert.throws(() =>
    saveEnvelope(project.id, { event_id: eventId }, [
      batch[0],
      item("replay_recording", Buffer.from('{"segment_id":2}\n[]')),
    ]),
  );
});
test("profile references are validated and both sampled formats are stored", () => {
  const profile = {
    samples: [{ stack_id: 0, thread_id: "1", timestamp: 100 }],
    frames: [{ function: "checkout" }],
    stacks: [[0]],
  };
  saveEnvelope(project.id, {}, [
    item("profile", { event_id: eventId, profile }),
    item("profile_chunk", { chunk_id: eventId, profiler_id: traceId, profile }),
  ]);
  assert.equal(listTelemetry({ kind: "profile" }).total, 1);
  assert.equal(listTelemetry({ kind: "profile_chunk" }).total, 1);
  assert.throws(() =>
    saveEnvelope(project.id, {}, [
      item("profile_chunk", {
        chunk_id: traceId,
        profile: { ...profile, stacks: [[999]] },
      }),
    ]),
  );
});
test("Sentry custom replay events are converted to the rrweb millisecond timebase", () => {
  const events = [
    { type: 4, timestamp: 1790000000000, data: {} },
    { type: 5, timestamp: 1790000001, data: {} },
  ];
  const replay = playbackEvents(events);
  assert.equal(replay[1].timestamp - replay[0].timestamp, 1000);
  assert.equal(events[1].timestamp, 1790000001);
});
test("source maps resolve debug IDs, preserve original frames and stay project scoped", () => {
  const debug = "12345678-1234-1234-1234-123456789abc";
  uploadSourceMap(
    project.id,
    "v1",
    "https://example.com/app.js",
    debug,
    JSON.stringify({
      version: 3,
      sources: ["checkout.ts"],
      sourcesContent: ["throw new Error('Payment failed');"],
      names: ["checkout"],
      mappings: "AAAAA",
    }),
  );
  const input = {
    event_id: eventId,
    debug_meta: {
      images: [{ code_file: "https://example.com/app.js", debug_id: debug }],
    },
    exception: {
      values: [
        {
          stacktrace: {
            frames: [
              {
                abs_path: "https://example.com/app.js",
                lineno: 1,
                colno: 1,
                function: "x",
              },
            ],
          },
        },
      ],
    },
  };
  const result = symbolicateEvent(project.id, input);
  assert.equal(
    result.exception?.values?.[0].stacktrace?.frames?.[0].filename,
    "checkout.ts",
  );
  assert.equal(
    result.exception?.values?.[0].stacktrace?.frames?.[0].function,
    "checkout",
  );
  assert.equal(input.exception.values[0].stacktrace.frames[0].function, "x");
  assert.equal(
    symbolicateEvent(999, input).exception?.values?.[0].stacktrace?.frames?.[0]
      .function,
    "x",
  );
});
test("durable alerts sign deliveries, deduplicate retries, and reject private hosts by default", async () => {
  await assert.rejects(
    () => validateWebhook("http://127.0.0.1:1234/hook"),
    /Private webhook/,
  );
  await assert.rejects(() => validateWebhook("file:///etc/passwd"), /HTTP/);
  process.env.ALERT_WEBHOOK_HOSTS = "127.0.0.1";
  let count = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      assert.equal(
        req.headers["x-crashguard-signature"],
        `sha256=${createHmac("sha256", "test-secret").update(`${req.headers["x-crashguard-timestamp"]}.${body}`).digest("hex")}`,
      );
      assert.equal(JSON.parse(body).event.message, "Alert test");
      count++;
      res.writeHead(count === 1 ? 503 : 200);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    telemetryDb()
      .prepare(
        "INSERT INTO alert_rules(project_id,name,url,secret) VALUES(?,?,?,?)",
      )
      .run(
        project.id,
        "Errors",
        `http://127.0.0.1:${port}/hook`,
        "test-secret",
      );
    const envelope = [
      item("event", {
        event_id: eventId,
        message: "Alert test",
        release: "v2",
      }),
    ];
    saveEnvelope(project.id, {}, envelope);
    saveEnvelope(project.id, {}, envelope);
    await runJobs();
    let job = telemetryDb()
      .prepare("SELECT * FROM jobs WHERE kind='alert'")
      .get() as { status: string; attempts: number };
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 1);
    telemetryDb()
      .prepare("UPDATE jobs SET available_at=0 WHERE kind='alert'")
      .run();
    await runJobs();
    job = telemetryDb()
      .prepare("SELECT * FROM jobs WHERE kind='alert'")
      .get() as typeof job;
    assert.equal(job.status, "complete");
    assert.equal(count, 2);
    assert.ok(
      telemetryDb().prepare("SELECT 1 FROM releases WHERE version='v2'").get(),
    );
  } finally {
    server.close();
    delete process.env.ALERT_WEBHOOK_HOSTS;
  }
});
