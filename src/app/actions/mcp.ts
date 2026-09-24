"use server";
import { runAction } from "@/lib/action-guard";
import { authOrigin } from "@/lib/auth";
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
} from "@/lib/mcp-tokens";

export async function getMcpConnections() {
  return runAction(() => ({
    endpoint: `${authOrigin().origin}/api/mcp`,
    tokens: listMcpTokens(),
  }));
}
export async function addMcpConnection(name: string) {
  return runAction(() => createMcpToken(name));
}
export async function removeMcpConnection(id: number) {
  return runAction(() => {
    revokeMcpToken(id);
    return { ok: true };
  });
}
