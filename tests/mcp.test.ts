import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { db, createProject, saveEvents } from "../src/lib/db";
import { hashToken } from "../src/lib/auth";
import { withAccount, type Account } from "../src/lib/access";
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  authenticateMcp,
} from "../src/lib/mcp-tokens";
import { boundedMcpValue, handleMcpRequest } from "../src/lib/mcp";
import { proxy } from "../src/proxy";
import { uploadSourceMap } from "../src/lib/sourcemaps";

const temp = mkdtempSync(join(tmpdir(), "crashguard-mcp-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
process.env.AUTH_ORIGIN = "http://localhost:5000";
const endpoint = "http://localhost:5000/api/mcp";
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
});
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
db().exec(`INSERT INTO accounts VALUES(2,'Member','member','member',0);
  INSERT INTO passkeys VALUES('owner-key',X'01',0,'[]','Owner',0),('member-key',X'01',0,'[]','Member',0);
  INSERT INTO account_passkeys VALUES('owner-key',1),('member-key',2);`);
const visible = createProject("Visible app", "node");
const hidden = createProject("Private app", "node");
db()
  .prepare("INSERT INTO project_members VALUES(?,?,0)")
  .run(visible.id, member.account_id);
const eventIds = saveEvents(
  visible.id,
  Array.from({ length: 35 }, (_, i) => ({
    message: "Checkout failed",
    fingerprint: ["checkout"],
    environment: "production",
    release: "app@1",
    tags: { attempt: String(i) },
    exception: {
      values: [
        {
          type: "Error",
          value: "Checkout failed",
          stacktrace: {
            frames: [{ filename: "bundle.js", lineno: 1, colno: 1 }],
          },
        },
      ],
    },
    breadcrumbs: [{ message: "Opened checkout" }],
  })),
);
const privateIds = saveEvents(hidden.id, [{ message: "Private failure" }]);
const issue = db()
  .prepare("SELECT id FROM issues WHERE project_id=?")
  .get(visible.id) as { id: number };
const privateIssue = db()
  .prepare("SELECT id FROM issues WHERE project_id=?")
  .get(hidden.id) as { id: number };
uploadSourceMap(
  visible.id,
  "app@1",
  "bundle.js",
  "",
  JSON.stringify({
    version: 3,
    sources: ["checkout.ts"],
    names: [],
    mappings: "AAAA",
    sourcesContent: ["throw new Error('Checkout failed');"],
  }),
);

function token(account = owner) {
  return withAccount(account, () => createMcpToken("Test client"));
}
async function connect(value: string) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${value}` } },
    fetch: async (url, init) => {
      const request = new Request(url, init);
      assert.equal(proxy(new NextRequest(request.clone())).status, 200);
      return handleMcpRequest(request);
    },
  });
  await client.connect(transport);
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent as Record<string, any>;
}

test("tokens are hashed, shown only on creation, account-owned, expiring and revocable", () => {
  assert.throws(() => createMcpToken("anonymous"));
  assert.throws(() => withAccount(null, listMcpTokens));
  assert.throws(() => withAccount(owner, () => createMcpToken(" ")));
  const created = token();
  assert.match(created.token, /^cg_mcp_[a-f0-9]{64}$/);
  assert.ok(
    db()
      .prepare("SELECT 1 FROM mcp_tokens WHERE token_hash=?")
      .get(hashToken(created.token)),
  );
  assert.ok(
    !JSON.stringify(withAccount(owner, listMcpTokens)).includes(created.token),
  );
  withAccount(member, () => revokeMcpToken(created.id));
  assert.equal(
    authenticateMcp(`Bearer ${created.token}`)?.account.account_id,
    1,
  );
  withAccount(owner, () => revokeMcpToken(created.id));
  assert.equal(authenticateMcp(`Bearer ${created.token}`), null);
  const expired = token();
  db().prepare("UPDATE mcp_tokens SET expires_at=0 WHERE id=?").run(expired.id);
  assert.equal(authenticateMcp(`Bearer ${expired.token}`), null);
});

test("HTTP rejects anonymous, cookie/DSN auth, foreign origins and unsupported methods", async () => {
  const created = token();
  for (const headers of [
    {},
    { cookie: "cg_session=anything" },
    { authorization: `Bearer ${visible.public_key}` },
  ] as Record<string, string>[]) {
    const response = await handleMcpRequest(
      new Request(endpoint, { method: "POST", headers }),
    );
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate")!, /Bearer/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  for (const extra of [
    { origin: "https://evil.example" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
  ] as Record<string, string>[]) {
    const response = await handleMcpRequest(
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${created.token}`, ...extra },
      }),
    );
    assert.equal(response.status, 403);
  }
  for (const method of ["GET", "DELETE"]) {
    const response = await handleMcpRequest(
      new Request(endpoint, {
        method,
        headers: { authorization: `Bearer ${created.token}` },
      }),
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
});

