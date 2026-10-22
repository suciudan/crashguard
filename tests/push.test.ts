import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import webpush from "web-push";
import { db, createProject, saveEvents, setStatus } from "../src/lib/db";
import { withAccount, type Account } from "../src/lib/access";
import {
  notificationSettings,
  subscribeDevice,
  unsubscribeDevice,
  removeDevice,
  enqueueTestNotification,
  validatePushEndpoint,
  runPushJobs,
  type NotificationSubscription,
  type PushPayload,
  type PushSender,
} from "../src/lib/push";

const temp = mkdtempSync(join(tmpdir(), "crashguard-push-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
process.env.AUTH_ORIGIN = "https://crashguard.example";
const owner: Account = {
  account_id: 1,
  account_name: "Owner",
  role: "owner",
  user_handle: "owner",
};
const member: Account = {
  account_id: 2,
  account_name: "Member",
  role: "member",
  user_handle: "member",
};
const key = createECDH("prime256v1");
key.generateKeys();
let serial = 0;
const subscription = (
  endpoint = `https://updates.push.services.mozilla.com/wpush/v2/test-${++serial}`,
): NotificationSubscription => ({
  endpoint,
  keys: {
    p256dh: key.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  },
});
db().exec(`INSERT INTO accounts VALUES(2,'Member','member','member',0);
  INSERT INTO passkeys VALUES('owner-key',X'01',0,'[]','Owner',0),('member-key',X'01',0,'[]','Member',0);
  INSERT INTO account_passkeys VALUES('owner-key',1),('member-key',2);`);
const visible = createProject("Storefront", "javascript");
const hidden = createProject("Private app", "node");
const enroll = (account = owner, input = subscription()) =>
  withAccount(account, () => ({ ...subscribeDevice(input, "Firefox"), input }));
const deliveries = () =>
  db().prepare("SELECT * FROM push_deliveries ORDER BY id").all() as {
    id: number;
    subscription_id: number;
    issue_id: number;
    kind: string;
    status: string;
    attempts: number;
    available_at: number;
    error: string;
  }[];
const record =
  (messages: { endpoint: string; payload: PushPayload }[]): PushSender =>
  async (device, payload, options) => {
    const request = webpush.generateRequestDetails(device, payload, options);
    assert.equal(request.headers["Content-Encoding"], "aes128gcm");
    assert.ok(request.headers.Authorization);
    assert.ok(Buffer.isBuffer(request.body));
    messages.push({ endpoint: device.endpoint, payload: JSON.parse(payload) });
  };
beforeEach(() => {
  db().exec(
    "DELETE FROM push_subscriptions; DELETE FROM events; DELETE FROM issues;",
  );
  db()
    .prepare("INSERT OR IGNORE INTO project_members VALUES(?,?,0)")
    .run(visible.id, member.account_id);
});
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
});

test("subscriptions and stable VAPID public key are account-scoped, private keys are never returned", () => {
  assert.throws(notificationSettings);
  assert.throws(() =>
    withAccount(null, () => subscribeDevice(subscription(), "Anonymous")),
  );
  const own = enroll();
  const other = enroll(member);
  const settings = withAccount(owner, notificationSettings);
  assert.deepEqual(
    settings.subscriptions.map((item) => item.id),
    [own.id],
  );
  assert.equal(
    settings.publicKey,
    withAccount(member, notificationSettings).publicKey,
  );
  assert.equal(Buffer.from(settings.publicKey, "base64url").length, 65);
  assert.ok(!JSON.stringify(settings).includes(own.input.keys.auth));
  assert.ok(!JSON.stringify(settings).includes(own.input.keys.p256dh));
  assert.ok(!JSON.stringify(settings).includes("private_key"));
  assert.throws(
    () => withAccount(member, () => subscribeDevice(own.input, "Hijacked")),
    /another account/,
  );
  withAccount(member, () => removeDevice(own.id));
  withAccount(member, () => unsubscribeDevice(own.input.endpoint));
  assert.equal(
    withAccount(owner, notificationSettings).subscriptions.length,
    1,
  );
  assert.equal(
    withAccount(owner, () => subscribeDevice(own.input, "Renamed")).id,
    own.id,
  );
  withAccount(owner, () => removeDevice(own.id));
  assert.equal(
    withAccount(owner, notificationSettings).subscriptions.length,
    0,
  );
  assert.equal(
    withAccount(member, notificationSettings).subscriptions[0].id,
    other.id,
  );
});

