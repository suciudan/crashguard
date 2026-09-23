"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  FolderKanban,
  Globe2,
  Layers3,
  LayoutDashboard,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  optionalSections,
  type DashboardData,
  type Project,
  type SidebarSections,
} from "@/lib/types";
import { IssuePanel, ProjectModal, Setup } from "./details";
import { action, Platform, relative } from "./shared";
import Logo from "./logo";
import { getDashboard } from "@/app/actions/dashboard";
import { SignOut } from "./passkeys";
import { AppLink, useAppNavigation } from "./navigation";
import { Telemetry, telemetryViews } from "./telemetry";
import { Operations } from "./operations";
export default function Dashboard() {
  const { params, href, update } = useAppNavigation();
  const view = [
    "dashboard",
    "issues",
    "projects",
    "setup",
    "releases",
    "sourcemaps",
    "alerts",
    ...Object.keys(telemetryViews),
  ].includes(params.get("view") || "")
    ? params.get("view")!
    : "issues";
  const project = params.get("project") || "";
  const environment = params.get("environment") || "";
  const release = params.get("release") || "";
  const hours = ["24", "168", "720"].includes(params.get("hours") || "")
    ? params.get("hours")!
    : "24";
  const status = ["unresolved", "resolved", "ignored", "all"].includes(
    params.get("status") || "",
  )
    ? params.get("status")!
    : "unresolved";
  const query = params.get("q") || "";
  const [search, setSearch] = useState(query);
  const sort = params.get("sort") === "frequency" ? "frequency" : "recent";
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const rawIssue = Number(params.get("issue"));
  const selected =
    Number.isSafeInteger(rawIssue) && rawIssue > 0 ? rawIssue : null;
  const setupId = Number(project) || null;
  const [data, setData] = useState<DashboardData | null>(null);
  const filter = (key: string, value: string) =>
    update({ [key]: value, offset: null });
  const setQuery = (value: string) => update({ q: value, offset: null }, true);
  const issueHref = (id: number) => href({ issue: id, event: null, tab: null });
  const [error, setError] = useState("");

  const [toast, setToast] = useState("");
  const [modal, setModal] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const load = useCallback(async () => {
    const version = ++latest.current;
    try {
      const result = await action(
        getDashboard({
          project,
          environment,
          release,
          hours,
          status,
          q: search,
          sort,
          offset: String(offset),
        }),
      );
      if (version === latest.current) {
        setData(result);
        setError("");
      }
    } catch (e) {
      if (version === latest.current) setError((e as Error).message);
    }
  }, [project, environment, release, hours, status, search, sort, offset]);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      clearInterval(timer);
      latest.current++;
    };
  }, [load, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  const notify = (message: string) => setToast(message);

  function connect(p?: Project) {
    update({
      view: "setup",
      project: p?.id || setupId || data?.projects[0]?.id || null,
      issue: null,
      event: null,
      tab: null,
      sdk: null,
    });
  }
  const activeProject = setupId
    ? data?.projects.find((p) => p.id === setupId)
    : data?.projects[0];
  const titles: Record<string, string> = {
    dashboard: "Dashboard",
    issues: "Issues",
    projects: "Projects",
    setup: "Connect your app",
    releases: "Releases",
    sourcemaps: "Source maps",
    alerts: "Alerts",
    ...Object.fromEntries(
      Object.entries(telemetryViews).map(([key, value]) => [key, value.title]),
    ),
  };
  const sectionIsVisible = (key: string) =>
    key === view ||
    !optionalSections.some((section) => section === key) ||
    data?.sections[key as keyof SidebarSections] === true;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="CrashGuard home">
          <Logo className="brand-logo" />
        </a>

        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <AppLink
            className={view === "dashboard" ? "active" : ""}
            href={href({
              view: "dashboard",
              issue: null,
              event: null,
              tab: null,
              record: null,
              offset: null,
              q: null,
            })}
          >
            <LayoutDashboard size={18} />
            Dashboard
          </AppLink>
          <AppLink
            className={view === "issues" ? "active" : ""}
            href={href({ view: "issues", issue: null, event: null, tab: null })}
          >
            <Layers3 size={18} />
            Issues
            {data && data.stats.active > 0 && (
              <span className="nav-count">{data.stats.active}</span>
            )}
          </AppLink>
          <AppLink
            className={view === "projects" ? "active" : ""}
            href={href({
              view: "projects",
              issue: null,
              event: null,
              tab: null,
            })}
          >
            <FolderKanban size={18} />
            Projects
          </AppLink>
          {Object.entries(telemetryViews)
            .filter(([key]) => sectionIsVisible(key))
            .map(([key, value]) => (
              <AppLink
                key={key}
                className={view === key ? "active" : ""}
                href={href({
                  view: key,
                  issue: null,
                  event: null,
                  tab: null,
                  record: null,
                  offset: null,
                  q: null,
                  trace: null,
                  relatedEvent: null,
                })}
              >
                <Activity size={18} />
                {value.title}
              </AppLink>
            ))}
          {[
            ["releases", "Releases"],
            ["sourcemaps", "Source maps"],
            ["alerts", "Alerts"],
          ]
            .filter(([key]) => sectionIsVisible(key))
            .map(([key, label]) => (
              <AppLink
                key={key}
                className={view === key ? "active" : ""}
                href={href({
                  view: key,
                  issue: null,
                  event: null,
                  tab: null,
                  record: null,
                  offset: null,
                  q: null,
                })}
              >
                <Box size={18} />
                {label}
              </AppLink>
            ))}
          <AppLink
            className={view === "setup" ? "active" : ""}
            href={href({
              view: "setup",
              project: setupId || data?.projects[0]?.id || null,
              issue: null,
              event: null,
              tab: null,
            })}
          >
            <Code2 size={18} />
            SDK setup
          </AppLink>
        </nav>
        <select
          className="text-input mobile-navigation"
          aria-label="Navigate workspace"
          value={view}
          onChange={(e) =>
            update({
              view: e.target.value,
              issue: null,
              event: null,
              tab: null,
              record: null,
              offset: null,
              q: null,
              trace: null,
              relatedEvent: null,
              release: null,
            })
          }
        >
          {Object.entries(titles)
            .filter(([key]) => sectionIsVisible(key))
            .map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
        </select>
        <div className="sidebar-bottom">
          <div className="lightweight-card">
            <span className="mini-icon">
              <Zap size={16} />
            </span>
            <strong>Small footprint. Big clarity.</strong>
            <p>
              Your errors, in one place.
              <br />
              Your infrastructure, your data.
            </p>
            <button onClick={() => connect()}>
              Connect an application <ArrowUpRight size={14} />
            </button>
          </div>
          <a
            className="docs-link"
            href="https://docs.sentry.io/platforms/"
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen size={17} />
            Documentation
            <ArrowUpRight size={14} />
          </a>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{titles[view]}</strong>
          </div>
          <div className="account-actions">
            <a className="button" href="/settings/security">
              Passkeys
            </a>
            <SignOut />
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>{titles[view]}</h1>
              {(view === "projects" || view === "setup") && (
                <p>
                  {view === "projects"
                    ? "A clear view of every application you’re keeping an eye on."
                    : "Your favorite Sentry SDK. Your own lightweight backend."}
                </p>
              )}
            </div>
            <div className="page-actions">
              <button className="button primary" onClick={() => setModal(true)}>
                <Plus size={16} />
                New project
              </button>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={17} />
              {error}
              <button
                onClick={() => {
                  void load();
                }}
              >
                Retry
              </button>
            </div>
          )}
          {!data && !error && (
            <div className="loading">
              <Loader2 className="spin" />
              Loading your workspace…
            </div>
          )}
          {data && (view === "dashboard" || view === "issues") && (
            <>
              {release && (
                <p className="telemetry-filter">
                  Release: {release}{" "}
                  <AppLink href={href({ release: null })}>Clear filter</AppLink>
                </p>
              )}
              <div className="filterbar">
                <div className="filter-left">
                  <label className="select-wrap">
                    <Box size={15} />
                    <select
                      aria-label="Project"
                      value={project}
                      onChange={(e) => filter("project", e.target.value)}
                    >
                      <option value="">All projects</option>
                      {data.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={13} />
                  </label>
                  <label className="select-wrap">
                    <Globe2 size={15} />
                    <select
                      aria-label="Environment"
                      value={environment}
                      onChange={(e) => filter("environment", e.target.value)}
                    >
                      <option value="">All environments</option>
                      {data.environments.map((env) => (
                        <option key={env}>{env}</option>
                      ))}
                    </select>
                    <ChevronDown size={13} />
                  </label>
                </div>
                <div className="filter-left">
                  <span className="refresh-label">
                    <span className="green-dot" />
                    Live · 10s
                  </span>
                  <label className="select-wrap">
                    <Clock3 size={15} />
                    <select
                      aria-label="Time range"
                      value={hours}
                      onChange={(e) => filter("hours", e.target.value)}
                    >
                      <option value="24">Last 24 hours</option>
                      <option value="168">Last 7 days</option>
                      <option value="720">Last 30 days</option>
                    </select>
                    <ChevronDown size={13} />
                  </label>
                  <button
                    className="icon-button"
                    aria-label="Refresh events"
                    onClick={() => {
                      void load();
                      notify("Dashboard refreshed");
                    }}
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
              </div>
            </>
          )}
          {data && view === "dashboard" && (
            <section className="overview" aria-label="Event overview">
              <div className="metrics">
                <Metric
                  label="Total events"
                  value={data.stats.events}
                  icon={<Activity size={17} />}
                  caption="Errors and messages received"
                />
                <Metric
                  label="Active issues"
                  value={data.stats.active}
                  icon={<CircleAlert size={17} />}
                  caption="Unique issues to investigate"
                />
                <Metric
                  label="Affected users"
                  value={data.stats.users}
                  icon={<Users size={17} />}
                  caption="Identified users in this period"
                />
                <Metric
                  label="Resolved issues"
                  value={data.stats.resolved}
                  icon={<CheckCheck size={17} />}
                  caption="A little less on your plate"
                />
              </div>
              <ActivityChart data={data} hours={Number(hours)} />
            </section>
          )}
          {data && view === "issues" && (
            <section className="issue-section">
              <div className="issue-tabs">
                <div className="tabs" role="tablist" aria-label="Issue status">
                  {[
                    ["unresolved", "Unresolved"],
                    ["resolved", "Resolved"],
                    ["ignored", "Ignored"],
                    ["all", "All issues"],
                  ].map(([value, label]) => (
                    <button
                      role="tab"
                      aria-selected={status === value}
                      className={status === value ? "selected" : ""}
                      key={value}
                      onClick={() => filter("status", value)}
                    >
                      {label}
                      {status === value && <span>{data.total}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="issue-toolbar">
                <label className="search">
                  <Search size={17} />
                  <input
                    placeholder="Search issues, messages, or projects…"
                    aria-label="Search issues"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </label>
                <label className="sort">
                  <SlidersHorizontal size={15} />
                  <select
                    aria-label="Sort issues"
                    value={sort}
                    onChange={(e) => filter("sort", e.target.value)}
                  >
                    <option value="recent">Last seen</option>
                    <option value="frequency">Most frequent</option>
                  </select>
                  <ChevronDown size={13} />
                </label>
              </div>
              {data.issues.length > 0 ? (
                <>
                  <div className="table-scroll">
                    <table className="issues-table">
                      <thead>
                        <tr>
                          <th className="issue-column">Issue</th>
                          <th>Source</th>
                          <th>Events</th>
                          <th>Users</th>
                          <th>
                            Last seen <ArrowDown size={12} />
                          </th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {data.issues.map((issue) => (
                          <tr
                            key={issue.id}
                            onClick={() =>
                              update({
                                issue: issue.id,
                                event: null,
                                tab: null,
                              })
                            }
                          >
                            <td>
                              <div className="issue-title-line">
                                <span className={`severity ${issue.level}`}>
                                  <CircleAlert size={15} />
                                </span>
                                <AppLink
                                  className="issue-title"
                                  href={issueHref(issue.id)}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {issue.title}
                                </AppLink>
                              </div>
                              <div className="issue-meta">
                                <span>CG-{issue.id}</span>
                                <span className="meta-dot">·</span>
                                <span className="truncate">
                                  {issue.culprit || "No location reported"}
                                </span>
                                <span className={`level-text ${issue.level}`}>
                                  {issue.level}
                                </span>
                              </div>
                            </td>
                            <td>
                              <div className="source-cell">
                                <Platform platform={issue.platform} small />
                                <span>{issue.project_name}</span>
                              </div>
                              <div className="environment-label">
                                {issue.environment}
                              </div>
                            </td>
                            <td className="number-cell">
                              {issue.event_count.toLocaleString()}
                            </td>
                            <td className="number-cell">
                              {issue.user_count || "—"}
                            </td>
                            <td className="last-seen">
                              {relative(issue.last_seen)}
                            </td>
                            <td>
                              <ChevronRight size={15} className="subtle" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="table-footer">
                    <span>
                      Showing {offset + 1}–{Math.min(offset + 30, data.total)}{" "}
                      of {data.total} issues
                    </span>
                    <div>
                      <button
                        className="icon-button"
                        disabled={!offset}
                        onClick={() =>
                          update({ offset: Math.max(0, offset - 30) })
                        }
                        aria-label="Previous page"
                      >
                        <ChevronLeft size={15} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={offset + 30 >= data.total}
                        onClick={() => update({ offset: offset + 30 })}
                        aria-label="Next page"
                      >
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <div className="empty-symbol">
                    <ShieldCheck size={30} />
                    <span className="empty-dot" />
                  </div>
                  <h2>
                    {!data.projects.length
                      ? "Your next bug won’t go unnoticed."
                      : search || status !== "unresolved" || data.stats.events
                        ? "No issues match this view."
                        : "Ready when your app is."}
                  </h2>
                  <p>
                    {!data.projects.length
                      ? "Connect an app with a Sentry SDK and give your errors a home.\nFrom the first exception to the fix, it all starts here."
                      : "Events will appear here as they arrive. Connect your SDK,\nsend a test event, or adjust your filters."}
                  </p>
                  <div className="empty-actions">
                    <button
                      className="button primary"
                      onClick={() =>
                        data.projects.length ? connect() : setModal(true)
                      }
                    >
                      <Plus size={15} />
                      {data.projects.length
                        ? "Connect SDK"
                        : "Connect your first app"}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
          {data && telemetryViews[view] && (
            <Telemetry key={view} view={view} projects={data.projects} />
          )}
          {data && ["releases", "sourcemaps", "alerts"].includes(view) && (
            <Operations key={view} view={view} projects={data.projects} />
          )}
          {data && view === "projects" && (
            <>
              <div className="section-title">
                <h2>
                  Your applications <span>{data.projects.length}</span>
                </h2>
              </div>
              {!data.projects.length ? (
                <div className="project-empty">
                  <FolderKanban size={34} />
                  <h2>One project for each application.</h2>
                  <p>
                    Create a project to get a unique DSN for your Sentry SDK.
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setModal(true)}
                  >
                    <Plus size={16} />
                    Create project
                  </button>
                </div>
              ) : (
                <div className="project-grid">
                  {data.projects.map((p) => (
                    <article className="project-card" key={p.id}>
                      <div className="project-card-heading">
                        <Platform platform={p.platform} />
                        <span className="project-id">PROJECT {p.id}</span>
                      </div>
                      <h2>{p.name}</h2>
                      <p>
                        {p.platform === "node"
                          ? "Node.js"
                          : p.platform === "javascript"
                            ? "JavaScript"
                            : p.platform}{" "}
                        application
                      </p>
                      <div className="project-card-stats">
                        <div>
                          <strong>{p.event_count?.toLocaleString()}</strong>
                          <span>events received</span>
                        </div>
                        <span className="live-pill">
                          <span />
                          {p.event_count
                            ? "Receiving events"
                            : "Awaiting first event"}
                        </span>
                      </div>
                      <div className="project-card-actions">
                        <AppLink
                          href={href({
                            project: p.id,
                            view: "issues",
                            offset: null,
                            q: null,
                            environment: null,
                            status: null,
                          })}
                        >
                          View issues <ArrowRight size={14} />
                        </AppLink>
                        <AppLink
                          href={href({
                            view: "setup",
                            project: p.id,
                            sdk: null,
                          })}
                        >
                          <Code2 size={15} />
                          SDK setup
                        </AppLink>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
          {data && view === "setup" && (
            <>
              {activeProject ? (
                <Setup
                  project={activeProject}
                  projects={data.projects}
                  onSelect={(id) => update({ project: id, sdk: null })}
                  notify={notify}
                  onReceived={() => setRefresh((n) => n + 1)}
                />
              ) : (
                <div className="project-empty">
                  <Code2 size={36} />
                  <h2>
                    {setupId
                      ? "Project not found."
                      : "First, give your app a home."}
                  </h2>
                  <p>
                    Create a project to generate your Sentry-compatible DSN.
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setModal(true)}
                  >
                    <Plus size={16} />
                    Create project
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {modal && (
        <ProjectModal
          onClose={() => setModal(false)}
          onCreated={(p) => {
            setModal(false);
            update({ view: "setup", project: p.id, sdk: null });
            setRefresh((n) => n + 1);
            notify(`${p.name} is ready to connect.`);
          }}
        />
      )}
      {selected !== null && (
        <IssuePanel
          key={selected}
          id={selected}
          onClose={() => update({ issue: null, event: null, tab: null })}
          onChanged={() => setRefresh((n) => n + 1)}
          notify={notify}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  icon,
  caption,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  caption: string;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <strong>{value.toLocaleString()}</strong>
      <span>{caption}</span>
    </div>
  );
}
function ActivityChart({
  data,
  hours,
}: {
  data: DashboardData;
  hours: number;
}) {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const buckets = Array.from({ length: 48 }, (_, i) => {
    const from = now.getTime() - hours * 3600000 + (i * hours * 3600000) / 48;
    const to = from + (hours * 3600000) / 48;
    return data.activity.reduce((sum, a) => {
      const t = new Date(`${a.hour}:00:00.000Z`).getTime();
      return sum + (t >= from && t < to ? a.count : 0);
    }, 0);
  });
  buckets[47] += data.activity
    .filter((a) => a.hour === now.toISOString().slice(0, 13))
    .reduce((sum, a) => sum + a.count, 0);
  const max = Math.max(4, ...buckets);
  return (
    <div className="activity-chart">
      <div className="chart-heading">
        <h2>
          Event activity{" "}
          <span>
            Over the last {hours === 24 ? "24 hours" : `${hours / 24} days`}
          </span>
        </h2>
        <div className="chart-legend">
          <i />
          Events
        </div>
      </div>
      <div className="plot">
        <div className="gridlines">
          {[max, Math.round(max / 2), 0].map((n, i) => (
            <div key={i}>
              <span>{n}</span>
            </div>
          ))}
        </div>
        <div className="bars">
          {buckets.map((n, i) => (
            <div
              className={`bar ${n ? "filled" : ""}`}
              key={i}
              style={{ height: n ? `${Math.max(3, (n / max) * 100)}%` : "2px" }}
              title={`${n} events`}
            />
          ))}
        </div>
        {!data.stats.events && (
          <div className="chart-waiting">
            <span className="green-dot" />
            Waiting for your first event
          </div>
        )}
      </div>
      <div className="chart-axis">
        <span>{hours === 24 ? "24 hours ago" : `${hours / 24} days ago`}</span>
        <span>
          {hours === 24 ? "18h" : `${Math.round((hours / 24) * 0.75)}d`}
        </span>
        <span>
          {hours === 24 ? "12h" : `${Math.round((hours / 24) * 0.5)}d`}
        </span>
        <span>
          {hours === 24 ? "6h" : `${Math.round((hours / 24) * 0.25)}d`}
        </span>
        <span>Now</span>
      </div>
    </div>
  );
}
