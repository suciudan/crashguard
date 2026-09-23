import assert from "node:assert/strict";
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createProject, db } from "./test-data";
import { listTelemetry, telemetryDb } from "../src/lib/telemetry";
async function main() {
  const base = process.env.TEST_BASE_URL || "http://localhost:5002";
  const project = createProject(`Modern SDK ${Date.now()}`, "node");
  const dsn = `${base.replace("://", `://${project.public_key}@`)}/${project.id}`;
  const client = Sentry.init({
    dsn,
    release: "sdk-test@1",
    environment: "test",
    enableLogs: true,
    tracesSampleRate: 1,
    integrations: [nodeProfilingIntegration()],
    profileSessionSampleRate: 1,
    profileLifecycle: "manual",
  });
  Sentry.profiler.startProfiler();
  await Sentry.startSpan({ name: "SDK checkout", op: "test" }, async () => {
    Sentry.logger.info("Checkout started", { orderId: 123 });
    await Sentry.startSpan({ name: "CPU work", op: "function" }, async () => {
      const until = Date.now() + 150;
      while (Date.now() < until) Math.sqrt(Math.random());
    });
    Sentry.withScope((scope) => {
      scope.addAttachment({
        filename: "sdk-attachment.txt",
        data: "Attachment from real SDK",
      });
      Sentry.captureException(new Error("Modern SDK error"));
    });
  });
  Sentry.profiler.stopProfiler();
  await client?.flush(10000);
  await Sentry.close(10000);
  assert.ok(
    listTelemetry({ project: project.id, kind: "transaction" }).total > 0,
    "Node transaction was not stored",
  );
  assert.ok(
    listTelemetry({ project: project.id, kind: "log" }).total > 0,
    "Node logs were not stored",
  );
  assert.ok(
    listTelemetry({ project: project.id, kind: "attachment" }).total > 0,
    "Node attachment was not stored",
  );
  assert.ok(
    listTelemetry({ project: project.id, kind: "profile_chunk" }).total > 0,
    "Node continuous profile was not stored",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: process.env.TEST_STORAGE_STATE,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(base);
    const bundle = await build({
      stdin: {
        contents: `import * as Sentry from '@sentry/browser'; window.TestSentry=Sentry;`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const statuses: number[] = [];
    page.on("response", (response) => {
      if (response.url().includes(`/api/${project.id}/envelope`))
        statuses.push(response.status());
    });
    await page.evaluate(
      async ({ dsn }) => {
        const S = (
          window as unknown as { TestSentry: typeof import("@sentry/browser") }
        ).TestSentry;
        S.init({
          dsn,
          release: "sdk-browser@1",
          enableLogs: true,
          tracesSampleRate: 1,
          replaysSessionSampleRate: 1,
          replaysOnErrorSampleRate: 1,
          integrations: [
            S.replayIntegration({
              maskAllText: true,
              blockAllMedia: true,
              useCompression: true,
              minReplayDuration: 0,
            }),
          ],
        });
        S.logger.warn("Browser structured log", { page: "checkout" });
        await S.startSpan(
          { name: "Browser checkout", op: "ui.action" },
          async () => {
            await new Promise((r) => setTimeout(r, 100));
          },
        );
        S.captureException(new Error("Browser replay error"));
        await new Promise((r) => setTimeout(r, 1500));
        await S.getReplay()?.flush();
        await S.flush(10000);
      },
      { dsn },
    );
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200)).toBe(true);
    assert.ok(
      listTelemetry({ project: project.id, kind: "replay_recording" }).total >
        0,
      "Browser replay was not stored",
    );
    const replay = listTelemetry({ project: project.id, kind: "replay_event" })
      .rows[0];
    await page.goto(`${base}/?view=replays&record=${replay.id}`);
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.screenshot({
      path: "test-results/modern-replay.png",
      fullPage: true,
    });
    await page.goto(`${base}/?view=transactions&project=${project.id}`);
    await page.getByRole("link", { name: "SDK checkout", exact: true }).click();
    await expect(
      page.locator("summary").filter({ hasText: "CPU work" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/modern-transactions.png",
      fullPage: true,
    });
    const profile = listTelemetry({
      project: project.id,
      kind: "profile_chunk",
    }).rows[0];
    await page.goto(`${base}/?view=profiles&record=${profile.id}`);
    await expect(
      page.getByRole("heading", { name: "Sampled call stacks" }),
    ).toBeVisible();
    await page.goto(`${base}/?view=logs&project=${project.id}`);
    await expect(
      page.getByRole("link", { name: "Browser structured log" }),
    ).toBeVisible();
    await page.goto(`${base}/?view=sourcemaps&project=${project.id}`);
    await page
      .getByLabel("Source map file")
      .setInputFiles({
        name: "app.js.map",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            version: 3,
            sources: ["app.ts"],
            sourcesContent: ["throw new Error('test');"],
            names: [],
            mappings: "AAAA",
          }),
        ),
      });
    await page.getByLabel("Release", { exact: true }).fill("sdk-test@1");
    await page
      .getByLabel("Generated file URL")
      .fill("https://example.com/app.js");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Source map uploaded");
    await page.goto(`${base}/?view=releases&project=${project.id}`);
    await expect(page.getByText("sdk-test@1", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/modern-mobile.png",
      fullPage: true,
    });
    await context.close();
    console.log(
      "Actual Sentry Node/browser SDKs: transactions, spans, logs, attachments, profiles, compressed replay, UI playback and source-map upload passed.",
    );
  } finally {
    await browser.close();
    db().close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
