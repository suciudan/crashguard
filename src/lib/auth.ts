import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import type { Account } from "./access";

export const SESSION_COOKIE = "cg_session";
export const CHALLENGE_COOKIE = "cg_challenge";
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function authOrigin() {
  const url = new URL(
    process.env.AUTH_ORIGIN || process.env.APP_URL || "http://localhost:5000",
  );
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost")) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Set AUTH_ORIGIN to your HTTPS URL, or http://localhost:5000 for local development.",
    );
  return {
    origin: url.origin,
    rpID: url.hostname,
    secure: url.protocol === "https:",
  };
}
export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: authOrigin().secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
export function hasPasskeys() {
  return Boolean(db().prepare("SELECT 1 FROM passkeys LIMIT 1").get());
}
export function identity() {
  db()
    .prepare("INSERT OR IGNORE INTO auth_identity(id, user_id) VALUES (1, ?)")
    .run(randomBytes(32).toString("base64url"));
  return (
    db().prepare("SELECT user_id FROM auth_identity WHERE id = 1").get() as {
      user_id: string;
    }
  ).user_id;
}
export function session(request: { cookies: CookieReader }) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return (
    (db()
      .prepare(
        "SELECT s.*, a.id AS account_id, a.name AS account_name, a.role, a.user_handle FROM auth_sessions s JOIN account_passkeys k ON k.credential_id=s.credential_id JOIN accounts a ON a.id=k.account_id WHERE s.token_hash = ? AND s.expires_at > ?",
      )
      .get(hashToken(token), Date.now()) as
      | (Account & {
          token_hash: string;
          credential_id: string;
          expires_at: number;
        })
      | undefined) || null
  );
}
export function signIn(jar: CookieWriter, credentialId: string) {
  const token = randomBytes(32).toString("hex");
  db()
    .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
    .run(Date.now());
  const previous = jar.get(SESSION_COOKIE)?.value;
  if (previous)
    db()
      .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
      .run(hashToken(previous));
  db()
    .prepare("INSERT INTO auth_sessions VALUES (?, ?, ?)")
    .run(hashToken(token), credentialId, Date.now() + SESSION_SECONDS * 1000);
  jar.set(SESSION_COOKIE, token, cookieOptions(SESSION_SECONDS));
  jar.set(CHALLENGE_COOKIE, "", cookieOptions(0));
}
export type Challenge = {
  challenge: string;
  kind: string;
  session_hash: string | null;
  expires_at: number;
  data?: string;
};
export function saveChallenge(
  jar: CookieWriter,
  challenge: string,
  kind: string,
  sessionHash: string | null,
  data?: unknown,
) {
  const token = randomBytes(32).toString("hex");
  db().transaction(() => {
    db()
      .prepare("DELETE FROM auth_challenges WHERE expires_at <= ?")
      .run(Date.now());
    const previous = jar.get(CHALLENGE_COOKIE)?.value;
    if (previous)
      db()
        .prepare("DELETE FROM auth_challenges WHERE token_hash = ?")
        .run(hashToken(previous));
    const { count } = db()
      .prepare("SELECT COUNT(*) AS count FROM auth_challenges")
      .get() as { count: number };
    if (count >= 1000)
      throw new Error("Too many sign-in attempts. Please try again shortly.");
    db()
      .prepare("INSERT INTO auth_challenges VALUES (?, ?, ?, ?, ?)")
      .run(
        hashToken(token),
        challenge,
        kind,
        sessionHash,
        Date.now() + 5 * 60 * 1000,
      );
    if (data !== undefined)
      db()
        .prepare("INSERT INTO auth_enrollments(token_hash,data) VALUES (?,?)")
        .run(hashToken(token), JSON.stringify(data));
  })();
  jar.set(CHALLENGE_COOKIE, token, cookieOptions(300));
}
export function takeChallenge(
  request: { cookies: CookieReader },
  kind: string,
) {
  const token = request.cookies.get(CHALLENGE_COOKIE)?.value || "";
  const result = db()
    .transaction(() => {
      const row = db()
        .prepare(
          "SELECT c.*, e.data FROM auth_challenges c LEFT JOIN auth_enrollments e ON e.token_hash=c.token_hash WHERE c.token_hash=?",
        )
        .get(hashToken(token)) as Challenge | undefined;
      db()
        .prepare("DELETE FROM auth_challenges WHERE token_hash=?")
        .run(hashToken(token));
      return row;
    })
    .immediate();
  if (!result || result.kind !== kind || result.expires_at <= Date.now())
    throw new Error(
      "This request expired or was already used. Please try again.",
    );
  return result;
}
export type CookieReader = { get(name: string): { value: string } | undefined };
export type CookieWriter = CookieReader & {
  set(
    name: string,
    value: string,
    options: ReturnType<typeof cookieOptions>,
  ): unknown;
};
