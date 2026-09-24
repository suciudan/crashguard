"use client";
import { useEffect, useState, type FormEvent } from "react";
import { action } from "./shared";
import { AppLink, useAppNavigation } from "./navigation";
import {
  addAlert,
  addSourceMap,
  deleteSourceMap,
  getAlerts,
  getReleases,
  getSourceMaps,
  saveRelease,
  setAlertEnabled,
  retryJob,
} from "@/app/actions/telemetry";
import type { Project } from "@/lib/types";
type Releases = NonNullable<Awaited<ReturnType<typeof getReleases>>["data"]>;
type Maps = NonNullable<Awaited<ReturnType<typeof getSourceMaps>>["data"]>;
type Alerts = NonNullable<Awaited<ReturnType<typeof getAlerts>>["data"]>;
export function Operations({
  view,
  projects,
  onCountChange,
}: {
  view: string;
  projects: Project[];
  onCountChange?: (count: number | null) => void;
}) {
  const { params, update, href } = useAppNavigation();
  const project = Number(params.get("project")) || undefined;
  const [releases, setReleases] = useState<Releases>([]),
    [maps, setMaps] = useState<Maps>([]),
    [alerts, setAlerts] = useState<Alerts>({ rules: [], deliveries: [] });
  const [releasesLoading, setReleasesLoading] = useState(true);
  const [loadedReleasesProject, setLoadedReleasesProject] = useState<
    number | undefined | null
  >(null);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    if (view === "releases") setReleasesLoading(true);
    void (async () => {
      try {
        if (view === "releases") {
          const result = await action(getReleases(project));
          if (active) setReleases(result);
        }
        if (view === "sourcemaps") {
          const result = await action(getSourceMaps(project));
          if (active) setMaps(result);
        }
        if (view === "alerts") {
          const result = await action(getAlerts());
          if (active) setAlerts(result);
        }
        if (active) setError("");
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          if (view === "releases") setReleases([]);
        }
      } finally {
        if (active && view === "releases") {
          setLoadedReleasesProject(project);
          setReleasesLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [view, project, refresh]);
  useEffect(() => {
    if (view === "releases")
      onCountChange?.(
        releasesLoading || loadedReleasesProject !== project
          ? null
          : releases.length,
      );
  }, [
    view,
    releasesLoading,
    loadedReleasesProject,
    project,
    releases.length,
    onCountChange,
  ]);
  const run = async (work: () => Promise<unknown>, success = "Saved.") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      if (success) setMessage(success);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const projectField = (
    <label>
      Project
      <select
        className="text-input"
        name="project"
        defaultValue={project || projects[0]?.id}
        required
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
  const formData = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return new FormData(e.currentTarget);
  };
  const str = (f: FormData, key: string) => String(f.get(key) || "");
  if (view === "releases") {
    return (
      <ReleaseWorkspace
        projects={projects}
        releases={loadedReleasesProject === project ? releases : []}
        loading={releasesLoading || loadedReleasesProject !== project}
        busy={busy}
        error={error}
        message={message}
        run={run}
        onReleasesChange={setReleases}
      />
    );
  }
  return (
    <div className="operations">
      {view !== "alerts" && (
        <div className="filterbar">
          <select
            className="text-input"
            aria-label="Filter project"
            value={project || ""}
            onChange={(e) => update({ project: e.target.value })}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="operation-message" role="status">
          {message}
        </p>
      )}
      {!projects.length ? (
        <p>Create a project to get started.</p>
      ) : (
        <>
          {view === "sourcemaps" && (
            <>
              <section className="telemetry-card operation-form">
                <h2>Upload source map</h2>
                <p>
                  Match a debug ID, or specify the release and the exact
                  generated file URL from the stack trace. Embedded source
                  content supplies code context.
                </p>
                <form
                  onSubmit={(e) => {
                    const f = formData(e);
                    void run(
                      () => action(addSourceMap(f)),
                      "Source map uploaded. Existing and new stack traces use it when opened.",
                    );
                  }}
                >
                  {projectField}
                  <label>
                    Source map file
                    <input
                      className="text-input"
                      type="file"
                      name="file"
                      accept=".map,.json"
                      required
                    />
                  </label>
                  <label>
                    Debug ID
                    <input
                      className="text-input"
                      name="debugId"
                      placeholder="Read from the map when embedded"
                    />
                  </label>
                  <label>
                    Release
                    <input
                      className="text-input"
                      name="release"
                      defaultValue={params.get("release") || ""}
                      maxLength={300}
                    />
                  </label>
                  <label>
                    Generated file URL
                    <input
                      className="text-input"
                      name="filename"
                      placeholder="https://example.com/assets/app.js"
                    />
                  </label>
                  <button className="button primary" disabled={busy}>
                    Upload
                  </button>
                </form>
              </section>
              <section className="telemetry-card">
                <div className="telemetry-table-wrap">
                  <table className="telemetry-table">
                    <thead>
                      <tr>
                        <th>File / Debug ID</th>
                        <th>Release</th>
                        <th>Project</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {maps.map((m) => (
                        <tr key={m.id}>
                          <td>
                            {m.filename || "Debug ID mapping"}
                            <small>{m.debug_id}</small>
                          </td>
                          <td>{m.release || "—"}</td>
                          <td>
                            {projects.find((p) => p.id === m.project_id)?.name}
                          </td>
                          <td>
                            <button
                              className="button"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () => action(deleteSourceMap(m.id)),
                                  "Source map removed.",
                                )
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
          {view === "alerts" && (
            <>
              <details
                className="telemetry-card operation-form"
                open={!alerts.rules.length}
              >
                <summary>Create webhook alert</summary>
                <form
                  onSubmit={(e) => {
                    const f = formData(e);
                    void run(async () => {
                      const result = await action(
                        addAlert({
                          project: Number(f.get("project")),
                          name: str(f, "name"),
                          url: str(f, "url"),
                          level: str(f, "level"),
                        }),
                      );
                      setMessage(`Save this signing secret: ${result.secret}`);
                    }, "");
                  }}
                >
                  {projectField}
                  <label>
                    Name
                    <input
                      className="text-input"
                      name="name"
                      maxLength={100}
                      required
                    />
                  </label>
                  <label>
                    Webhook URL
                    <input
                      className="text-input"
                      type="url"
                      name="url"
                      required
                    />
                  </label>
                  <label>
                    Minimum severity
                    <select
                      className="text-input"
                      name="level"
                      defaultValue="error"
                    >
                      <option value="warning">Warning</option>
                      <option value="error">Error</option>
                      <option value="fatal">Fatal</option>
                    </select>
                  </label>
                  <p>
                    Each matching error occurrence queues a signed webhook.
                    Failed deliveries retry up to eight times.
                  </p>
                  <button className="button primary" disabled={busy}>
                    Create alert
                  </button>
                </form>
              </details>
              <section className="telemetry-card">
                <div className="telemetry-table-wrap">
                  <table className="telemetry-table">
                    <thead>
                      <tr>
                        <th>Alert</th>
                        <th>Project</th>
                        <th>Minimum level</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.rules.map((r) => (
                        <tr key={r.id}>
                          <td>
                            {r.name}
                            <small>{r.url}</small>
                          </td>
                          <td>
                            {projects.find((p) => p.id === r.project_id)?.name}
                          </td>
                          <td>{r.minimum_level}</td>
                          <td>
                            <button
                              className="button"
                              disabled={busy}
                              onClick={() =>
                                void run(() =>
                                  action(setAlertEnabled(r.id, !r.enabled)),
                                )
                              }
                            >
                              {r.enabled ? "Disable" : "Enable"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="telemetry-card telemetry-detail">
                <div className="section-title">
                  <h2>Delivery history</h2>
                  <button
                    className="button"
                    onClick={() => setRefresh((n) => n + 1)}
                  >
                    Refresh
                  </button>
                </div>
                <div className="telemetry-table-wrap">
                  <table className="telemetry-table">
                    <thead>
                      <tr>
                        <th>Issue</th>
                        <th>Status</th>
                        <th>Attempts</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.deliveries.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <AppLink
                              href={href({ view: "issues", issue: d.issue })}
                            >
                              Issue #{d.issue}
                            </AppLink>
                          </td>
                          <td>{d.status}</td>
                          <td>{d.attempts}</td>
                          <td>
                            {d.error || new Date(d.created_at).toLocaleString()}
                            {d.status === "failed" && (
                              <button
                                className="button"
                                disabled={busy}
                                onClick={() =>
                                  void run(
                                    () => action(retryJob(d.id)),
                                    "Retry queued.",
                                  )
                                }
                              >
                                Retry
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ReleaseWorkspace({
  projects,
  releases,
  loading,
  busy,
  error,
  message,
  run,
  onReleasesChange,
}: {
  projects: Project[];
  releases: Releases;
  loading: boolean;
  busy: boolean;
  error: string;
  message: string;
  run: (work: () => Promise<unknown>, success?: string) => Promise<void>;
  onReleasesChange: (releases: Releases) => void;
}) {
  const { params, update, href } = useAppNavigation();
  const project = Number(params.get("project")) || undefined;
  const releaseId = params.get("releaseId");
  const creating = releaseId === "new";
  const selected = releases.find((release) => String(release.id) === releaseId);
  const hasSelection = Boolean(releaseId);
  const close = () => update({ releaseId: null });
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const releaseProject = selected?.project_id || Number(form.get("project"));
    const version = selected?.version || String(form.get("version") || "");
    void run(async () => {
      await action(
        saveRelease({
          project: releaseProject,
          version,
          notes: String(form.get("notes") || ""),
          url: String(form.get("url") || ""),
          finalized: form.has("finalized"),
        }),
      );
      const nextProject =
        project && project !== releaseProject ? releaseProject : project;
      const updated = await action(getReleases(nextProject));
      onReleasesChange(updated);
      const saved = updated.find(
        (release) =>
          release.project_id === releaseProject &&
          release.version === version.trim(),
      );
      if (saved) update({ releaseId: saved.id, project: nextProject || null });
    }, "Release saved.");
  };
  return (
    <div className={`section-workspace${hasSelection ? " has-selection" : ""}`}>
      <section className="section-list-pane" aria-label="Releases list">
        <div className="filterbar">
          <select
            className="text-input"
            aria-label="Filter project"
            value={project || ""}
            onChange={(event) =>
              update({ project: event.target.value, releaseId: null })
            }
          >
            <option value="">All projects</option>
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        {!hasSelection && error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="section-list-content" aria-busy={loading}>
          {releases.map((release) => (
            <AppLink
              key={release.id}
              className={`section-list-row release-list-row${selected?.id === release.id ? " is-selected" : ""}`}
              href={href({ releaseId: release.id })}
              aria-current={selected?.id === release.id ? "true" : undefined}
            >
              <div className="section-row-title">
                <strong>{release.version}</strong>
                <span className="status-pill">
                  {release.finalized_at ? "Released" : "Draft"}
                </span>
              </div>
              <p>{release.project_name}</p>
              <div className="section-row-meta">
                <span>{release.events.toLocaleString()} events</span>
                <span>{release.maps.toLocaleString()} source maps</span>
              </div>
            </AppLink>
          ))}
          {loading && !releases.length && (
            <p className="section-list-empty" role="status">
              Loading releases…
            </p>
          )}
          {!loading && !releases.length && (
            <div className="section-list-empty">
              <h2>{projects.length ? "No releases yet" : "No projects yet"}</h2>
              <p>
                {projects.length
                  ? "Create a release, or send an event with a release version to get started."
                  : "Create a project to start tracking releases."}
              </p>
            </div>
          )}
        </div>
      </section>
      <section
        className="section-detail-pane"
        aria-labelledby="release-detail-heading"
        aria-busy={!creating && loading}
      >
        {hasSelection ? (
          <>
            <header className="section-detail-header">
              <div>
                <h2 id="release-detail-heading">
                  {creating
                    ? "New release"
                    : selected?.version ||
                      (loading ? "Loading release…" : "Release unavailable")}
                </h2>
                {selected && <p>{selected.project_name}</p>}
              </div>
              <button
                className="button"
                onClick={close}
                aria-label="Close release details"
              >
                Back to releases
              </button>
            </header>
            <div className="section-detail-body operations">
              {error && (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              )}
              {message && (
                <p className="operation-message" role="status">
                  {message}
                </p>
              )}
              {!creating && !selected && loading ? (
                <p role="status">Loading release details…</p>
              ) : !creating && !selected ? (
                <p>Select a release from the list to view its details.</p>
              ) : !projects.length ? (
                <p>Create a project to get started.</p>
              ) : (
                <>
                  {selected && (
                    <section className="telemetry-card telemetry-detail release-summary">
                      <h3>Release overview</h3>
                      <dl className="release-metadata">
                        <div>
                          <dt>Status</dt>
                          <dd>
                            {selected.finalized_at ? "Released" : "Draft"}
                          </dd>
                        </div>
                        <div>
                          <dt>Created</dt>
                          <dd>
                            {new Date(selected.created_at).toLocaleString()}
                          </dd>
                        </div>
                        {selected.finalized_at && (
                          <div>
                            <dt>Released</dt>
                            <dd>
                              {new Date(selected.finalized_at).toLocaleString()}
                            </dd>
                          </div>
                        )}
                      </dl>
                      <div className="section-title">
                        <AppLink
                          className="button"
                          href={href({
                            view: "issues",
                            project: selected.project_id,
                            release: selected.version,
                            status: "all",
                            issue: null,
                            releaseId: null,
                            event: null,
                            tab: null,
                            record: null,
                            projectDetail: null,
                            members: null,
                            memberProject: null,
                            q: null,
                            offset: null,
                            trace: null,
                            relatedEvent: null,
                          })}
                        >
                          {selected.events.toLocaleString()} events
                        </AppLink>
                        <AppLink
                          className="button"
                          href={href({
                            view: "sourcemaps",
                            project: selected.project_id,
                            release: selected.version,
                            releaseId: null,
                            issue: null,
                            event: null,
                            tab: null,
                            record: null,
                            projectDetail: null,
                            members: null,
                            memberProject: null,
                            q: null,
                            offset: null,
                            trace: null,
                            relatedEvent: null,
                          })}
                        >
                          {selected.maps.toLocaleString()} source maps
                        </AppLink>
                      </div>
                      {selected.url && (
                        <p>
                          <a
                            href={selected.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Release notes ↗
                          </a>
                        </p>
                      )}
                      {selected.notes && (
                        <p style={{ whiteSpace: "pre-wrap" }}>
                          {selected.notes}
                        </p>
                      )}
                    </section>
                  )}
                  <section className="telemetry-card operation-form">
                    <h3>{creating ? "Create release" : "Edit release"}</h3>
                    <form
                      key={selected?.id || `new-${project || "all"}`}
                      onSubmit={save}
                    >
                      {creating && (
                        <>
                          <label>
                            Project
                            <select
                              className="text-input"
                              name="project"
                              defaultValue={project || projects[0]?.id}
                              required
                            >
                              {projects.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                  {entry.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Version
                            <input
                              className="text-input"
                              name="version"
                              placeholder="my-app@1.2.0"
                              maxLength={300}
                              required
                            />
                          </label>
                        </>
                      )}
                      <label>
                        Release URL
                        <input
                          className="text-input"
                          name="url"
                          type="url"
                          placeholder="https://github.com/…/releases/…"
                          defaultValue={selected?.url || ""}
                        />
                      </label>
                      <label>
                        Notes
                        <textarea
                          className="text-input"
                          name="notes"
                          maxLength={10000}
                          defaultValue={selected?.notes || ""}
                        />
                      </label>
                      <label className="inline-field">
                        <input
                          name="finalized"
                          type="checkbox"
                          defaultChecked={Boolean(selected?.finalized_at)}
                        />
                        Mark released
                      </label>
                      <button className="button primary" disabled={busy}>
                        {busy ? "Saving…" : "Save release"}
                      </button>
                    </form>
                  </section>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="section-detail-empty">
            <h2 id="release-detail-heading">Select a release</h2>
            <p>
              Choose a release to view its events, source maps, and release
              notes.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
