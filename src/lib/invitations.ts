import { randomBytes } from "node:crypto";
import { db } from "./db";
import { hashToken } from "./auth";
import {
  AccessError,
  currentAccount,
  requireOwner,
  requireProject,
} from "./access";

type Invitation = {
  id: number;
  project_id: number;
  project_name: string;
  token_hash: string;
};
export function invitationByHash(hash: string): Invitation {
  const invitation = db()
    .prepare(
      `SELECT i.id,i.project_id,i.token_hash,p.name AS project_name
    FROM project_invitations i JOIN projects p ON p.id=i.project_id
    WHERE i.token_hash=? AND i.expires_at>? AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,
    )
    .get(hash, Date.now()) as Invitation | undefined;
  if (!invitation)
    throw new AccessError(
      "This invitation is invalid, expired, or has already been used.",
    );
  return invitation;
}
export function findInvitation(token: string) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw new AccessError(
      "This invitation is invalid, expired, or has already been used.",
    );
  return invitationByHash(hashToken(token));
}
export function createInvitation(project: number) {
  requireOwner();
  requireProject(project);
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const result = db()
    .prepare(
      "INSERT INTO project_invitations(project_id,token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?)",
    )
    .run(
      project,
      hashToken(token),
      currentAccount()!.account_id,
      Date.now(),
      expiresAt,
    );
  return { id: Number(result.lastInsertRowid), token, expiresAt };
}
// Call in the same immediate transaction as enrollment. Concurrent acceptance
// or revocation cannot leave a credential or membership partially created.
export function consumeInvitation(hash: string, accountId: number) {
  const invitation = invitationByHash(hash);
  const result = db()
    .prepare(
      "UPDATE project_invitations SET accepted_by=?,accepted_at=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?",
    )
    .run(accountId, Date.now(), invitation.id, Date.now());
  if (!result.changes)
    throw new AccessError("This invitation is no longer available.");
  db()
    .prepare(
      "INSERT OR IGNORE INTO project_members(project_id,account_id,created_at) VALUES(?,?,?)",
    )
    .run(invitation.project_id, accountId, Date.now());
  return invitation.project_id;
}
