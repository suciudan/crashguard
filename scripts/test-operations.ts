import { chromium, expect } from "@playwright/test";
import { createProject, db, envelope } from "./test-data";
import { randomUUID } from "node:crypto";
async function main() {
  const base = process.env.TEST_BASE_URL!;
  const project = createProject("Operations " + Date.now(), "node");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: process.env.TEST_STORAGE_STATE,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/?view=alerts&project=${project.id}`);
    await page.getByLabel("Name", { exact: true }).fill("Production failures");
    await page
      .getByLabel("Webhook URL", { exact: true })
      .fill("http://127.0.0.1:5000/api/health");
    await page
      .getByRole("button", { name: "Create alert", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Save this signing secret:",
    );
    const sent = await context.request.post(
      `${base}/api/${project.id}/envelope/?sentry_key=${project.public_key}`,
      {
        data: envelope({
          event_id: randomUUID().replaceAll("-", ""),
          message: "Alert UI test",
          level: "error",
        }),
      },
    );
    expect(sent.status()).toBe(200);
    await expect
      .poll(
        () => {
          const j = db()
            .prepare(
              "SELECT attempts FROM jobs WHERE kind='alert' AND json_extract(payload,'$.project')=?",
            )
            .get(project.id) as { attempts: number } | undefined;
          return j?.attempts || 0;
        },
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Webhook returned HTTP 405")).toBeVisible();
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Enable", exact: true }),
    ).toBeVisible();
    await page.goto(`${base}/?view=releases&project=${project.id}`);
    await page.getByLabel("Version", { exact: true }).fill("operations@1");
    await page.getByLabel("Notes", { exact: true }).fill("First deployment");
    await page.getByLabel("Mark released", { exact: true }).check();
    await page
      .getByRole("button", { name: "Save release", exact: true })
      .click();
    await expect(page.getByText("Released", { exact: true })).toBeVisible();
    console.log(
      "PASS: alert rule creation/one-time secret, production background worker, failure history, disable, release creation/finalization through authenticated Server Actions.",
    );
  } finally {
    await browser.close();
    db().close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
