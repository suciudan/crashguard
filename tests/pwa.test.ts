import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import manifest from "../src/app/manifest";

const origin = "https://crashguard.example";
const source = readFileSync(
  new URL("../public/sw.js", import.meta.url),
  "utf8",
);

function worker() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const notifications: { title: string; options: NotificationOptions }[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const opened: string[] = [];
  const state = {
    offline: false,
    cached: new Response("Public offline page"),
    clients: [] as {
      url: string;
      navigate: (url: string) => Promise<{ focus: () => Promise<void> } | null>;
    }[],
    claimed: false,
  };
  runInNewContext(source, {
    URL,
    Response,
    self: {
      location: { origin },
      addEventListener: (
        name: string,
        handler: (event: Record<string, unknown>) => void,
      ) => handlers.set(name, handler),
      skipWaiting: async () => {},
      registration: {
        showNotification: async (
          title: string,
          options: NotificationOptions,
        ) => {
          notifications.push({ title, options });
        },
      },
      clients: {
        claim: async () => {
          state.claimed = true;
        },
        matchAll: async () => state.clients,
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    },
    caches: {
      open: async () => ({
        add: async (url: string) => {
          added.push(url);
        },
      }),
      keys: async () => [
        "crashguard-offline-v0",
        "crashguard-offline-v1",
        "another-app",
      ],
      delete: async (name: string) => {
        deleted.push(name);
      },
      match: async (url: string) => {
        assert.equal(url, "/offline.html");
        return state.cached.clone();
      },
    },
    fetch: async () => {
      if (state.offline) throw new TypeError("Network unavailable");
      return new Response("Private dashboard from network");
    },
  });
  async function dispatch(
    name: string,
    properties: Record<string, unknown> = {},
  ) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const handler = handlers.get(name);
    assert.ok(handler, `${name} handler is registered`);
    handler({
      ...properties,
      waitUntil: (value: Promise<unknown>) => pending.push(value),
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    await Promise.all(pending);
    return response;
  }
  return { state, dispatch, notifications, added, deleted, opened };
}

test("installable manifest uses valid Android icons with a maskable variant", () => {
  const value = manifest();
  assert.equal(value.display, "standalone");
  assert.equal(value.scope, "/");
  assert.equal(value.start_url, "/?view=issues");
  assert.ok(value.icons?.some((icon) => icon.purpose === "maskable"));
  for (const icon of value.icons || []) {
    const bytes = readFileSync(
      new URL(`../public${icon.src}`, import.meta.url),
    );
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(
      `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`,
      icon.sizes,
    );
  }
});

test("push always displays a bounded notification, including malformed payloads", async () => {
  const w = worker();
  await w.dispatch("push", {
    data: {
      json: () => ({
        title: "A".repeat(300),
        body: "B".repeat(500),
        url: "/?view=issues&issue=42",
      }),
    },
  });
  assert.equal(w.notifications[0].title.length, 100);
  assert.equal(w.notifications[0].options.body?.length, 250);
  assert.equal(
    w.notifications[0].options.data.url,
    `${origin}/?view=issues&issue=42`,
  );
  for (const data of [
    undefined,
    {
      json: () => {
        throw new SyntaxError("not JSON");
      },
    },
    { json: () => null },
    { json: () => 17 },
  ]) {
    await w.dispatch("push", { data });
    assert.equal(w.notifications.at(-1)?.title, "CrashGuard");
    assert.equal(
      w.notifications.at(-1)?.options.data.url,
      `${origin}/?view=issues`,
    );
  }
  assert.equal(w.notifications.length, 5);
});

test("push destinations cannot navigate off site or to application endpoints", async () => {
  const w = worker();
  for (const url of [
    "https://attacker.example/",
    "//attacker.example/",
    "javascript:alert(1)",
    "/api/mcp",
    "/login",
    "http://[invalid",
  ]) {
    await w.dispatch("push", { data: { json: () => ({ url }) } });
    assert.equal(
      w.notifications.at(-1)?.options.data.url,
      `${origin}/?view=issues`,
    );
  }
});

test("notification click reuses an app window and opens one if navigation fails", async () => {
  const w = worker();
  let closed = 0;
  const navigated: string[] = [];
  let focused = 0;
  w.state.clients = [
    {
      url: "https://other.example/",
      navigate: async () => {
        assert.fail("Unrelated window");
      },
    },
    {
      url: `${origin}/?view=dashboard`,
      navigate: async (url) => {
        navigated.push(url);
        return {
          focus: async () => {
            focused++;
          },
        };
      },
    },
  ];
  await w.dispatch("notificationclick", {
    notification: {
      close: () => {
        closed++;
      },
      data: { url: `${origin}/?view=issues&issue=42` },
    },
  });
  assert.deepEqual(navigated, [`${origin}/?view=issues&issue=42`]);
  assert.equal(focused, 1);
  assert.deepEqual(w.opened, []);
  w.state.clients = [
    {
      url: origin,
      navigate: async () => {
        throw new Error("Tab closed");
      },
    },
  ];
  await w.dispatch("notificationclick", {
    notification: {
      close: () => {
        closed++;
      },
      data: { url: "https://attacker.example/" },
    },
  });
  assert.deepEqual(w.opened, [`${origin}/?view=issues`]);
  assert.equal(closed, 2);
});

test("worker caches only the public offline page and never caches private responses", async () => {
  const w = worker();
  await w.dispatch("install");
  await w.dispatch("activate");
  assert.deepEqual(w.added, ["/offline.html"]);
  assert.deepEqual(w.deleted, ["crashguard-offline-v0"]);
  assert.equal(w.state.claimed, true);
  const navigate = {
    method: "GET",
    mode: "navigate",
    url: `${origin}/?view=issues`,
  };
  const online = await w.dispatch("fetch", { request: navigate });
  assert.equal(await online?.text(), "Private dashboard from network");
  w.state.offline = true;
  const offline = await w.dispatch("fetch", { request: navigate });
  assert.equal(await offline?.text(), "Public offline page");
  for (const request of [
    { method: "GET", mode: "same-origin", url: `${origin}/api/issues` },
    { method: "POST", mode: "navigate", url: origin },
    { method: "GET", mode: "cors", url: `${origin}/_next/data/private` },
  ])
    assert.equal(await w.dispatch("fetch", { request }), undefined);
  assert.deepEqual(w.added, ["/offline.html"]);
});
