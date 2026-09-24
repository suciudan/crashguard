import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { hashToken } from "./auth";
import { AccessError, currentAccount, type Account } from "./access";

export type McpToken = {
  id: number;
  name: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};
function signedIn() {
  const account = currentAccount();
  if (!account) throw new AccessError("Sign in to manage MCP connections.");
  return account;
}
export function listMcpTokens(): McpToken[] {
  return db()
    .prepare(
      "SELECT id,name,created_at,expires_at,last_used_at,revoked_at FROM mcp_tokens WHERE account_id=? ORDER BY id DESC",
    )
    .all(signedIn().account_id) as McpToken[];
}
export function createMcpToken(name: string) {
  const account = signedIn();
  const parsed = z.string().trim().min(1).max(60).safeParse(name);
  if (!parsed.success)
    throw new AccessError("Enter a connection name (1–60 characters).");
  return db()
    .transaction(() => {
      const now = Date.now();
      const count = db()
        .prepare(
          "SELECT COUNT(*) AS n FROM mcp_tokens WHERE account_id=? AND revoked_at IS NULL AND expires_at>?",
        )
        .get(account.account_id, now) as { n: number };
      if (count.n >= 20)
        throw new AccessError(
          "Revoke an existing connection before creating another (limit 20).",
        );
      const token = `cg_mcp_${randomBytes(32).toString("hex")}`;
      const expiresAt = now + 90 * 24 * 60 * 60 * 1000;
      const result = db()
        .prepare(
          "INSERT INTO mcp_tokens(account_id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        )
        .run(account.account_id, parsed.data, hashToken(token), now, expiresAt);
      return { id: Number(result.lastInsertRowid), token, expiresAt };
    })
    .immediate();
}
export function revokeMcpToken(id: number) {
  const account = signedIn();
  if (!Number.isSafeInteger(id) || id < 1)
    throw new AccessError("Invalid connection.");
  db()
    .prepare(
      "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND account_id=?",
    )
    .run(Date.now(), id, account.account_id);
}
export function authenticateMcp(
  authorization: string | null,
): { account: Account; limited: boolean } | null {
  const token = /^Bearer (cg_mcp_[a-f0-9]{64})$/i.exec(
    authorization || "",
  )?.[1];
  if (!token) return null;
  return db()
    .transaction(() => {
      const now = Date.now();
      const row = db()
        .prepare(
          `SELECT t.id AS token_id,a.id AS account_id,a.name AS account_name,a.role,a.user_handle
      FROM mcp_tokens t JOIN accounts a ON a.id=t.account_id
      WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?
      AND EXISTS (SELECT 1 FROM account_passkeys k WHERE k.account_id=a.id)`,
        )
        .get(hashToken(token), now) as
        (Account & { token_id: number }) | undefined;
      if (!row) return null;
      const window = Math.floor(now / 60000);
      db()
        .prepare(
          `UPDATE mcp_tokens SET last_used_at=?,rate_count=CASE WHEN rate_window=? THEN rate_count+1 ELSE 1 END,rate_window=? WHERE id=?`,
        )
        .run(now, window, window, row.token_id);
      const rate = db()
        .prepare("SELECT rate_count FROM mcp_tokens WHERE id=?")
        .get(row.token_id) as { rate_count: number };
      return { account: row, limited: rate.rate_count > 120 };
    })
    .immediate();
}
