import { NextRequest, NextResponse } from "next/server";
import { authOrigin, session } from "./lib/auth";

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (/^\/api\/\d+\/envelope\/?$/.test(path)) {
    // Prevent Next.js from automatically serving preflight for this route.
    return request.method === "POST"
      ? NextResponse.next()
      : new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (path === "/api/health") return NextResponse.next();
  // MCP authenticates each request with its own revocable bearer token.
  if (path === "/api/mcp") return NextResponse.next();
  const isAction =
    request.method === "POST" && request.headers.has("next-action");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && origin !== authOrigin().origin) ||
      !origin
    )
      return NextResponse.json(
        { error: "Cross-origin dashboard writes are not allowed" },
        { status: 403 },
      );
  }
  // Action handlers enforce their own authorization and accept Next's action encoding.
  if (/^\/invite\/[a-f0-9]{64}$/.test(path)) {
    const response = NextResponse.next();
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  if (path === "/login" || isAction) return NextResponse.next();
  if (!session(request)) {
    if (path.startsWith("/api/"))
      return NextResponse.json(
        { error: "Sign in with your passkey to continue." },
        { status: 401 },
      );
    const login = new URL("/login", request.url);
    login.searchParams.set("next", path + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
