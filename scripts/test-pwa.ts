import {
  chromium,
  firefox,
  expect,
  type Browser,
  type Page,
} from "@playwright/test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function expectWorker(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  const urls = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys())
        result.push(new URL(request.url).pathname);
    }
    return result;
  });
  assert.deepEqual(urls, ["/offline.html"]);
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "crashguard-pwa-browser-"));
  process.env.DATABASE_PATH = join(temp, "test.sqlite");
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://localhost:${address.port}`;
  process.env.AUTH_ORIGIN = base;
  const { db, createProject, saveEvents } = await import("../src/lib/db");
  const project = createProject("PWA browser fixture", "node");
  saveEvents(project.id, [{ message: "Illustrative checkout error" }]);
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(address.port),
    ],
    { env: { ...process.env, APP_URL: base }, stdio: "pipe" },
  );
  let log = "";
  server.stdout.on("data", (chunk) => {
    log = (log + chunk).slice(-8000);
  });
  server.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-8000);
  });
  const browsers: Browser[] = [];
  try {
    await expect
      .poll(
        () =>
          fetch(base + "/api/health")
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 30000 },
      )
      .toBe(200);
    const manifestResponse = await fetch(base + "/manifest.webmanifest", {
      redirect: "manual",
    });
    assert.equal(manifestResponse.status, 200);
    const manifest = (await manifestResponse.json()) as {
      icons: { src: string }[];
    };
    for (const path of [
      "/sw.js",
      "/offline.html",
      ...manifest.icons.map((icon) => icon.src),
      "/icons/badge-96.png",
    ]) {
      const response = await fetch(base + path, { redirect: "manual" });
      assert.equal(response.status, 200, `${path} is public before sign-in`);
      if (path === "/sw.js")
        assert.match(response.headers.get("cache-control") || "", /no-cache/);
    }
    assert.equal(
      (await fetch(base + "/sw.js", { method: "POST" })).status,
      405,
    );
    assert.equal(
      (await fetch(base + "/api/mcp", { method: "POST" })).status,
      401,
    );
    assert.equal(
      (await fetch(base + "/api/private", { redirect: "manual" })).status,
      401,
    );
    assert.equal(
      (await fetch(base + "/?view=notifications", { redirect: "manual" }))
        .status,
      307,
    );

    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const key = createECDH("prime256v1");
    key.generateKeys();
    // Only browser permission and the external push provider are mocked. Service
    // worker registration, account authentication, actions, and SQLite are real.
    await context.addInitScript({
      content: `(() => {
        const keys = ${JSON.stringify({ p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") })};
        let permission = "default";
        let subscription = null;
        Object.defineProperty(Notification, "permission", {
          get: () => permission,
        });
        Notification.requestPermission = async () => {
          document.documentElement.dataset.permissionRequests = String(
            Number(document.documentElement.dataset.permissionRequests || 0) +
              1,
          );
          permission = "granted";
          return permission;
        };
        PushManager.prototype.getSubscription = async () => subscription;
        PushManager.prototype.subscribe = async (options) => {
          const endpoint =
            "https://fcm.googleapis.com/fcm/send/crashguard-browser-fixture";
          subscription = {
            endpoint,
            expirationTime: null,
            options: {
              userVisibleOnly: true,
              applicationServerKey: new Uint8Array(
                options?.applicationServerKey,
              ).buffer,
            },
            getKey: () => null,
            toJSON: () => ({
              endpoint,
              expirationTime: null,
              keys,
            }),
            unsubscribe: async () => {
              subscription = null;
              return true;
            },
          };
          return subscription;
        };
      })();`,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(base + "/login");
    await page.getByLabel("Passkey name").fill("PWA test browser");
    await page
      .getByRole("button", { name: "Create passkey", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Notifications", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Notifications on this device",
        exact: true,
      }),
    ).toBeVisible();
    await expectWorker(page);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.dataset.permissionRequests,
      ),
      undefined,
    );
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => Notification.permission), "default");
    await page.getByLabel("Device name").fill("Desktop browser fixture");
    await page
      .getByRole("button", { name: "Enable notifications", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Disable notifications", exact: true }),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.dataset.permissionRequests,
      ),
      "1",
    );
    assert.equal(
      (
        db().prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as {
          n: number;
        }
      ).n,
      1,
    );
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/notifications-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "Mobile page must not scroll horizontally",
    );
    await page.screenshot({
      path: "test-results/notifications-mobile.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Disable notifications", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Enable notifications", exact: true }),
    ).toBeEnabled();
    assert.equal(
      (
        db().prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as {
          n: number;
        }
      ).n,
      0,
    );
    const storageState = await context.storageState();
    await context.setOffline(true);
    await page.goto(base + "/?view=issues");
    await expect(
      page.getByRole("heading", { name: "You’re offline" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/pwa-offline-mobile.png",
      fullPage: true,
    });
    await context.setOffline(false);
    await page.getByRole("link", { name: "Try again" }).click();
    await expect(page.locator(".issue-list-row")).toContainText(
      "Illustrative checkout error",
    );
    await expectWorker(page);
    assert.deepEqual(errors, []);

    const firefoxBrowser = await firefox.launch({ headless: true });
    browsers.push(firefoxBrowser);
    const firefoxPage = await firefoxBrowser.newPage({
      storageState,
      viewport: { width: 1440, height: 1000 },
    });
    const firefoxErrors: string[] = [];
    firefoxPage.on("pageerror", (error) => firefoxErrors.push(error.message));
    await firefoxPage.goto(base + "/?view=notifications");
    await expect(
      firefoxPage.getByRole("heading", {
        name: "Notifications on this device",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      firefoxPage.getByRole("button", {
        name: "Enable notifications",
        exact: true,
      }),
    ).toBeEnabled();
    assert.equal(
      await firefoxPage.evaluate(() => Notification.permission),
      "default",
    );
    await expectWorker(firefoxPage);
    await firefoxPage.screenshot({
      path: "test-results/notifications-firefox.png",
      fullPage: true,
    });
    await firefoxPage.context().addInitScript({
      content: `Object.defineProperty(Notification, "permission", { get: () => "denied" });`,
    });
    await firefoxPage.reload();
    await expect(
      firefoxPage.getByText("Blocked in this browser", { exact: true }),
    ).toBeVisible();
    await expect(
      firefoxPage.getByRole("button", {
        name: "Enable notifications",
        exact: true,
      }),
    ).toBeDisabled();

    const stalledPage = await firefoxBrowser.newPage({ storageState });
    stalledPage.on("pageerror", (error) => firefoxErrors.push(error.message));
    await stalledPage.addInitScript({
      content: `
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      PushManager.prototype.getSubscription = () => new Promise(() => {});
      Notification.requestPermission = () => { throw new Error("Permission requested automatically"); };
    `,
    });
    await stalledPage.goto(base + "/?view=issues");
    await expectWorker(stalledPage);
    await stalledPage.goto(base + "/?view=notifications");
    await expect(
      stalledPage.getByRole("heading", {
        name: "Your notification devices",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      stalledPage
        .getByRole("alert")
        .filter({ hasText: "notification service did not respond" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      stalledPage.getByRole("button", {
        name: "Enable notifications",
        exact: true,
      }),
    ).toBeEnabled();
    assert.deepEqual(firefoxErrors, []);
    console.log(
      "PWA checks passed: public manifest/icons, protected routes, real Chromium/Firefox service workers, explicit notification opt-in and removal using a mocked push subscription, mobile layout, denied permission, stalled browser-service recovery, offline navigation/recovery, and no private response caching. Cloud push delivery and physical Android installation require a real-device check.",
    );
  } catch (error) {
    console.error(log);
    for (const browser of browsers) {
      const page = browser.contexts()[0]?.pages()[0];
      if (page) {
        console.error(
          await page
            .locator("body")
            .innerText()
            .catch(() => "Page unavailable"),
        );
        mkdirSync("test-results", { recursive: true });
        await page
          .screenshot({ path: "test-results/pwa-failure.png", fullPage: true })
          .catch(() => {});
      }
    }
    throw error;
  } finally {
    await Promise.all(browsers.map((browser) => browser.close()));
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill("SIGTERM");
      await stopped;
    }
    db().close();
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
