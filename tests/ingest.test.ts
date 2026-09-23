import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { parseEnvelope, ingest, MAX_BYTES } from "../src/lib/ingest";
import {
  createProject,
  dashboard,
  db,
  issueDetail,
  saveEvents,
  setStatus,
} from "../src/lib/db";
import { normalizeEvent, scrub } from "../src/lib/events";
const temp = mkdtempSync(join(tmpdir(), "crashguard-test-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
});
const eventId = () => randomUUID().replaceAll("-", "");
const project = createProject("Test frontend", "javascript");
function request(
  body: Buffer | string,
  query = `?sentry_key=${project.public_key}`,
  headers = {},
) {
  return new Request(`http://localhost/api/${project.id}/envelope/${query}`, {
    method: "POST",
    body: new Uint8Array(Buffer.from(body)),
    headers,
  });
}
function envelope(event: unknown, header: object = {}) {
  return `${JSON.stringify(header)}\n{"type":"event"}\n${JSON.stringify(event)}\n`;
}
test("byte lengths preserve Unicode and preserve binary attachments with newlines", () => {
  const payload = Buffer.from(JSON.stringify({ message: "Crășh 🛡️" }));
  const body = Buffer.concat([
    Buffer.from(`{}\n{"type":"attachment","length":4}\n`),
    Buffer.from([0, 10, 255, 42]),
    Buffer.from(`\n{"type":"event","length":${payload.length}}\n`),
    payload,
  ]);
  const result = parseEnvelope(body);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].payload.toString(), payload.toString());
});
test("malformed envelopes reject invalid lengths, JSON and delimiters", () => {
  for (const body of [
    "",
    "[]",
    '{}\n{"type":"event","length":-1}\nx',
    '{}\n{"type":"event","length":500}\n{}',
    '{}\n{"type":"event","length":2}\n{}bad',
    '{}\n{"length":2}\n{}',
  ])
    assert.throws(() => parseEnvelope(Buffer.from(body)));
  assert.equal(parseEnvelope(Buffer.from("{}\n")).items.length, 0);
});
test("gzip, deflate and brotli ingestion preserve payload and authenticate", async () => {
  for (const [encoding, compress] of [
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const) {
    const id = eventId();
    const res = await ingest(
      request(
        compress(
          Buffer.from(
            envelope({ event_id: id, message: `compressed ${encoding}` }),
          ),
        ),
        undefined,
        { "Content-Encoding": encoding },
      ),
      String(project.id),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, id);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  }
});
test("supports header and envelope DSN authentication; rejects conflicts and unknown projects", async () => {
  const valid = await ingest(
    request(envelope({ message: "header" }), "", {
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${project.public_key}`,
    }),
    String(project.id),
  );
  assert.equal(valid.status, 200);
  const dsn = `http://${project.public_key}@localhost/${project.id}`;
  assert.equal(
    (
      await ingest(
        request(envelope({ message: "dsn" }, { dsn }), ""),
        String(project.id),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await ingest(
        request(envelope({ message: "wrong" }, { dsn }), "?sentry_key=wrong"),
        String(project.id),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await ingest(
        request(envelope({ message: "wrong" }, { dsn: `${dsn}9` }), ""),
        String(project.id),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await ingest(
        request(envelope({ message: "none" }), ""),
        String(project.id),
      )
    ).status,
    401,
  );
  assert.equal((await ingest(request("{}"), "999999")).status, 404);
});
test("unsupported envelope items are discarded", async () => {
  const ignored = await ingest(
    request('{}\n{"type":"session"}\n{}\n{"type":"unknown_future_item"}\n{}\n'),
    String(project.id),
  );
  assert.deepEqual((await ignored.json()).discarded, [
    "session",
    "unknown_future_item",
  ]);
});
test("invalid events reject the entire envelope without partial writes", async () => {
  const before = dashboard(new URLSearchParams()).stats.events;
  const bad =
    envelope({ message: "must roll back" }) +
    '{"type":"event"}\n{"exception":{"values":"invalid"}}\n';
  const res = await ingest(request(bad), String(project.id));
  assert.equal(res.status, 400);
  assert.equal(dashboard(new URLSearchParams()).stats.events, before);
});
test("rejects oversized compressed and uncompressed bodies", async () => {
  const body = Buffer.alloc(MAX_BYTES + 1, 65);
  assert.equal((await ingest(request(body), String(project.id))).status, 413);
  assert.equal(
    (
      await ingest(
        request(gzipSync(body), undefined, { "content-encoding": "gzip" }),
        String(project.id),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await ingest(
        request("bad gzip", undefined, { "content-encoding": "gzip" }),
        String(project.id),
      )
    ).status,
    400,
  );
});
test("deduplication, project isolation, user counts and issue regression", () => {
  const p = createProject("Grouping", "node");
  const other = createProject("Isolated", "node");
  const event = {
    event_id: eventId(),
    message: "stable error",
    user: { id: "customer-1" },
    environment: "staging",
  };
  saveEvents(p.id, [event, event]);
  saveEvents(other.id, [event]);
  let data = dashboard(new URLSearchParams({ project: String(p.id) }));
  assert.equal(data.stats.events, 1);
  assert.equal(data.issues.length, 1);
  const issue = data.issues[0];
  setStatus(issue.id, "resolved");
  saveEvents(p.id, [event]);
  assert.equal(issueDetail(issue.id)?.issue.status, "resolved");
  saveEvents(p.id, [{ ...event, event_id: eventId() }]);
  assert.equal(issueDetail(issue.id)?.issue.status, "unresolved");
  setStatus(issue.id, "ignored");
  saveEvents(p.id, [{ ...event, event_id: eventId() }]);
  assert.equal(issueDetail(issue.id)?.issue.status, "ignored");
  data = dashboard(
    new URLSearchParams({
      project: String(p.id),
      environment: "staging",
      q: "stable",
    }),
  );
  assert.equal(data.stats.events, 3);
  assert.equal(data.stats.users, 1);
  assert.equal(
    dashboard(
      new URLSearchParams({ project: String(p.id), environment: "production" }),
    ).stats.events,
    0,
  );
});
test("linked occurrences remain accessible beyond 50 events and stay scoped to their issue", () => {
  const p = createProject("Persistent links", "node");
  const ids = Array.from({ length: 55 }, eventId);
  saveEvents(
    p.id,
    ids.map((id) => ({ event_id: id, message: "Linked error" })),
  );
  const issue = dashboard(
    new URLSearchParams({ project: String(p.id), status: "all" }),
  ).issues[0];
  assert.equal(issueDetail(issue.id)?.events.length, 50);
  assert.ok(
    !issueDetail(issue.id)?.events.some((event) => event.event_id === ids[0]),
  );
  const linked = issueDetail(issue.id, ids[0])!;
  assert.equal(linked.events.length, 51);
  assert.equal(linked.events.at(-1)?.event_id, ids[0]);
  assert.equal(issueDetail(issue.id, ids[54])?.events.length, 50);
  const other = createProject("Other project", "node");
  saveEvents(other.id, [{ event_id: ids[0], message: "Other error" }]);
  const otherIssue = dashboard(
    new URLSearchParams({ project: String(other.id) }),
  ).issues[0];
  assert.equal(issueDetail(otherIssue.id, ids[54])?.events.length, 1);
  assert.equal(
    issueDetail(otherIssue.id, ids[0])?.events[0].payload.message,
    "Other error",
  );
});
test("grouping honors custom fingerprints and ignores changing exception values for stable frames", () => {
  const a = {
    exception: {
      values: [
        {
          type: "Error",
          value: "user 1",
          stacktrace: {
            frames: [{ filename: "app.js", function: "load", lineno: 3 }],
          },
        },
      ],
    },
  };
  const b = structuredClone(a);
  b.exception.values[0].value = "user 2";
  b.exception.values[0].stacktrace.frames[0].lineno = 5;
  assert.equal(normalizeEvent(a).fingerprint, normalizeEvent(b).fingerprint);
  assert.notEqual(
    normalizeEvent({ ...a, fingerprint: ["a"] }).fingerprint,
    normalizeEvent({ ...a, fingerprint: ["b"] }).fingerprint,
  );
});
test("scrubs common secrets from nested objects, headers and URLs", () => {
  const clean = scrub({
    password: "secret",
    request: {
      headers: [
        ["Authorization", "Bearer secret"],
        ["Accept", "json"],
      ],
      url: "https://u:p@example.com/?token=secret&keep=ok",
    },
  }) as { password: string; request: { headers: string[][]; url: string } };
  assert.equal(clean.password, "[Filtered]");
  assert.equal(clean.request.headers[0][1], "[Filtered]");
  assert.equal(clean.request.headers[1][1], "json");
  assert.ok(!clean.request.url.includes("secret"));
  assert.ok(clean.request.url.includes("keep=ok"));
});
test("per-project rate limit returns SDK backoff headers", async () => {
  const p = createProject("Rate limit", "node");
  process.env.INGEST_RATE_LIMIT = "1";
  const send = () =>
    ingest(
      request(envelope({ message: "rate" }), `?sentry_key=${p.public_key}`),
      String(p.id),
    );
  assert.equal((await send()).status, 200);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.ok(limited.headers.get("x-sentry-rate-limits"));
  delete process.env.INGEST_RATE_LIMIT;
});