test("only real HTTPS push provider endpoints and valid encryption keys are accepted", () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/send/1",
    "https://127.0.0.1/push",
    "https://example.com/push",
    "https://fcm.googleapis.com.attacker.test/push",
    "https://fcm.googleapis.com@attacker.test/push",
    "https://fcm.googleapis.com:8443/push",
    "https://fcm.googleapis.com/push#fragment",
    "https://fcm.googleapis.com/",
    "https://notpush.services.mozilla.com/push",
  ])
    assert.throws(() =>
      withAccount(owner, () =>
        subscribeDevice(subscription(endpoint), "Browser"),
      ),
    );
  for (const endpoint of [
    "https://updates.push.services.mozilla.com/wpush/v2/1",
    "https://updates-autopush.stage.mozaws.net/wpush/v2/1", // non-production provider is intentionally unsupported
  ]) {
    if (endpoint.includes("mozaws"))
      assert.throws(() => validatePushEndpoint(endpoint));
    else assert.equal(validatePushEndpoint(endpoint), endpoint);
  }
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/1",
    "https://web.push.apple.com/Q/1",
  ])
    assert.equal(validatePushEndpoint(endpoint), endpoint);
  const invalid = subscription();
  invalid.keys.p256dh = Buffer.alloc(65, 4).toString("base64url");
  assert.throws(
    () => withAccount(owner, () => subscribeDevice(invalid, "Browser")),
    /encryption key/,
  );
  assert.throws(
    () =>
      withAccount(owner, () =>
        subscribeDevice({ ...subscription(), expirationTime: 1 }, "Browser"),
      ),
    /expired/,
  );
  assert.throws(() =>
    withAccount(owner, () => subscribeDevice(subscription(), " ")),
  );
});

test("device caps, test rate limits, test ownership, and removal of queued work are enforced", async () => {
  const own = enroll();
  const other = enroll(member);
  for (let n = 1; n < 20; n++) enroll();
  assert.throws(() => enroll(), /limit 20/);
  assert.throws(
    () =>
      withAccount(member, () => enqueueTestNotification(own.input.endpoint)),
    /Enable notifications/,
  );
  withAccount(owner, () => enqueueTestNotification(own.input.endpoint));
  assert.throws(
    () => withAccount(owner, () => enqueueTestNotification(own.input.endpoint)),
    /Wait a minute/,
  );
  const messages: { endpoint: string; payload: PushPayload }[] = [];
  await runPushJobs(10, record(messages));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].endpoint, own.input.endpoint);
  assert.match(messages[0].payload.title, /ready/);
  withAccount(member, () => enqueueTestNotification(other.input.endpoint));
  withAccount(member, () => removeDevice(other.id));
  assert.equal(
    deliveries().some((item) => item.subscription_id === other.id),
    false,
  );
});

test("new/reopened errors enqueue atomically for accessible devices; repeats, retries and low severity do not", async () => {
  const own = enroll();
  const other = enroll(member);
  const event = {
    event_id: "a".repeat(32),
    fingerprint: ["checkout"],
    message: "Sensitive diagnostic payload",
  };
  saveEvents(visible.id, [
    event,
    event,
    { ...event, event_id: "b".repeat(32) },
  ]);
  assert.equal(deliveries().length, 2);
  assert.ok(deliveries().every((job) => job.kind === "new"));
  const issueId = deliveries()[0].issue_id;
  setStatus(issueId, "resolved");
  saveEvents(visible.id, [event]); // SDK retry cannot reopen or alert.
  assert.equal(deliveries().length, 2);
  saveEvents(visible.id, [
    { ...event, event_id: "c".repeat(32), level: "fatal" },
  ]);
  assert.equal(deliveries().length, 4);
  assert.ok(
    deliveries()
      .slice(2)
      .every((job) => job.kind === "reopened"),
  );
  saveEvents(visible.id, [{ message: "Warning", level: "warning" }]);
  setStatus(issueId, "ignored");
  saveEvents(visible.id, [{ ...event, event_id: "d".repeat(32) }]);
  assert.equal(deliveries().length, 4);
  saveEvents(hidden.id, [{ ...event, event_id: "a".repeat(32) }]);
  assert.equal(deliveries().length, 5); // Same SDK id in another project is independent.
  const messages: { endpoint: string; payload: PushPayload }[] = [];
  await runPushJobs(10, record(messages));
  assert.equal(
    messages.filter((item) => item.endpoint === own.input.endpoint).length,
    3,
  );
  assert.equal(
    messages.filter((item) => item.endpoint === other.input.endpoint).length,
    2,
  );
  assert.ok(
    messages.every((item) => !JSON.stringify(item).includes(event.message)),
  );
  assert.ok(
    messages.every((item) =>
      /^\/\?view=issues&issue=\d+$/.test(item.payload.url),
    ),
  );
  assert.ok(deliveries().every((job) => job.status === "complete"));
  // Rolling back ingestion also rolls back its delivery fan-out.
  assert.throws(() =>
    db().transaction(() => {
      saveEvents(visible.id, [{ message: "Rolled back" }]);
      throw new Error("abort");
    })(),
  );
  assert.equal(deliveries().length, 5);
});

