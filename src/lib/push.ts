import { ECDH } from "node:crypto";
import webpush from "web-push";
import { z } from "zod";
import { db } from "./db";
import { authOrigin } from "./auth";
import { AccessError, currentAccount } from "./access";

export type NotificationSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
};
type VapidKeys = { public_key: string; private_key: string };
type Device = {
  id: number;
  account_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  expires_at: number | null;
};
type Delivery = {
  id: number;
  subscription_id: number;
  issue_id: number | null;
  kind: "new" | "reopened" | "test";
  attempts: number;
  created_at: number;
};
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
};
export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

function signedIn() {
  const account = currentAccount();
  if (!account) throw new AccessError("Sign in to manage notifications.");
  return account;
}

export function validatePushEndpoint(value: string) {
  const parsed = z.string().max(2048).url().safeParse(value);
  if (!parsed.success) throw new AccessError("Invalid notification endpoint.");
  const url = new URL(parsed.data);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    url.pathname === "/" ||
    !(
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "web.push.apple.com" ||
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.push\.services\.mozilla\.com$/.test(
        url.hostname,
      )
    )
  )
    throw new AccessError(
      "Use a notification subscription from Firefox, Chrome, or Safari.",
    );
  return url.href;
}

function validateSubscription(input: NotificationSubscription) {
  const parsed = z
    .object({
      endpoint: z.string(),
      keys: z.object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      }),
      expirationTime: z.number().finite().positive().nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new AccessError("Invalid notification subscription.");
  const endpoint = validatePushEndpoint(parsed.data.endpoint);
  const key = Buffer.from(parsed.data.keys.p256dh, "base64url");
  try {
    if (key.length !== 65 || key[0] !== 4)
      throw new Error("Invalid public key");
    ECDH.convertKey(key, "prime256v1");
  } catch {
    throw new AccessError("Invalid notification encryption key.");
  }
  if (parsed.data.expirationTime && parsed.data.expirationTime <= Date.now())
    throw new AccessError(
      "This notification subscription has expired. Enable notifications again.",
    );
  return { ...parsed.data, endpoint };
}

function vapidKeys(): VapidKeys {
  return db()
    .transaction(() => {
      const existing = db()
        .prepare("SELECT public_key,private_key FROM push_vapid WHERE id=1")
        .get() as VapidKeys | undefined;
      if (existing) return existing;
      const keys = webpush.generateVAPIDKeys();
      db()
        .prepare("INSERT INTO push_vapid VALUES(1,?,?)")
        .run(keys.publicKey, keys.privateKey);
      return { public_key: keys.publicKey, private_key: keys.privateKey };
    })
    .immediate();
}

export function notificationSettings() {
  const account = signedIn();
  const subscriptions = db()
    .prepare(
      "SELECT id,name,created_at,endpoint FROM push_subscriptions WHERE account_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY id DESC",
    )
    .all(account.account_id, Date.now()) as {
    id: number;
    name: string;
    created_at: number;
    endpoint: string;
  }[];
  return { publicKey: vapidKeys().public_key, subscriptions };
}

export function subscribeDevice(input: NotificationSubscription, name: string) {
  const account = signedIn();
  const subscription = validateSubscription(input);
  const parsedName = z.string().trim().min(1).max(60).safeParse(name);
  if (!parsedName.success)
    throw new AccessError("Enter a device name (1–60 characters).");
  return db()
    .transaction(() => {
      db()
        .prepare(
          "DELETE FROM push_subscriptions WHERE expires_at IS NOT NULL AND expires_at<=?",
        )
        .run(Date.now());
      const existing = db()
        .prepare(
          "SELECT id,account_id FROM push_subscriptions WHERE endpoint=?",
        )
        .get(subscription.endpoint) as
        { id: number; account_id: number } | undefined;
      if (existing && existing.account_id !== account.account_id)
        throw new AccessError(
          "This browser is connected to another account. Disable its notifications before connecting this account.",
        );
      const count = db()
        .prepare(
          "SELECT COUNT(*) AS n FROM push_subscriptions WHERE account_id=?",
        )
        .get(account.account_id) as { n: number };
      if (!existing && count.n >= 20)
        throw new AccessError(
          "Remove a device before adding another (limit 20).",
        );
      vapidKeys();
      const result = db()
        .prepare(
          `INSERT INTO push_subscriptions
      (account_id,endpoint,p256dh,auth,name,created_at,expires_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,name=excluded.name,expires_at=excluded.expires_at RETURNING id`,
        )
        .get(
          account.account_id,
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth,
          parsedName.data,
          Date.now(),
          subscription.expirationTime ?? null,
        ) as { id: number };
      return result;
    })
    .immediate();
}

export function unsubscribeDevice(endpoint: string) {
  db()
    .prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND account_id=?")
    .run(validatePushEndpoint(endpoint), signedIn().account_id);
  return { ok: true as const };
}

export function removeDevice(id: number) {
  const account = signedIn();
  if (!Number.isSafeInteger(id) || id < 1)
    throw new AccessError("Invalid device.");
  db()
    .prepare("DELETE FROM push_subscriptions WHERE id=? AND account_id=?")
    .run(id, account.account_id);
  return { ok: true as const };
}