test("real MCP client initializes and reads projects, filtered issues and symbolicated events", async () => {
  const client = await connect(token(member).token);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      "get_event",
      "get_issue",
      "list_projects",
      "search_issues",
    ]);
    assert.ok(
      tools.tools.every(
        (t) => t.annotations?.readOnlyHint && !t.annotations?.destructiveHint,
      ),
    );
    const listed = await call(client, "list_projects");
    assert.deepEqual(
      listed.projects.map((p: { id: number }) => p.id),
      [visible.id],
    );
    assert.ok(!JSON.stringify(listed).includes(visible.public_key));
    const search = await call(client, "search_issues", {
      project_id: visible.id,
      query: "Checkout",
      hours: 168,
      environment: "production",
      release: "app@1",
    });
    assert.equal(search.total, 1);
    assert.equal(search.issues[0].event_count, 35);
    assert.equal(
      (await call(client, "search_issues", { environment: "staging" })).total,
      0,
    );
    const detail = await call(client, "get_issue", { issue_id: issue.id });
    assert.equal(detail.events.length, 30);
    assert.equal(detail.next_offset, 30);
    const next = await call(client, "get_issue", {
      issue_id: issue.id,
      offset: 30,
    });
    assert.equal(next.events.length, 5);
    assert.equal(next.next_offset, null);
    const event = await call(client, "get_event", {
      issue_id: issue.id,
      event_id: eventIds[0],
    });
    assert.equal(
      event.event.payload.exception.values[0].stacktrace.frames[0].filename,
      "checkout.ts",
    );
    assert.equal(event.event.payload.breadcrumbs[0].message, "Opened checkout");
    assert.equal(event.truncated, false);
    assert.match(event.url, new RegExp(`event=${eventIds[0]}`));
    for (const [name, args] of [
      ["get_issue", { issue_id: privateIssue.id }],
      ["get_event", { issue_id: privateIssue.id, event_id: privateIds[0] }],
      ["get_event", { issue_id: issue.id, event_id: privateIds[0] }],
      ["search_issues", { project_id: hidden.id }],
      ["get_issue", { issue_id: -1 }],
      ["get_event", { issue_id: issue.id, event_id: "invalid" }],
      ["search_issues", { hours: 999 }],
    ] as const)
      assert.equal(
        (await client.callTool({ name, arguments: args })).isError,
        true,
      );
    db()
      .prepare("DELETE FROM project_members WHERE account_id=?")
      .run(member.account_id);
    assert.equal((await call(client, "list_projects")).projects.length, 0);
    assert.equal(
      (
        await client.callTool({
          name: "get_issue",
          arguments: { issue_id: issue.id },
        })
      ).isError,
      true,
    );
  } finally {
    db()
      .prepare("INSERT OR IGNORE INTO project_members VALUES(?,?,0)")
      .run(visible.id, member.account_id);
    await client.close();
  }
});

test("concurrent clients remain isolated; revocation applies to an already-connected client", async () => {
  const memberToken = token(member);
  const ownerClient = await connect(token().token);
  const memberClient = await connect(memberToken.token);
  try {
    const results = await Promise.all([
      call(ownerClient, "list_projects"),
      call(memberClient, "list_projects"),
    ]);
    assert.equal(results[0].projects.length, 2);
    assert.equal(results[1].projects.length, 1);
    withAccount(member, () => revokeMcpToken(memberToken.id));
    await assert.rejects(() =>
      memberClient.callTool({ name: "list_projects", arguments: {} }),
    );
  } finally {
    await ownerClient.close();
    await memberClient.close();
  }
});

test("HTTP limits request bodies and per-token request rates", async () => {
  const created = token();
  const headers = {
    authorization: `Bearer ${created.token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  assert.equal(
    (
      await handleMcpRequest(
        new Request(endpoint, {
          method: "POST",
          headers,
          body: "x".repeat(65537),
        }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await handleMcpRequest(
        new Request(endpoint, { method: "POST", headers, body: "{" }),
      )
    ).status,
    400,
  );
  db()
    .prepare("UPDATE mcp_tokens SET rate_window=?,rate_count=120 WHERE id=?")
    .run(Math.floor(Date.now() / 60000), created.id);
  const limited = await handleMcpRequest(
    new Request(endpoint, { method: "POST", headers, body: "{}" }),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});

test("large diagnostic payloads are bounded and explicitly marked", () => {
  const result = boundedMcpValue({
    message: "x".repeat(10000),
    breadcrumbs: Array.from({ length: 200 }, () => ({
      message: "y".repeat(10000),
    })),
  });
  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length < 70000);
  const hostileKeys = boundedMcpValue({
    ["k".repeat(100000)]: "value",
    normal: "retained",
  });
  assert.equal(hostileKeys.truncated, true);
  assert.deepEqual(hostileKeys.data, { normal: "retained" });
});

test("workspace recovery revokes MCP tokens and preserves errors", async () => {
  const created = token();
  const recoveryPath = join(temp, "recovery.sqlite");
  await db().backup(recoveryPath);
  execFileSync(process.execPath, ["scripts/reset-passkeys.mjs", "--confirm"], {
    env: { ...process.env, DATABASE_PATH: recoveryPath },
    stdio: "pipe",
  });
  const restored = new Database(recoveryPath);
  assert.ok(
    (
      restored
        .prepare("SELECT revoked_at FROM mcp_tokens WHERE id=?")
        .get(created.id) as { revoked_at: number }
    ).revoked_at,
  );
  assert.equal(
    (
      restored.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n,
    36,
  );
  restored.close();
});
