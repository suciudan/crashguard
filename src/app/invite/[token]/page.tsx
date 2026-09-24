import { cookies } from "next/headers";
import { Invitation } from "@/components/invitations";
import { session } from "@/lib/auth";
import { findInvitation } from "@/lib/invitations";
import Logo from "@/components/logo";

export const metadata = {
  title: "Project invitation · CrashGuard",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const current = session({ cookies: await cookies() });
  let invitation;
  try {
    invitation = findInvitation(token);
  } catch {
    return (
      <div className="auth-shell">
        <section className="auth-card">
          <Logo className="auth-logo" />
          <h1>Invitation unavailable</h1>
          <p>
            This link is invalid, expired, revoked, or has already been used.
            Ask the project owner for a new invitation.
          </p>
          <a className="button" href="/">
            Go to CrashGuard
          </a>
        </section>
      </div>
    );
  }
  return (
    <Invitation
      token={token}
      project={invitation.project_name}
      accountName={current?.account_name}
    />
  );
}
