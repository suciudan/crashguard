"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Users,
  UserPlus,
  Link2,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import type { Project } from "@/lib/types";
import { AppLink, useAppNavigation } from "./navigation";
import {
  browserSupportsWebAuthn,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  acceptInvitation,
  getProjectAccess,
  inviteToProject,
  removeProjectMember,
  revokeInvitation,
} from "@/app/actions/invitations";
import { registrationOptions, registerPasskey } from "@/app/actions/passkeys";
import { action } from "./shared";
import Logo from "./logo";

export function Invitation({
  token,
  project,
  accountName,
}: {
  token: string;
  project: string;
  accountName?: string;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="auth-shell">
      <section className="auth-card">
        <Logo className="auth-logo" />
        <h1>Join {project}</h1>
        <p>
          {accountName
            ? `Accept this invitation as ${accountName}.`
            : "Choose your account name and create a passkey to join this project."}
        </p>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              let projectId: number | undefined;
              if (accountName)
                projectId = (await action(acceptInvitation(token))).project;
              else {
                if (!window.isSecureContext || !browserSupportsWebAuthn())
                  throw new Error(
                    "Use a browser that supports passkeys, on HTTPS or localhost.",
                  );
                const optionsJSON = await action(
                  registrationOptions({ invitation: token, accountName: name }),
                );
                const credential = await startRegistration({ optionsJSON });
                projectId = (
                  await action(registerPasskey(credential, "My passkey"))
                ).project;
              }
              window.location.assign(`/?view=issues&project=${projectId}`);
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : "Could not accept this invitation.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {!accountName && (
            <>
              <label className="field-label" htmlFor="account-name">
                Account name
              </label>
              <input
                id="account-name"
                className="text-input"
                autoComplete="name"
                maxLength={60}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Alex Morgan"
              />
            </>
          )}
          <button className="button primary" disabled={busy}>
            {busy
              ? "Joining…"
              : accountName
                ? "Accept invitation"
                : "Create passkey and join"}
          </button>
        </form>
        {!accountName && (
          <p>
            Already have an account?{" "}
            <a href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
              Sign in to accept
            </a>
            .
          </p>
        )}
      </section>
    </div>
  );
}

