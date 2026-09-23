import assert from "node:assert/strict";
import * as Sentry from "@sentry/node";
import { createProject, dashboard, issueDetail } from "./test-data";
async function main() {
  const base = process.env.TEST_BASE_URL || "http://localhost:5000";
  const p = createProject(`SDK smoke ${Date.now()}`, "node");
  Sentry.init({
    dsn: `${base.replace("://", `://${p.public_key}@`)}/${p.id}`,
    environment: "sdk-test",
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  Sentry.setUser({ id: "sdk-test-user" });
  Sentry.setTag("integration", "real-node-sdk");
  Sentry.addBreadcrumb({
    category: "test",
    message: "About to capture exception",
  });
  const id = Sentry.captureException(new Error("Real Node SDK smoke test"));
  const messageId = Sentry.captureMessage("Real Node SDK message", "info");
  assert.ok(await Sentry.flush(10000));
  await Sentry.close();
  const data = dashboard(
    new URLSearchParams({
      project: String(p.id),
      environment: "sdk-test",
      status: "all",
    }),
  );
  assert.equal(data.stats.events, 2);
  assert.equal(data.stats.users, 1);
  const events = data.issues.flatMap((issue) => issueDetail(issue.id)!.events);
  const error = events.find((e) => e.event_id === id);
  assert.ok(error);
  assert.ok(error.payload.exception?.values?.[0].stacktrace?.frames?.length);
  assert.ok(events.some((e) => e.event_id === messageId));
  console.log(
    "PASS: real @sentry/node exception + message, stack frames, user, tags, breadcrumbs persisted",
    { project: p.id, events: data.stats.events },
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
