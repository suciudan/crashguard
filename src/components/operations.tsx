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
}: {
  view: string;
  projects: Project[];
}) {
  const { params, update, href } = useAppNavigation();
  const project = Number(params.get("project")) || undefined;
  const [releases, setReleases] = useState<Releases>([]),
    [maps, setMaps] = useState<Maps>([]),
    [alerts, setAlerts] = useState<Alerts>({ rules: [], deliveries: [] });
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
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
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [view, project, refresh]);
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
          {view === "releases" && (
            <>
              <details
                className="telemetry-card operation-form"
                open={!releases.length}
              >
                <summary>Create or update release</summary>
                <form
                  onSubmit={(e) => {
                    const f = formData(e);
                    void run(() =>
                      action(
                        saveRelease({
                          project: Number(f.get("project")),
                          version: str(f, "version"),
                          notes: str(f, "notes"),
                          url: str(f, "url"),
                          finalized: f.has("finalized"),
                        }),
                      ),
                    );
                  }}
                >
                  {projectField}
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
                  <label>
                    Release URL
                    <input
                      className="text-input"
                      name="url"
                      type="url"
                      placeholder="https://github.com/…/releases/…"
                    />
                  </label>
                  <label>
                    Notes
                    <textarea
                      className="text-input"
                      name="notes"
                      maxLength={10000}
                    />
                  </label>
                  <label className="inline-field">
                    <input name="finalized" type="checkbox" />
                    Mark released
                  </label>
                  <button className="button primary" disabled={busy}>
                    Save release
                  </button>
                </form>
              </details>
              <section className="telemetry-card">
                <div className="telemetry-table-wrap">
                  <table className="telemetry-table">
                    <thead>
                      <tr>
                        <th>Release</th>
                        <th>Project</th>
                        <th>Events</th>
                        <th>Source maps</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {releases.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <strong>{r.version}</strong>
                            {r.url && (
                              <p>
                                <a
                                  href={r.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Release notes ↗
                                </a>
                              </p>
                            )}
                            {r.notes && (
                              <details>
                                <summary>Notes</summary>
                                <p style={{ whiteSpace: "pre-wrap" }}>
                                  {r.notes}
                                </p>
                              </details>
                            )}
                          </td>
                          <td>{r.project_name}</td>
                          <td>
                            <AppLink
                              href={href({
                                view: "issues",
                                project: r.project_id,
                                release: r.version,
                                status: "all",
                                issue: null,
                              })}
                            >
                              {r.events}
                            </AppLink>
                          </td>
                          <td>
                            <AppLink
                              href={href({
                                view: "sourcemaps",
                                project: r.project_id,
                              })}
                            >
                              {r.maps}
                            </AppLink>
                          </td>
                          <td>
                            {r.finalized_at ? (
                              "Released"
                            ) : (
                              <button
                                className="button"
                                disabled={busy}
                                onClick={() =>
                                  void run(() =>
                                    action(
                                      saveRelease({
                                        project: r.project_id,
                                        version: r.version,
                                        url: r.url,
                                        notes: r.notes,
                                        finalized: true,
                                      }),
                                    ),
                                  )
                                }
                              >
                                Finalize
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!releases.length && (
                  <p className="telemetry-detail">
                    Releases also appear automatically when events arrive with a
                    release version.
                  </p>
                )}
              </section>
            </>
          )}
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
