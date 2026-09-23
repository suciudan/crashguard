import { cookies, headers } from "next/headers";
import { authOrigin, session } from "./auth";
import type { ActionResult } from "./action-result";

export class ActionError extends Error {}
export async function runAction<T>(
  work: (context: {
    cookies: Awaited<ReturnType<typeof cookies>>;
    current: ReturnType<typeof session>;
  }) => T | Promise<T>,
  options: { public?: boolean } = {},
): Promise<ActionResult<T>> {
  try {
    // Each action checks its own origin and session, independently of the proxy.
    const requestHeaders = await headers();
    if (
      requestHeaders.get("origin") !== authOrigin().origin ||
      requestHeaders.get("sec-fetch-site") === "cross-site"
    )
      return { error: "Cross-origin dashboard requests are not allowed." };
    const jar = await cookies();
    const current = session({ cookies: jar });
    if (!options.public && !current)
      return {
        error: "Sign in with your passkey to continue.",
        code: "UNAUTHENTICATED",
      };
    return { data: await work({ cookies: jar, current }) };
  } catch (error) {
    if (error instanceof ActionError) return { error: error.message };
    console.error(
      "Server Action failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return { error: "The request could not be completed. Please try again." };
  }
}
