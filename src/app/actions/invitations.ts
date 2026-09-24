"use server";
import { runAction, ActionError } from "@/lib/action-guard";
import { requireOwner, requireProject } from "@/lib/access";
import { db } from "@/lib/db";
import { authOrigin } from "@/lib/auth";
import {
  createInvitation,
  consumeInvitation,
  findInvitation,
} from "@/lib/invitations";

export async function inviteToProject(project: number) {
  return runAction(() => {
    const invitation = createInvitation(project);
    return {
      id: invitation.id,
      url: `${authOrigin().origin}/invite/${invitation.token}`,
      expiresAt: invitation.expiresAt,
    };
  });
}
export async function getProjectAccess(project: number) {
  return runAction(() => {
    requireOwner();
    requireProject(project);
    return {
      members: db()
        .prepare(
          "SELECT a.id,a.name,m.created_at FROM project_members m JOIN accounts a ON a.id=m.account_id WHERE m.project_id=? ORDER BY a.name",
        )
        .all(project) as { id: number; name: string; created_at: number }[],
      invitations: db()
        .prepare(
          "SELECT id,created_at,expires_at,accepted_at,revoked_at FROM project_invitations WHERE project_id=? ORDER BY id DESC LIMIT 100",
        )
        .all(project) as {
        id: number;
        created_at: number;
        expires_at: number;
        accepted_at: number | null;
        revoked_at: number | null;
      }[],
    };
  });
}
export async function revokeInvitation(project: number, id: number) {
  return runAction(() => {
    requireOwner();
    requireProject(project);
    if (!Number.isSafeInteger(id)) throw new ActionError("Invalid invitation.");
    db()
      .prepare(
        "UPDATE project_invitations SET revoked_at=? WHERE project_id=? AND id=? AND accepted_at IS NULL",
      )
      .run(Date.now(), project, id);
    return { ok: true };
  });
}
export async function removeProjectMember(project: number, account: number) {
  return runAction(() => {
    requireOwner();
    requireProject(project);
    if (!Number.isSafeInteger(account))
      throw new ActionError("Invalid account.");
    db()
      .prepare(
        "DELETE FROM project_members WHERE project_id=? AND account_id=?",
      )
      .run(project, account);
    return { ok: true };
  });
}
export async function acceptInvitation(token: string) {
  return runAction(({ current }) =>
    db()
      .transaction(() => {
        const invitation = findInvitation(token);
        return {
          project: consumeInvitation(
            invitation.token_hash,
            current!.account_id,
          ),
        };
      })
      .immediate(),
  );
}