test("delivery rechecks project membership and passkeys, and recovers leased jobs after restart", async () => {
  enroll();
  const other = enroll(member);
  saveEvents(visible.id, [{ message: "Needs attention" }]);
  db()
    .prepare("DELETE FROM project_members WHERE account_id=?")
    .run(member.account_id);
  db()
    .prepare("UPDATE push_deliveries SET status='running',available_at=0")
    .run();
  const messages: { endpoint: string; payload: PushPayload }[] = [];
  await runPushJobs(10, record(messages));
  assert.equal(messages.length, 1);
  assert.ok(messages.every((item) => item.endpoint !== other.input.endpoint));
  db()
    .prepare("INSERT INTO project_members VALUES(?,?,0)")
    .run(visible.id, member.account_id);
  saveEvents(visible.id, [{ message: "Another new issue" }]);
  db().prepare("DELETE FROM account_passkeys WHERE account_id=2").run();
  try {
    await runPushJobs(10, record(messages));
    assert.equal(messages.length, 2);
    assert.equal(
      withAccount(member, notificationSettings).subscriptions.length,
      0,
    );
  } finally {
    db().prepare("INSERT INTO account_passkeys VALUES('member-key',2)").run();
  }
});

test("retryable failures back off, permanent failures stop, and expired subscriptions are removed", async () => {
  const own = enroll();
  withAccount(owner, () => enqueueTestNotification(own.input.endpoint));
  const error =
    (statusCode: number): PushSender =>
    async () => {
      throw {
        statusCode,
        body: "private provider response",
        endpoint: own.input.endpoint,
      };
    };
  await runPushJobs(1, error(503));
  assert.equal(deliveries()[0].status, "pending");
  assert.equal(deliveries()[0].attempts, 1);
  assert.ok(deliveries()[0].available_at > Date.now());
  assert.equal(deliveries()[0].error, "Push service returned HTTP 503");
  db().prepare("UPDATE push_deliveries SET attempts=7,available_at=0").run();
  await runPushJobs(1, error(429));
  assert.equal(deliveries()[0].status, "failed");
  db()
    .prepare(
      "UPDATE push_deliveries SET status='pending',attempts=0,available_at=0",
    )
    .run();
  await runPushJobs(1, error(403));
  assert.equal(deliveries()[0].status, "failed");
  db()
    .prepare("UPDATE push_deliveries SET status='pending',available_at=0")
    .run();
  await runPushJobs(1, error(410));
  assert.equal(deliveries().length, 0);
  assert.equal(
    withAccount(owner, notificationSettings).subscriptions.length,
    0,
  );
});

test("passkey recovery permanently removes device subscriptions and queued notifications", async () => {
  const own = enroll();
  withAccount(owner, () => enqueueTestNotification(own.input.endpoint));
  const recoveryPath = join(temp, "recovery.sqlite");
  await db().backup(recoveryPath);
  execFileSync(process.execPath, ["scripts/reset-passkeys.mjs", "--confirm"], {
    env: { ...process.env, DATABASE_PATH: recoveryPath },
    stdio: "pipe",
  });
  const recovered = new Database(recoveryPath);
  assert.equal(
    (
      recovered
        .prepare("SELECT COUNT(*) AS n FROM push_subscriptions")
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      recovered.prepare("SELECT COUNT(*) AS n FROM push_deliveries").get() as {
        n: number;
      }
    ).n,
    0,
  );
  recovered.close();
});

test("removing and reenrolling a device while delivery is in flight cannot affect its replacement", async () => {
  for (const outcome of ["success", "gone"]) {
    const original = enroll();
    withAccount(owner, () => enqueueTestNotification(original.input.endpoint));
    const originalJob = deliveries()[0].id;
    let finish!: () => void;
    const inFlight = runPushJobs(
      1,
      () =>
        new Promise<void>((resolve, reject) => {
          finish = () =>
            outcome === "gone" ? reject({ statusCode: 410 }) : resolve();
        }),
    );
    assert.ok(finish);
    withAccount(owner, () => removeDevice(original.id));
    const replacement = enroll(owner, original.input);
    withAccount(owner, () =>
      enqueueTestNotification(replacement.input.endpoint),
    );
    assert.notEqual(replacement.id, original.id);
    assert.notEqual(deliveries()[0].id, originalJob);
    finish();
    await inFlight;
    assert.deepEqual(
      withAccount(owner, notificationSettings).subscriptions.map(
        (item) => item.id,
      ),
      [replacement.id],
    );
    assert.equal(deliveries()[0].status, "pending");
    assert.equal(deliveries()[0].attempts, 0);
    const messages: { endpoint: string; payload: PushPayload }[] = [];
    await runPushJobs(1, record(messages));
    assert.equal(messages.length, 1);
    withAccount(owner, () => removeDevice(replacement.id));
  }
});

test("concurrent workers claim each delivery once and an expired browser subscription is cleaned up", async () => {
  const own = enroll();
  withAccount(owner, () => enqueueTestNotification(own.input.endpoint));
  let sent = 0;
  const sender: PushSender = async () => {
    sent++;
    await new Promise((resolve) => setImmediate(resolve));
  };
  await Promise.all([runPushJobs(1, sender), runPushJobs(1, sender)]);
  assert.equal(sent, 1);
  assert.equal(deliveries()[0].status, "complete");
  db()
    .prepare("UPDATE push_subscriptions SET expires_at=1 WHERE id=?")
    .run(own.id);
  await runPushJobs(10, sender);
  assert.equal(sent, 1);
  assert.equal(deliveries().length, 0);
  assert.equal(
    withAccount(owner, notificationSettings).subscriptions.length,
    0,
  );
});
