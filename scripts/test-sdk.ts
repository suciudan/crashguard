import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import * as Sentry from "@sentry/node";
import { createProject, dashboard, issueDetail, db } from "./test-data";
const runExample = promisify(execFile);
async function main() {
  const base = process.env.TEST_BASE_URL || "http://localhost:5000";
  const p = createProject(`SDK smoke ${Date.now()}`, "node");
  const dsn = `${base.replace("://", `://${p.public_key}@`)}/${p.id}`;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  Sentry.init({
    dsn,
    environment: "sdk-test",
    release: "sdk-smoke@1.0.0",
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  try {
    Sentry.setUser({ id: "sdk-test-user" });
    Sentry.setTag("integration", "real-node-sdk");
    Sentry.addBreadcrumb({
      category: "test",
      message: "About to capture exception",
    });
    const id = Sentry.captureException(new Error("Real Node SDK smoke test"));
    const messageId = Sentry.captureMessage("Real Node SDK message", "info");
    assert.ok(
      await Sentry.flush(10000),
      "SDK delivery must finish successfully",
    );
    const data = dashboard(
      new URLSearchParams({
        project: String(p.id),
        environment: "sdk-test",
        status: "all",
      }),
    );
    assert.equal(data.stats.events, 2);
    assert.equal(data.stats.users, 1);
    assert.equal(data.stats.issues, 2);
    const events = data.issues.flatMap(
      (issue) => issueDetail(issue.id)!.events,
    );
    const error = events.find((e) => e.event_id === id);
    assert.ok(
      error,
      "Captured exception must be persisted with its SDK event ID",
    );
    assert.equal(error.payload.exception?.values?.[0].type, "Error");
    assert.equal(
      error.payload.exception?.values?.[0].value,
      "Real Node SDK smoke test",
    );
    assert.equal(error.payload.level, "error");
    assert.ok(
      error.payload.exception?.values?.[0].stacktrace?.frames?.some(
        (frame) =>
          frame.filename?.endsWith("test-sdk.ts") && Number(frame.lineno) > 0,
      ),
      "Exception must retain its source filename and line number",
    );
    const message = events.find((e) => e.event_id === messageId);
    assert.ok(
      message,
      "Captured message must be persisted with its SDK event ID",
    );
    assert.equal(message.payload.message, "Real Node SDK message");
    assert.equal(message.payload.level, "info");
    for (const event of [error, message]) {
      assert.equal(event.environment, "sdk-test");
      assert.equal(event.release, "sdk-smoke@1.0.0");
      assert.equal(event.payload.environment, "sdk-test");
      assert.equal(event.payload.release, "sdk-smoke@1.0.0");
      assert.equal(event.payload.platform, "node");
      assert.equal(event.payload.sdk?.name, "sentry.javascript.node");
      assert.equal(event.payload.user?.id, "sdk-test-user");
      const tags = event.payload.tags;
      assert.equal(
        Array.isArray(tags)
          ? Object.fromEntries(tags).integration
          : tags?.integration,
        "real-node-sdk",
      );
      const breadcrumbs = Array.isArray(event.payload.breadcrumbs)
        ? event.payload.breadcrumbs
        : event.payload.breadcrumbs?.values;
      assert.ok(
        breadcrumbs?.some(
          (breadcrumb) =>
            breadcrumb.category === "test" &&
            breadcrumb.message === "About to capture exception",
        ),
        "SDK breadcrumb must survive ingestion",
      );
    }
    console.log(
      "PASS: real @sentry/node exception + message, stack frames, user, tags, breadcrumbs persisted",
      { project: p.id, events: data.stats.events },
    );
    const exampleOptions = {
      timeout: 20000,
      killSignal: "SIGKILL" as const,
      signal: controller.signal,
    };
    const example = await runExample(
      process.execPath,
      ["examples/node/capture-error.mjs", dsn],
      exampleOptions,
    );
    const exampleId = example.stdout.match(
      /Captured event ([a-f0-9]{32})\./,
    )?.[1];
    assert.ok(
      exampleId,
      `First-run example must print its accepted event ID: ${example.stdout} ${example.stderr}`,
    );
    const exampleFilter = new URLSearchParams({
      project: String(p.id),
      environment: "first-run",
      status: "all",
    });
    const exampleData = dashboard(exampleFilter);
    assert.equal(exampleData.stats.events, 1);
    const exampleEvent = exampleData.issues
      .flatMap((issue) => issueDetail(issue.id)!.events)
      .find((event) => event.event_id === exampleId);
    assert.ok(
      exampleEvent,
      "First-run event must be persisted with the reported ID",
    );
    assert.equal(exampleEvent.environment, "first-run");
    assert.equal(exampleEvent.release, "crashguard-node-example@1.0.0");
    assert.equal(
      exampleEvent.payload.exception?.values?.[0].value,
      "Hello from CrashGuard",
    );
    assert.ok(
      exampleEvent.payload.exception?.values?.[0].stacktrace?.frames?.some(
        (frame) =>
          frame.filename?.endsWith("capture-error.mjs") &&
          Number(frame.lineno) > 0,
      ),
    );
    const exampleTags = exampleEvent.payload.tags;
    assert.equal(
      Array.isArray(exampleTags)
        ? Object.fromEntries(exampleTags).example
        : exampleTags?.example,
      "node",
    );
    const exampleBreadcrumbs = Array.isArray(exampleEvent.payload.breadcrumbs)
      ? exampleEvent.payload.breadcrumbs
      : exampleEvent.payload.breadcrumbs?.values;
    assert.ok(
      exampleBreadcrumbs?.some(
        (breadcrumb) =>
          breadcrumb.category === "example" &&
          breadcrumb.message === "Sending the first exception",
      ),
    );

    const invalidDsn = new URL(dsn);
    invalidDsn.username = randomBytes(16).toString("hex");
    await assert.rejects(
      runExample(
        process.execPath,
        ["examples/node/capture-error.mjs", invalidDsn.toString()],
        exampleOptions,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const failure = error as Error & {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr || "", /The event was not accepted/);
        assert.doesNotMatch(failure.stdout || "", /Captured event/);
        return true;
      },
    );
    assert.equal(
      dashboard(exampleFilter).stats.events,
      1,
      "Rejected example must not persist another event",
    );
    console.log(
      "PASS: first-run example persists its event and reports rejected DSNs as failures",
    );
  } finally {
    await Sentry.close(10000);
    db().close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
