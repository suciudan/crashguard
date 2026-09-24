import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Login } from "@/components/passkeys";
import { authOrigin, hasPasskeys, session } from "@/lib/auth";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  let destination = "/";
  try {
    const origin = authOrigin().origin;
    const url = new URL(
      typeof params.next === "string" ? params.next : "/",
      origin,
    );
    if (
      url.origin === origin &&
      (url.pathname === "/" ||
        url.pathname === "/settings/security" ||
        /^\/invite\/[a-f0-9]{64}$/.test(url.pathname))
    )
      destination = url.pathname + url.search;
  } catch {
    /* Invalid redirect targets return to the dashboard. */
  }
  if (session({ cookies: await cookies() })) redirect(destination);
  return (
    <Login initiallyConfigured={hasPasskeys()} destination={destination} />
  );
}