export function enqueueTestNotification(endpoint: string) {
  const account = signedIn();
  const normalized = validatePushEndpoint(endpoint);
  return db()
    .transaction(() => {
      const now = Date.now();
      const device = db()
        .prepare(
          "SELECT id,last_test_at FROM push_subscriptions WHERE endpoint=? AND account_id=? AND (expires_at IS NULL OR expires_at>?)",
        )
        .get(normalized, account.account_id, now) as
        { id: number; last_test_at: number | null } | undefined;
      if (!device)
        throw new AccessError("Enable notifications on this device first.");
      if (device.last_test_at !== null && now - device.last_test_at < 60000)
        throw new AccessError(
          "Wait a minute before sending another test notification.",
        );
      db()
        .prepare("UPDATE push_subscriptions SET last_test_at=? WHERE id=?")
        .run(now, device.id);
      db()
        .prepare(
          "INSERT INTO push_deliveries(subscription_id,kind,available_at,created_at) VALUES(?,'test',?,?)",
        )
        .run(device.id, now, now);
      return { ok: true as const };
    })
    .immediate();
}

function vapidSubject() {
  const origin = authOrigin();
  const subject =
    process.env.VAPID_SUBJECT ||
    (origin.secure ? origin.origin : "https://localhost");
  const url = new URL(subject);
  if (
    !["https:", "mailto:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("VAPID_SUBJECT must be an HTTPS URL or mailto address.");
  return subject;
}

export async function runPushJobs(
  limit = 10,
  send: PushSender = webpush.sendNotification,
) {
  const sql = db();
  const now = Date.now();
  // Expiring and completed records are not needed indefinitely. A stale alert is
  // less useful than the current dashboard, so stop retrying after one day.
  sql
    .prepare(
      "DELETE FROM push_subscriptions WHERE expires_at IS NOT NULL AND expires_at<=?",
    )
    .run(now);
  sql
    .prepare("DELETE FROM push_deliveries WHERE created_at<?")
    .run(now - 7 * 86400000);
  for (let n = 0; n < limit; n++) {
    const job = sql
      .prepare(
        `UPDATE push_deliveries SET status='running',attempts=attempts+1,available_at=?
      WHERE id=(SELECT id FROM push_deliveries WHERE status IN ('pending','running') AND available_at<=? ORDER BY id LIMIT 1) RETURNING *`,
      )
      .get(Date.now() + 120000, Date.now()) as Delivery | undefined;
    if (!job) break;
    try {
      const device = sql
        .prepare(
          `SELECT s.*,a.role,
        EXISTS (SELECT 1 FROM account_passkeys k WHERE k.account_id=a.id) AS has_passkeys
        FROM push_subscriptions s JOIN accounts a ON a.id=s.account_id WHERE s.id=?`,
        )
        .get(job.subscription_id) as
        (Device & { role: string; has_passkeys: number }) | undefined;
      if (!device) continue;
      if (
        !device.has_passkeys ||
        (device.expires_at !== null && device.expires_at <= Date.now())
      ) {
        sql.prepare("DELETE FROM push_subscriptions WHERE id=?").run(device.id);
        continue;
      }
      let payload: PushPayload = {
        title: "CrashGuard notifications are ready",
        body: "You will receive alerts for new and reopened errors in your projects.",
        url: "/?view=notifications",
        tag: "crashguard-test",
      };
      if (job.kind !== "test") {
        const issue = sql
          .prepare(
            `SELECT p.name FROM issues i JOIN projects p ON p.id=i.project_id WHERE i.id=?
          AND (?='owner' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=i.project_id AND m.account_id=?))`,
          )
          .get(job.issue_id, device.role, device.account_id) as
          { name: string } | undefined;
        if (!issue || Date.now() - job.created_at >= 86400000) {
          sql
            .prepare(
              "UPDATE push_deliveries SET status='complete',error='Expired or no longer accessible' WHERE id=?",
            )
            .run(job.id);
          continue;
        }
        payload = {
          title:
            job.kind === "reopened"
              ? "CrashGuard · Issue reopened"
              : "CrashGuard · New issue",
          body: `An ${job.kind === "reopened" ? "issue has reopened" : "issue needs attention"} in ${issue.name.slice(0, 100)}.`,
          url: `/?view=issues&issue=${job.issue_id}`,
          tag: `crashguard-issue-${job.issue_id}`,
        };
      }
      validatePushEndpoint(device.endpoint);
      const keys = vapidKeys();
      await send(
        {
          endpoint: device.endpoint,
          keys: { p256dh: device.p256dh, auth: device.auth },
        },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: vapidSubject(),
            publicKey: keys.public_key,
            privateKey: keys.private_key,
          },
          TTL: 3600,
          urgency: "normal",
          timeout: 10000,
        },
      );
      sql
        .prepare(
          "UPDATE push_deliveries SET status='complete',error='' WHERE id=?",
        )
        .run(job.id);
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 0;
      if (status === 404 || status === 410) {
        sql
          .prepare("DELETE FROM push_subscriptions WHERE id=?")
          .run(job.subscription_id);
        continue;
      }
      const retry =
        job.attempts < 8 &&
        Date.now() - job.created_at < 86400000 &&
        (!status || status === 408 || status === 429 || status >= 500);
      sql
        .prepare(
          "UPDATE push_deliveries SET status=?,available_at=?,error=? WHERE id=?",
        )
        .run(
          retry ? "pending" : "failed",
          Date.now() + Math.min(3600000, 1000 * 2 ** job.attempts),
          status
            ? `Push service returned HTTP ${status}`
            : "Push delivery failed",
          job.id,
        );
    }
  }
}
