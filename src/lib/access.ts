import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "./db";

export type Account = {
  account_id: number;
  account_name: string;
  role: "owner" | "member";
  user_handle: string;
};
const access = new AsyncLocalStorage<Account | null>();
export const withAccount = <T>(account: Account | null, work: () => T) =>
  access.run(account, work);
export const currentAccount = () => access.getStore();
export class AccessError extends Error {}

// No context is reserved for internal ingestion/background jobs. Actions always
// establish a context, including an explicit null for anonymous auth actions.
export function projectScope(column = "project_id") {
  const account = currentAccount();
  if (account === undefined || account?.role === "owner") return "1=1";
  if (!account) return "0=1";
  if (!Number.isSafeInteger(account.account_id))
    throw new AccessError("Invalid account.");
  return `${column} IN (SELECT project_id FROM project_members WHERE account_id=${account.account_id})`;
}
export function requireOwner() {
  if (currentAccount()?.role !== "owner")
    throw new AccessError(
      "Only the workspace owner can manage projects and invitations.",
    );
}
export function requireProject(id: number) {
  if (
    !Number.isSafeInteger(id) ||
    !db()
      .prepare(`SELECT 1 FROM projects WHERE id=? AND ${projectScope("id")}`)
      .get(id)
  )
    throw new AccessError("Project not found or access denied.");
}