type Access = {
  members: { id: number; name: string; created_at: number }[];
  invitations: {
    id: number;
    created_at: number;
    expires_at: number;
    accepted_at: number | null;
    revoked_at: number | null;
  }[];
};
export function MembersWorkspace({
  projects,
  projectId,
  onCountChange,
}: {
  projects: Project[];
  projectId: number | null;
  onCountChange: (count: number | null) => void;
}) {
  const { params, href, update } = useAppNavigation();
  const project = projects.find((entry) => entry.id === projectId);
  const memberId = params.get("member");
  const invitationId = params.get("invitation");
  const activeTab = invitationId
    ? "invitations"
    : memberId
      ? "members"
      : params.get("membersTab") === "invitations"
        ? "invitations"
        : "members";
  const creating = invitationId === "new";
  const selected = Boolean(memberId || invitationId);
  const [access, setAccess] = useState<Access | null>(null);
  const [link, setLink] = useState<{ id: number; url: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const mounted = useRef(false);
  const load = useCallback(async () => {
    if (!projectId || !project) return;
    const version = ++latest.current;
    try {
      const result = await action(getProjectAccess(projectId));
      if (version === latest.current) {
        setAccess(result);
        setError("");
      }
    } catch (e) {
      if (version === latest.current) setError((e as Error).message);
    }
  }, [projectId, project?.id]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      latest.current++;
    };
  }, [load]);
  useEffect(() => {
    onCountChange(project ? (access?.members.length ?? null) : 0);
  }, [access?.members.length, project?.id, onCountChange]);
  const member = access?.members.find((entry) => String(entry.id) === memberId);
  const invite = access?.invitations.find(
    (entry) => String(entry.id) === invitationId,
  );
  const invitationState = (entry: Access["invitations"][number]) =>
    entry.accepted_at
      ? "Accepted"
      : entry.revoked_at
        ? "Revoked"
        : entry.expires_at <= Date.now()
          ? "Expired"
          : "Pending";
  const state = invite ? invitationState(invite) : "";
  const selectionHref = (changes: Record<string, string | number | null>) =>
    href({
      view: "members",
      members: null,
      memberProject: projectId,
      membersTab: activeTab,
      member: null,
      invitation: null,
      ...changes,
    });
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
      if (mounted.current) await load();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className={`section-workspace members-workspace${selected ? " has-selection" : ""}`}
      aria-label="Members"
    >
      <section className="section-list-pane" aria-label="Members list">
        {projects.length > 0 && (
          <div className="filterbar">
            <select
              className="text-input"
              aria-label="Project"
              value={project?.id || ""}
              onChange={(e) =>
                update({
                  view: "members",
                  members: null,
                  memberProject: Number(e.target.value),
                  membersTab: activeTab,
                  member: null,
                  invitation: null,
                })
              }
            >
              {!project && (
                <option value="" disabled>
                  Select a project
                </option>
              )}
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <nav className="tabs members-tabs" aria-label="Member views">
          {(["members", "invitations"] as const).map((tab) => (
            <AppLink
              key={tab}
              className={activeTab === tab ? "selected" : ""}
              aria-current={activeTab === tab ? "page" : undefined}
              href={selectionHref({ membersTab: tab })}
            >
              {tab === "members" ? "Members" : "Invitations"}
              {access && <span>{access[tab].length}</span>}
            </AppLink>
          ))}
        </nav>
        {!selected && error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => void load()}>Retry</button>
          </div>
        )}
        {!project ? (
          <div className="members-empty">
            <Users size={28} />
            <p>
              {projects.length
                ? "Select a project to manage its members."
                : "Create a project to start inviting colleagues."}
            </p>
          </div>
        ) : !access && !error ? (
          <div className="loading" role="status">
            <Loader2 size={20} className="spin" />
            Loading members…
          </div>
        ) : (
          access && (
            <>
              {activeTab === "members" &&
                (access.members.length ? (
                  access.members.map((entry) => (
                    <AppLink
                      key={entry.id}
                      className={`section-list-row member-list-row${member?.id === entry.id ? " is-selected" : ""}`}
                      href={selectionHref({ member: entry.id })}
                      aria-label={entry.name}
                      aria-current={
                        member?.id === entry.id ? "true" : undefined
                      }
                    >
                      <span className="member-avatar" aria-hidden="true">
                        {entry.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="member-description">
                        <strong>{entry.name}</strong>
                        <span>
                          Joined{" "}
                          {new Date(entry.created_at).toLocaleDateString()}
                        </span>
                      </span>
                      <ChevronRight size={14} className="row-chevron" />
                    </AppLink>
                  ))
                ) : (
                  <div className="members-empty">
                    <Users size={24} />
                    <p>No colleagues have joined this project yet.</p>
                  </div>
                ))}
              {activeTab === "invitations" &&
                (access.invitations.length ? (
                  access.invitations.map((entry) => (
                    <AppLink
                      key={entry.id}
                      className={`section-list-row member-list-row invitation-list-row${invite?.id === entry.id ? " is-selected" : ""}`}
                      href={selectionHref({ invitation: entry.id })}
                      aria-current={
                        invite?.id === entry.id ? "true" : undefined
                      }
                    >
                      <span className="member-avatar" aria-hidden="true">
                        <Link2 size={17} />
                      </span>
                      <span className="member-description">
                        <strong>Invitation #{entry.id}</strong>
                        <span>
                          Created{" "}
                          {new Date(entry.created_at).toLocaleDateString()}
                        </span>
                      </span>
                      <span
                        className={`invitation-status ${invitationState(entry).toLowerCase()}`}
                      >
                        {invitationState(entry)}
                      </span>
                    </AppLink>
                  ))
                ) : (
                  <div className="members-empty">
                    <Link2 size={24} />
                    <p>No invitations created yet.</p>
                  </div>
                ))}
            </>
          )
        )}
      </section>
      <section className="section-detail-pane" aria-label="Member details">
        {selected ? (
          <>
            <div className="section-detail-header">
              <span>
                {creating ? (
                  <UserPlus size={16} />
                ) : memberId ? (
                  <Users size={16} />
                ) : (
                  <Link2 size={16} />
                )}
                {creating
                  ? "Invite a colleague"
                  : memberId
                    ? "Member details"
                    : "Invitation details"}
              </span>
              <AppLink className="button" href={selectionHref({})}>
                <ChevronLeft size={14} />
                {activeTab === "invitations"
                  ? "Back to invitations"
                  : "Back to members"}
              </AppLink>
            </div>
            <div className="section-detail-body member-detail">
              {error && (
                <div className="error-banner" role="alert">
                  {error}
                  <button onClick={() => void load()}>Retry</button>
                </div>
              )}
              {!project ? (
                <p>Select an available project from the list.</p>
              ) : creating ? (
                <>
                  <h2>Invite a colleague</h2>
                  <p>
                    Give a colleague access to {project.name}. Each link can be
                    used by one person and is valid for 7 days.
                  </p>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await action(
                          inviteToProject(project.id),
                        );
                        if (!mounted.current) return;
                        setLink({ id: result.id, url: result.url });
                        update({
                          view: "members",
                          members: null,
                          memberProject: project.id,
                          member: null,
                          invitation: result.id,
                        });
                      })
                    }
                  >
                    {busy ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <UserPlus size={16} />
                    )}
                    Create invitation link
                  </button>
                </>
              ) : (!access || (busy && !member && !invite)) && !error ? (
                <div className="loading" role="status">
                  <Loader2 size={20} className="spin" />
                  Loading details…
                </div>
              ) : member ? (
                <>
                  <span
                    className="member-avatar member-detail-avatar"
                    aria-hidden="true"
                  >
                    {member.name.slice(0, 1).toUpperCase()}
                  </span>
                  <h2>{member.name}</h2>
                  <p>Member of {project.name}</p>
                  <dl className="member-detail-metadata">
                    <div>
                      <dt>Project</dt>
                      <dd>{project.name}</dd>
                    </div>
                    <div>
                      <dt>Joined</dt>
                      <dd>{new Date(member.created_at).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Access</dt>
                      <dd>Project member</dd>
                    </div>
                  </dl>
                  <div className="member-access-action">
                    <h3>Project access</h3>
                    <p>
                      Removing access prevents this member from viewing this
                      project. Their other project memberships are unaffected.
                    </p>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await action(
                            removeProjectMember(project.id, member.id),
                          );
                          if (mounted.current)
                            update({ member: null, invitation: null });
                        })
                      }
                    >
                      Remove access
                    </button>
                  </div>
                </>
              ) : invite ? (
                <>
                  <h2>Invitation #{invite.id}</h2>
                  <span className={`invitation-status ${state.toLowerCase()}`}>
                    {state}
                  </span>
                  <dl className="member-detail-metadata">
                    <div>
                      <dt>Project</dt>
                      <dd>{project.name}</dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd>{new Date(invite.created_at).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>{new Date(invite.expires_at).toLocaleString()}</dd>
                    </div>
                    {invite.accepted_at && (
                      <div>
                        <dt>Accepted</dt>
                        <dd>{new Date(invite.accepted_at).toLocaleString()}</dd>
                      </div>
                    )}
                    {invite.revoked_at && (
                      <div>
                        <dt>Revoked</dt>
                        <dd>{new Date(invite.revoked_at).toLocaleString()}</dd>
                      </div>
                    )}
                  </dl>
                  {state === "Pending" && (
                    <>
                      {link?.id === invite.id ? (
                        <label className="field-label members-link">
                          Invitation link
                          <input
                            className="text-input"
                            readOnly
                            value={link.url}
                            onFocus={(e) => e.target.select()}
                          />
                          <span>Copy and share this link privately.</span>
                        </label>
                      ) : (
                        <p>
                          The invitation link is shown once when it is created.
                          Create a new invitation if you need another link.
                        </p>
                      )}
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await action(
                              revokeInvitation(project.id, invite.id),
                            );
                            if (link?.id === invite.id) setLink(null);
                          })
                        }
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </>
              ) : (
                !error && (
                  <>
                    <h2>
                      {memberId ? "Member not found" : "Invitation not found"}
                    </h2>
                    <p>
                      This item is no longer available in {project.name}. Choose
                      another item from the list.
                    </p>
                  </>
                )
              )}
            </div>
          </>
        ) : (
          <div className="section-detail-empty">
            {activeTab === "invitations" ? (
              <Link2 size={30} />
            ) : (
              <Users size={30} />
            )}
            <h2>
              {activeTab === "invitations"
                ? "Select an invitation"
                : "Select a member"}
            </h2>
            <p>
              {activeTab === "invitations"
                ? "Choose an invitation to view its status and manage access."
                : "Choose a member to manage their access to your project."}
            </p>
            {project && (
              <AppLink
                className="button primary"
                href={selectionHref({ invitation: "new" })}
              >
                <UserPlus size={16} />
                Invite a colleague
              </AppLink>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
