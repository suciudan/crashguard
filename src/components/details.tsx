"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock3,
  Copy,
  Layers3,
  Loader2,
  Plus,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import type { Frame, Issue, Project, StoredEvent } from "@/lib/types";
import { action, Platform, relative } from "./shared";
import {
  addProject,
  getDashboard,
  getIssue,
  updateIssueStatus,
} from "@/app/actions/dashboard";
import { findRelatedReplay } from "@/app/actions/telemetry";
import { AppLink, useAppNavigation } from "./navigation";
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input, select, textarea, summary, [tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return ref;
}
export function ProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("javascript");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const stableClose = useCallback(() => closeRef.current(), []);
  const ref = useDialog(stableClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>
        <div className="modal-symbol">
          <Box size={24} />
        </div>
        <h2 id="project-title">Give your app a home.</h2>
        <p>Create a project, connect your SDK, and let us catch the rest.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              onCreated(await action(addProject({ name, platform })));
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          <label className="field-label" htmlFor="project-name">
            Project name
          </label>
          <input
            id="project-name"
            className="text-input"
            placeholder="e.g. storefront-web"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
          <label className="field-label">Platform</label>
          <div className="platform-picker">
            {[
              ["javascript", "JavaScript"],
              ["node", "Node.js"],
              ["python", "Python"],
              ["php", "PHP"],
              ["other", "Other"],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={platform === value}
                className={platform === value ? "selected" : ""}
                onClick={() => setPlatform(value)}
              >
                <Platform platform={value} />
                <span>{label}</span>
                {platform === value && <Check size={12} />}
              </button>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={busy || !name.trim()}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Plus size={16} />
              )}
              Create project
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
function CodeBlock({
  code,
  notify,
}: {
  code: string;
  notify: (s: string) => void;
}) {
  return (
    <div className="code-block">
      <button
        aria-label="Copy code"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            notify("Copied to clipboard");
          } catch {
            notify("Clipboard unavailable. Select and copy the code.");
          }
        }}
      >
        <Copy size={15} />
      </button>
      <pre>{code}</pre>
    </div>
  );
}
export function Setup({
  project,
  projects,
  onSelect,
  notify,
  onReceived,
}: {
  project: Project;
  projects: Project[];
  onSelect: (id: number) => void;
  notify: (s: string) => void;
  onReceived: () => void;
}) {
  const { params, href } = useAppNavigation();
  const platform = ["javascript", "node", "python", "php"].includes(
    params.get("sdk") || "",
  )
    ? params.get("sdk")!
    : project.platform;
  const [origin, setOrigin] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const dsn = origin
    ? `${origin.replace("://", `://${project.public_key}@`).replace(/\/$/, "")}/${project.id}`
    : "";
  const pkg = platform === "node" ? "@sentry/node" : "@sentry/browser";
  const install =
    platform === "python"
      ? "pip install sentry-sdk"
      : platform === "php"
        ? "composer require sentry/sdk"
        : `npm install ${pkg}`;
  const snippet =
    platform === "python"
      ? `import sentry_sdk\n\nsentry_sdk.init(\n    dsn="${dsn}",\n    environment="production",\n    send_default_pii=False,\n    traces_sample_rate=0.1,\n    enable_logs=True,\n)`
      : platform === "php"
        ? `\\Sentry\\init([\n    'dsn' => '${dsn}',\n    'environment' => 'production',\n    'send_default_pii' => false,\n    'traces_sample_rate' => 0.1,\n]);`
        : `import * as Sentry from "${pkg}";\n\nSentry.init({\n  dsn: "${dsn}",\n  environment: "production",\n  sendDefaultPii: false,\n  tracesSampleRate: 0.1,\n  enableLogs: true,\n});`;
  return (
    <div className="setup-layout">
      <section className="setup-main">
        <label className="setup-project">
          PROJECT
          <select
            value={project.id}
            onChange={(e) => onSelect(Number(e.target.value))}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="sdk-tabs">
          {[
            ["javascript", "JavaScript"],
            ["node", "Node.js"],
            ["python", "Python"],
            ["php", "PHP"],
          ].map(([key, label]) => (
            <AppLink
              key={key}
              className={platform === key ? "active" : ""}
              href={href({ sdk: key, project: project.id })}
            >
              {label}
            </AppLink>
          ))}
        </div>
        <div className="setup-step">
          <span className="step-number">01</span>
          <div>
            <h2>Install the Sentry SDK</h2>
            <p>Use the official SDK and its built-in error integrations.</p>
            <CodeBlock code={install} notify={notify} />
          </div>
        </div>
        <div className="setup-step">
          <span className="step-number">02</span>
          <div>
            <h2>Point it at CrashGuard</h2>
            <p>
              Initialize as early as possible in your application’s entry point.
              {platform === "node" &&
                " Load this before importing other application modules."}
            </p>
            <CodeBlock code={snippet} notify={notify} />
          </div>
        </div>
        <div className="setup-step">
          <span className="step-number">03</span>
          <div>
            <h2>Make some (controlled) noise</h2>
            <p>
              Send an exception from your application to check the connection.
            </p>
            <CodeBlock
              code={
                platform === "python"
                  ? 'sentry_sdk.capture_message("Hello from CrashGuard!")\nsentry_sdk.flush()'
                  : platform === "php"
                    ? "\\Sentry\\captureMessage('Hello from CrashGuard!');"
                    : 'Sentry.captureException(new Error("Hello from CrashGuard!"));'
              }
              notify={notify}
            />
            <button
              className="button primary test-button"
              disabled={sending || !dsn}
              onClick={async () => {
                setSending(true);
                try {
                  const Sentry = await import("@sentry/browser");
                  const client = new Sentry.BrowserClient({
                    dsn,
                    transport: Sentry.makeFetchTransport,
                    stackParser: Sentry.defaultStackParser,
                    integrations: [],
                    environment: "test",
                    release: "crashguard-connection-test",
                  });
                  const id = client.captureException(
                    new Error("Hello from CrashGuard!"),
                  );
                  const flushed = await client.flush(5000);
                  await client.close();
                  if (!flushed || !id)
                    throw new Error(
                      "Event could not be sent. Check the DSN and server connection.",
                    );
                  const result = await action(
                    getDashboard({
                      project: String(project.id),
                      environment: "test",
                      status: "all",
                    }),
                  );
                  let confirmed = false;
                  for (const issue of result.issues) {
                    const detail = await action(getIssue(issue.id));
                    if (detail.events.some((e) => e.event_id === id)) {
                      confirmed = true;
                      break;
                    }
                  }
                  if (!confirmed)
                    throw new Error(
                      "Event delivery was not confirmed. Check your public URL and server logs.",
                    );
                  notify(
                    "Test event received. Find it in Issues → test environment.",
                  );
                  onReceived();
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setSending(false);
                }
              }}
            >
              {sending ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Zap size={16} />
              )}
              Send a test from this browser
            </button>
          </div>
        </div>
        <details className="telemetry-card operation-form">
          <summary>Additional tools</summary>
          <div className="page-actions">
            {[
              ["releases", "Releases"],
              ["sourcemaps", "Source maps"],
              ["alerts", "Alerts"],
            ].map(([view, title]) => (
              <AppLink
                key={view}
                className="button"
                href={href({
                  view,
                  project: project.id,
                  issue: null,
                  event: null,
                  tab: null,
                  record: null,
                  offset: null,
                  q: null,
                })}
              >
                {title}
              </AppLink>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}
export function IssuePanel({
  id,
  onClose,
  onChanged,
  notify,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
  notify: (s: string) => void;
}) {
  const [detail, setDetail] = useState<{
    issue: Issue;
    events: StoredEvent[];
  } | null>(null);
  const [error, setError] = useState("");
  const { params, href, update } = useAppNavigation();
  const tab = ["stack", "breadcrumbs", "context", "raw"].includes(
    params.get("tab") || "",
  )
    ? params.get("tab")!
    : "stack";
  const eventId = params.get("event");
  const [saving, setSaving] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const stableClose = useCallback(() => closeRef.current(), []);
  const ref = useDialog(stableClose);
  useEffect(() => {
    let cancelled = false;
    setError("");
    setDetail(null);
    action(getIssue(id, eventId))
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, eventId]);
  const event = eventId
    ? detail?.events.find((e) => e.event_id === eventId)
    : detail?.events[0];
  const payload = event?.payload;
  const exceptions = payload?.exception?.values ?? [];
  const crumbs = Array.isArray(payload?.breadcrumbs)
    ? payload.breadcrumbs
    : (payload?.breadcrumbs?.values ?? []);
  async function changeStatus(status: string) {
    setSaving(true);
    try {
      await action(updateIssueStatus(id, status));
      setDetail((d) =>
        d
          ? { ...d, issue: { ...d.issue, status: status as Issue["status"] } }
          : d,
      );
      onChanged();
      notify(`Issue ${status === "unresolved" ? "reopened" : status}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="panel-backdrop" onClick={onClose}>
      <div
        className="issue-panel"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-panel-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-top">
          <span>
            <Layers3 size={16} />
            Issue details <ChevronRight size={13} />
            <span>CG-{id}</span>
          </span>
          <button
            aria-label="Close issue"
            className="icon-button"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        {!detail && !error ? (
          <div className="loading">
            <Loader2 className="spin" />
            Loading event…
          </div>
        ) : detail ? (
          <>
            <div className="panel-heading">
              <div className="panel-project">
                <Platform platform={detail.issue.platform} small />
                {detail.issue.project_name}
                <span className={`status-pill ${detail.issue.status}`}>
                  {detail.issue.status}
                </span>
              </div>
              <h2 id="issue-panel-title">{detail.issue.title}</h2>
              <p>{detail.issue.culprit}</p>
              <div className="panel-actions">
                <button
                  disabled={saving}
                  className="button primary"
                  onClick={() =>
                    changeStatus(
                      detail.issue.status === "resolved"
                        ? "unresolved"
                        : "resolved",
                    )
                  }
                >
                  <CheckCheck size={16} />
                  {detail.issue.status === "resolved"
                    ? "Reopen issue"
                    : "Mark resolved"}
                </button>
                <button
                  disabled={saving}
                  className="button"
                  onClick={() =>
                    changeStatus(
                      detail.issue.status === "ignored"
                        ? "unresolved"
                        : "ignored",
                    )
                  }
                >
                  {detail.issue.status === "ignored"
                    ? "Stop ignoring"
                    : "Ignore issue"}
                </button>
              </div>
            </div>
            <div className="detail-stats">
              <div>
                <span>Events</span>
                <strong>{detail.issue.event_count}</strong>
              </div>
              <div>
                <span>Users</span>
                <strong>{detail.issue.user_count || "—"}</strong>
              </div>
              <div>
                <span>First seen</span>
                <strong>{relative(detail.issue.first_seen)}</strong>
              </div>
              <div>
                <span>Last seen</span>
                <strong>{relative(detail.issue.last_seen)}</strong>
              </div>
            </div>
            <div className="event-selector">
              <span>
                <Clock3 size={14} />
                Occurrence
              </span>
              <select
                aria-label="Event occurrence"
                value={event?.event_id || ""}
                onChange={(e) => update({ event: e.target.value })}
              >
                {!event && (
                  <option value="" disabled>
                    Occurrence not found
                  </option>
                )}
                {detail.events.map((e) => (
                  <option value={e.event_id} key={e.id}>
                    {new Date(e.received_at).toLocaleString()} ·{" "}
                    {e.event_id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>
            {detail.issue.event_count > 50 && (
              <p className="occurrence-note">
                Showing the latest 50 occurrences and any linked older
                occurrence.
              </p>
            )}
            {eventId && !event && (
              <div className="error-banner" role="alert">
                This occurrence was not found in this issue. Choose another
                occurrence above.
              </div>
            )}
            <div className="event-tags">
              <span>{event?.environment}</span>
              {event?.release && <span>{event.release}</span>}
              <span>{payload?.platform || "unknown platform"}</span>
              {Object.entries(
                Array.isArray(payload?.tags)
                  ? Object.fromEntries(payload.tags)
                  : payload?.tags || {},
              ).map(([k, v]) => (
                <span key={k}>
                  {k}: {String(v)}
                </span>
              ))}
            </div>
            <div className="telemetry-links" style={{ padding: "0 28px" }}>
              {typeof (payload?.contexts?.replay as { replay_id?: unknown })
                ?.replay_id === "string" && (
                <button
                  className="button"
                  onClick={async () => {
                    try {
                      const record = await action(
                        findRelatedReplay(
                          detail.issue.project_id,
                          String(
                            (payload?.contexts?.replay as { replay_id: string })
                              .replay_id,
                          ),
                        ),
                      );
                      update({
                        view: "replays",
                        record,
                        issue: null,
                        event: null,
                      });
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  Replay
                </button>
              )}
              <AppLink
                className="button"
                href={href({
                  view: "attachments",
                  project: detail.issue.project_id,
                  relatedEvent: event?.event_id || eventId,
                  record: null,
                  issue: null,
                  event: null,
                  offset: null,
                  q: null,
                })}
              >
                Attachments
              </AppLink>
              {typeof (payload?.contexts?.trace as { trace_id?: unknown })
                ?.trace_id === "string" && (
                <AppLink
                  className="button"
                  href={href({
                    view: "transactions",
                    project: detail.issue.project_id,
                    trace: String(
                      (payload?.contexts?.trace as { trace_id: string })
                        .trace_id,
                    ),
                    record: null,
                    issue: null,
                    event: null,
                    offset: null,
                    q: null,
                  })}
                >
                  Trace
                </AppLink>
              )}
            </div>
            <div className="panel-tabs tabs">
              {[
                ["stack", "Stack trace"],
                ["breadcrumbs", `Breadcrumbs (${crumbs.length})`],
                ["context", "Context"],
                ["raw", "Raw event"],
              ].map(([key, text]) => (
                <AppLink
                  key={key}
                  className={tab === key ? "selected" : ""}
                  href={href({ tab: key, event: event?.event_id || eventId })}
                >
                  {text}
                </AppLink>
              ))}
            </div>
            <div className="panel-content">
              {tab === "stack" && (
                <>
                  {exceptions.length ? (
                    exceptions.map((exception, i) => (
                      <div key={i}>
                        <div className="exception-title">
                          <CircleAlert size={17} />
                          <strong>{exception.type}</strong>
                          <span>{exception.value}</span>
                        </div>
                        <Frames frames={exception.stacktrace?.frames || []} />
                      </div>
                    ))
                  ) : (
                    <Frames frames={payload?.stacktrace?.frames || []} />
                  )}
                </>
              )}
              {tab === "breadcrumbs" &&
                (crumbs.length ? (
                  <div className="breadcrumbs-list">
                    {crumbs.map((crumb, i) => (
                      <div key={i}>
                        <span className="crumb-icon">
                          <Circle size={10} />
                        </span>
                        <div>
                          <strong>{crumb.category || "default"}</strong>
                          <p>{crumb.message || JSON.stringify(crumb.data)}</p>
                          {crumb.data && crumb.message && (
                            <pre>{JSON.stringify(crumb.data, null, 2)}</pre>
                          )}
                        </div>
                        <span className="crumb-level">
                          {crumb.level || "info"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="detail-empty">
                    No breadcrumbs were sent with this event.
                  </div>
                ))}
              {tab === "context" && (
                <>
                  {Object.entries({
                    User: payload?.user,
                    Request: payload?.request,
                    Contexts: payload?.contexts,
                    SDK: payload?.sdk,
                  }).map(
                    ([name, value]) =>
                      Boolean(value) && (
                        <section className="context-section" key={name}>
                          <h3>{name}</h3>
                          <pre>{JSON.stringify(value, null, 2)}</pre>
                        </section>
                      ),
                  )}
                </>
              )}
              {tab === "raw" && (
                <CodeBlock
                  code={JSON.stringify(payload, null, 2)}
                  notify={notify}
                />
              )}
            </div>
            <div className="panel-footer">
              <ShieldCheck size={14} />
              Resolved issues reopen automatically if a new event arrives.
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
function Frames({ frames }: { frames: Frame[] }) {
  return frames.length ? (
    <div className="frames">
      {[...frames].reverse().map((frame, i) => (
        <details key={i} open={i === 0}>
          <summary>
            <span className="frame-index">{frames.length - i}</span>
            <div>
              <strong>{frame.function || "<anonymous>"}</strong>
              <span>
                {frame.filename || frame.abs_path || "unknown file"}
                {frame.lineno
                  ? `:${frame.lineno}${frame.colno ? `:${frame.colno}` : ""}`
                  : ""}
              </span>
            </div>
            {frame.in_app && <span className="in-app">in app</span>}
            <ChevronDown size={13} />
          </summary>
          {frame.context_line ? (
            <div className="source-code">
              {[
                ...(frame.pre_context || []),
                frame.context_line,
                ...(frame.post_context || []),
              ].map((line, j) => (
                <div
                  key={j}
                  className={
                    j === (frame.pre_context?.length || 0) ? "highlight" : ""
                  }
                >
                  <span>
                    {(frame.lineno || 0) - (frame.pre_context?.length || 0) + j}
                  </span>
                  <code>{line}</code>
                </div>
              ))}
            </div>
          ) : (
            <div className="source-missing">
              Source context was not included by the SDK.
            </div>
          )}
        </details>
      ))}
    </div>
  ) : (
    <div className="detail-empty">
      This event doesn’t include a stack trace.
    </div>
  );
}
