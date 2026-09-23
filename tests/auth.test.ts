import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { proxy } from "../src/proxy";
import { db } from "../src/lib/db";
import {
  session,
  signIn as writeSession,
  saveChallenge as writeChallenge,
  takeChallenge,
  authOrigin,
  hashToken,
} from "../src/lib/auth";
const json = NextResponse.json;
function signIn(response: NextResponse, _request: NextRequest, id: string) {
  writeSession(response.cookies, id);
  return response;
}
function saveChallenge(
  response: NextResponse,
  _request: NextRequest,
  value: string,
  kind: string,
  hash: string | null,
) {
  writeChallenge(response.cookies, value, kind, hash);
  return response;
}
const initial = { ...process.env };
const temp = mkdtempSync(join(tmpdir(), "crashguard-auth-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
process.env.AUTH_ORIGIN = "http://localhost:5000";
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
  process.env = initial;
});
function req(
  path = "/api/projects",
  extra: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {},
) {
  return new NextRequest(`http://localhost:5000${path}`, extra);
}
function login() {
  db()
    .prepare(
      "INSERT OR IGNORE INTO passkeys VALUES ('test-key', X'01', 0, '[]', 'Test', 0)",
    )
    .run();
  return signIn(json({}), req(), "test-key").cookies.get("cg_session")!.value;
}
test("dashboard always requires a session, while ingestion and setup remain reachable", () => {
  assert.equal(proxy(req()).status, 401);
  const redirected = proxy(req("/?issue=12&tab=raw"));
  assert.equal(redirected.status, 307);
  assert.equal(
    new URL(redirected.headers.get("location")!).searchParams.get("next"),
    "/?issue=12&tab=raw",
  );
  for (const path of ["/login", "/api/health"])
    assert.equal(proxy(req(path)).status, 200);
  assert.equal(proxy(req("/api/1/envelope/", { method: "POST" })).status, 200);
  for (const method of ["GET", "HEAD", "OPTIONS", "PUT"]) {
    const response = proxy(req("/api/1/envelope/", { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(
    proxy(
      req("/", {
        headers: {
          authorization:
            "Basic " + Buffer.from("admin:password").toString("base64"),
        },
      }),
    ).status,
    307,
  );
});
test("sessions are hashed, expire, and are revoked when their passkey is removed", () => {
  const token = login();
  const request = req("/", { headers: { cookie: `cg_session=${token}` } });
  assert.equal(proxy(request).status, 200);
  assert.ok(session(request));
  assert.equal(
    (
      db().prepare("SELECT token_hash FROM auth_sessions").get() as {
        token_hash: string;
      }
    ).token_hash,
    hashToken(token),
  );
  db().prepare("UPDATE auth_sessions SET expires_at = 0").run();
  assert.equal(session(request), null);
  const replacement = login();
  db().prepare("DELETE FROM passkeys WHERE id = 'test-key'").run();
  assert.equal(
    session(req("/", { headers: { cookie: `cg_session=${replacement}` } })),
    null,
  );
});
test("auth mutations reject missing/cross-origin requests; same-origin authenticated writes work", () => {
  const token = login();
  const headers = {
    origin: "http://localhost:5000",
    "content-type": "application/json",
    cookie: `cg_session=${token}`,
  };
  assert.equal(proxy(req("/", { method: "POST", headers })).status, 200);
  assert.equal(
    proxy(
      req("/login", {
        method: "POST",
        headers: { ...headers, origin: "https://evil.example" },
      }),
    ).status,
    403,
  );
  assert.equal(
    proxy(
      req("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    ).status,
    403,
  );
  assert.equal(
    proxy(
      req("/login", {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "text/plain;charset=UTF-8",
          "next-action": "test-action",
        },
      }),
    ).status,
    200,
  );
});
test("challenges are browser-bound, short-lived, single-use, and purpose-bound", () => {
  const options = saveChallenge(
    json({}),
    req(),
    "test-challenge",
    "register",
    null,
  );
  const cookie = options.cookies.get("cg_challenge")!.value;
  assert.equal(options.cookies.get("cg_challenge")!.httpOnly, true);
  assert.throws(() => takeChallenge(req(), "register"));
  const request = req("/", { headers: { cookie: `cg_challenge=${cookie}` } });
  assert.equal(takeChallenge(request, "register").challenge, "test-challenge");
  assert.throws(() => takeChallenge(request, "register"));
  const expired = saveChallenge(
    json({}),
    req(),
    "expired",
    "register",
    null,
  ).cookies.get("cg_challenge")!.value;
  db().prepare("UPDATE auth_challenges SET expires_at = 0").run();
  assert.throws(() =>
    takeChallenge(
      req("/", { headers: { cookie: `cg_challenge=${expired}` } }),
      "register",
    ),
  );
  const wrong = saveChallenge(
    json({}),
    req(),
    "wrong",
    "register",
    null,
  ).cookies.get("cg_challenge")!.value;
  assert.throws(() =>
    takeChallenge(
      req("/", { headers: { cookie: `cg_challenge=${wrong}` } }),
      "authenticate",
    ),
  );
});
test("production passkeys require HTTPS and use secure cookies", () => {
  process.env.AUTH_ORIGIN = "http://example.com";
  assert.throws(authOrigin);
  process.env.AUTH_ORIGIN = "https://errors.example.com";
  assert.equal(authOrigin().rpID, "errors.example.com");
  const cookie = signIn(json({}), req(), "test-key").cookies.get("cg_session")!;
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  process.env.AUTH_ORIGIN = "http://localhost:5000";
});
