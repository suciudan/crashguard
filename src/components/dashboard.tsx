"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
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
  Funnel,
  Globe2,
  Layers3,
  LayoutDashboard,
  Loader2,
  Plus,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  UserPlus,
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
import { MembersWorkspace } from "./invitations";
import { McpConnections } from "./mcp-connections";
export default function Dashboard() {
  const { params, href, update } = useAppNavigation();
  const view =
    params.get("members") === "1"
      ? "members"
      : [
            "dashboard",
            "issues",
            "projects",
            "members",
            "mcp",
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
  const projectDetail = params.get("projectDetail");
  const panelView = [
    "issues",
    "projects",
    "members",
    "releases",
    ...Object.keys(telemetryViews),
  ].includes(view);
  const [data, setData] = useState<DashboardData | null>(null);
  const [listCount, setListCount] = useState<{
    view: string;
    count: number | null;
  } | null>(null);
  const onCountChange = useCallback(
    (count: number | null) => setListCount({ view, count }),
    [view],
  );
  const headingCount =
    view === "issues"
      ? data?.total
      : view === "projects"
        ? data?.projects.length
        : listCount?.view === view
          ? listCount.count
          : null;
  const filter = (key: string, value: string) =>
    update({ [key]: value, offset: null });
  const setQuery = (value: string) => update({ q: value, offset: null }, true);
  const issueHref = (id: number) => href({ issue: id, event: null, tab: null });
  const sectionHref = (changes: Record<string, string | number | null>) =>
    href({
      issue: null,
      event: null,
      tab: null,
      record: null,
      projectDetail: null,
      releaseId: null,
      members: null,
      memberProject: null,
      member: null,
      invitation: null,
      membersTab: null,
      offset: null,
      q: null,
      trace: null,
      relatedEvent: null,
      ...changes,
    });
  const [error, setError] = useState("");

  const [toast, setToast] = useState("");
  const [modal, setModal] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const filtersButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!filtersOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!filtersRef.current?.contains(event.target as Node))
        setFiltersOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setFiltersOpen(false);
        filtersButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [filtersOpen]);
  const latest = useRef(0);
  const mainRef = useRef<HTMLElement>(null);
  const issueListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (issueListRef.current) issueListRef.current.scrollTop = 0;
  }, [offset, project, environment, release, hours, status, search, sort]);
  const listFocus = useRef<HTMLElement | null>(null);
  const hasData = Boolean(data);
  const paneSelection =
    view === "issues"
      ? selected
      : view === "projects"
        ? projectDetail
        : view === "releases"
          ? params.get("releaseId")
          : view === "members"
            ? params.get("member")
              ? `member:${params.get("member")}`
              : params.get("invitation")
                ? `invitation:${params.get("invitation")}`
                : null
            : params.get("record");
  useEffect(() => {
    if (
      !panelView ||
      !hasData ||
      modal ||
      !window.matchMedia("(max-width: 900px)").matches
    )
      return;
    if (paneSelection) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (mainRef.current
          ?.querySelector(".section-list-pane")
          ?.contains(active) ||
          active.closest(".workspace-heading-actions"))
      )
        listFocus.current = active;
      const detail = mainRef.current?.querySelector<HTMLElement>(
        ".section-detail-pane",
      );
      if (detail) {
        detail.tabIndex = -1;
        detail.focus({ preventScroll: true });
      }
    } else if (
      listFocus.current?.isConnected &&
      mainRef.current?.contains(listFocus.current)
    ) {
      listFocus.current.focus({ preventScroll: true });
      listFocus.current = null;
    }
  }, [view, paneSelection, panelView, hasData, modal]);
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
      members: null,
      memberProject: null,
      member: null,
      invitation: null,
      membersTab: null,
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
  const memberProjectId = params.has("memberProject")
    ? Number(params.get("memberProject"))
    : activeProject?.id || null;
  const titles: Record<string, string> = {
    dashboard: "Dashboard",
    issues: "Issues",
    members: "Members",
    mcp: "MCP",
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
    key === "members"
      ? data?.account?.role === "owner"
      : key === view ||
        !optionalSections.some((section) => section === key) ||
        data?.sections[key as keyof SidebarSections] === true;
  const projectFilter = data && (
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
  );
  const environmentFilter = data && (
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
  );
  const timeFilter = data && (
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
  );
  const issueFilters = data && (
    <>
      {release && (
        <p className="telemetry-filter">
          Release: {release}{" "}
          <AppLink href={href({ release: null })}>Clear filter</AppLink>
        </p>
      )}
      <div className="filterbar">
        <div className="filter-left">
          {projectFilter}
          {environmentFilter}
        </div>
        <div className="filter-left">
          <span className="refresh-label">
            <span className="green-dot" />
            Live · 10s
          </span>
          {timeFilter}
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
  );
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
            href={sectionHref({
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
            href={sectionHref({
              view: "issues",
              issue: null,
              event: null,
              tab: null,
            })}
          >
            <Layers3 size={18} />
            Issues
            {data && data.stats.active > 0 && (
              <span className="nav-count">{data.stats.active}</span>
            )}
          </AppLink>
          {data?.account?.role === "owner" && (
            <AppLink
              className={view === "members" ? "active" : ""}
              href={sectionHref({
                view: "members",
                memberProject: activeProject?.id || null,
                issue: null,
                event: null,
                tab: null,
              })}
            >
              <Users size={18} />
              Members
            </AppLink>
          )}
          <AppLink
            className={view === "projects" ? "active" : ""}
            href={sectionHref({
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
                href={sectionHref({
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
                href={sectionHref({
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
        </nav>
        <select
          className="text-input mobile-navigation"
          aria-label="Navigate workspace"
          value={view}
          onChange={(e) =>
            update({
              view: e.target.value,
              members: null,
              memberProject:
                e.target.value === "members" ? activeProject?.id || null : null,
              member: null,
              invitation: null,
              membersTab: null,
              projectDetail: null,
              releaseId: null,
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
          {data?.projects.length === 0 && (
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
          )}
          <nav aria-label="Setup and integrations">
            <AppLink
              className={view === "setup" ? "active" : ""}
              href={sectionHref({
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
            <AppLink
              className={view === "mcp" ? "active" : ""}
              href={sectionHref({ view: "mcp" })}
            >
              <Plug size={18} />
              MCP
            </AppLink>
          </nav>
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
      <div className={`main-shell ${panelView ? "panel-shell" : ""}`}>
        <header className="topbar">
          <div
            className={`workspace-heading ${view === "issues" ? "issues-heading" : ""}`}
          >
            {panelView ? (
              <h1>
                {titles[view]}{" "}
                {view !== "issues" && headingCount != null && (
                  <span>{headingCount}</span>
                )}
              </h1>
            ) : (
              <span className="topbar-label">{titles[view]}</span>
            )}
            {view === "issues" && (
              <label className="search issue-search">
                <Search size={17} />
                <input
                  placeholder="Search issues…"
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
            )}
            <div className="workspace-heading-actions">
              {view === "issues" && (
                <>
                  <div
                    className="issue-filter-menu"
                    ref={filtersRef}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget))
                        setFiltersOpen(false);
                    }}
                  >
                    <button
                      ref={filtersButtonRef}
                      className="icon-button"
                      aria-label="Issue filters"
                      title="Issue filters"
                      aria-expanded={filtersOpen}
                      aria-controls="issue-filters"
                      onClick={() => setFiltersOpen((open) => !open)}
                    >
                      <Funnel size={15} />
                    </button>
                    <div
                      className="issue-controls"
                      id="issue-filters"
                      hidden={!filtersOpen}
                      role="group"
                      aria-label="Issue filters"
                    >
                      <div className="issue-filter-heading">
                        <strong>Filters</strong>
                        <button
                          className="icon-button"
                          aria-label="Close filters"
                          onClick={() => {
                            setFiltersOpen(false);
                            filtersButtonRef.current?.focus();
                          }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <div className="issue-controls-search">
                        <label className="sort">
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
                      <div className="issue-controls-row">
                        {projectFilter}
                        {environmentFilter}
                      </div>
                      <div className="issue-controls-row">
                        <label className="select-wrap">
                          <Layers3 size={15} />
                          <select
                            aria-label="Issue status"
                            value={status}
                            onChange={(e) => filter("status", e.target.value)}
                          >
                            <option value="unresolved">Unresolved</option>
                            <option value="resolved">Resolved</option>
                            <option value="ignored">Ignored</option>
                            <option value="all">All issues</option>
                          </select>
                          <ChevronDown size={13} />
                        </label>
                        {timeFilter}
                      </div>
                      {release && (
                        <p className="telemetry-filter">
                          Release: {release}{" "}
                          <AppLink href={href({ release: null })}>
                            Clear filter
                          </AppLink>
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Refresh events"
                    title="Refresh events"
                    onClick={() => {
                      void load();
                      notify("Issues refreshed");
                    }}
                  >
                    <RefreshCw size={15} />
                  </button>
                </>
              )}
              {data?.account?.role === "owner" && view === "projects" && (
                <button
                  className="icon-button"
                  aria-label="New project"
                  onClick={() => setModal(true)}
                >
                  <Plus size={17} />
                </button>
              )}
              {view === "members" && data?.account?.role === "owner" && (
                <button
                  className="button primary"
                  disabled={
                    !data.projects.some((entry) => entry.id === memberProjectId)
                  }
                  onClick={() =>
                    update({
                      view: "members",
                      members: null,
                      memberProject: memberProjectId,
                      member: null,
                      invitation: "new",
                    })
                  }
                >
                  <UserPlus size={15} />
                  Invite member
                </button>
              )}
              {view === "releases" && (
                <button
                  className="button primary"
                  disabled={!data?.projects.length}
                  onClick={() => update({ releaseId: "new" })}
                >
                  New release
                </button>
              )}
            </div>
          </div>
          <div className="account-actions">
            <Link className="button" href="/settings/security">
              Passkeys
            </Link>
            <SignOut />
          </div>
        </header>
        <main
          ref={mainRef}
          className={panelView ? "workspace-main" : undefined}
        >
          {!panelView && (
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
                {view === "mcp" && (
                  <p>
                    Connect Codex or Claude to your errors, stack traces, and breadcrumbs.
                    Read-only access to your projects.
                  </p>
                )}
              </div>
              <div className="page-actions">
                {data?.account?.role === "owner" &&
                  view !== "setup" &&
                  view !== "mcp" && (
                    <button
                      className="button primary"
                      onClick={() => setModal(true)}
                    >
                      <Plus size={16} />
                      New project
                    </button>
                  )}
              </div>
            </div>
          )}
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
          {view === "dashboard" && issueFilters}
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
            <div
              className={`section-workspace ${selected !== null ? "has-selection" : ""}`}
            >
              <section
                className="section-list-pane issues-list-pane"
                aria-label="Issues column"
              >
                <section className="issue-section">
                  {data.issues.length > 0 ? (
                    <>
                      <div
                        ref={issueListRef}
                        className="issue-list"
                        role="region"
                        aria-label="Issues list"
                        tabIndex={0}
                      >
                        {data.issues.map((issue) => (
                          <AppLink
                            key={issue.id}
                            href={issueHref(issue.id)}
                            aria-label={issue.title}
                            aria-current={
                              selected === issue.id ? "true" : undefined
                            }
                            className={`section-list-row issue-list-row ${selected === issue.id ? "is-selected" : ""}`}
                          >
                            <div className="issue-row-heading">
                              <span className={`severity ${issue.level}`}>
                                <CircleAlert size={15} />
                              </span>
                              <span className="issue-title">{issue.title}</span>
                              <ChevronRight size={14} className="row-chevron" />
                            </div>
                            <span className="issue-row-location">
                              {issue.culprit || "No location reported"}
                            </span>
                            <div className="issue-row-meta">
                              <span>CG-{issue.id}</span>
                              <span>{issue.project_name}</span>
                              {issue.environment && (
                                <span>{issue.environment}</span>
                              )}
                              <span className={`level-text ${issue.level}`}>
                                {issue.level}
                              </span>
                            </div>
                            <div className="issue-row-footer">
                              <span>
                                {issue.event_count.toLocaleString()} events ·{" "}
                                {issue.user_count || 0} users
                              </span>
                              <span>{relative(issue.last_seen)}</span>
                            </div>
                          </AppLink>
                        ))}
                      </div>
                      <div className="table-footer">
                        <span>
                          Showing {offset + 1}–
                          {Math.min(offset + 30, data.total)} of {data.total}{" "}
                          issues
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
                      <ShieldCheck
                        className="empty-symbol"
                        size={30}
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      <h2>
                        {!data.projects.length
                          ? "Your next bug won’t go unnoticed."
                          : search ||
                              status !== "unresolved" ||
                              data.stats.events
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
              </section>
              <div className="section-detail-pane">
                {selected !== null ? (
                  <IssuePanel
                    key={selected}
                    id={selected}
                    onClose={() =>
                      update({ issue: null, event: null, tab: null })
                    }
                    onChanged={() => setRefresh((n) => n + 1)}
                    notify={notify}
                  />
                ) : (
                  <div className="section-detail-empty">
                    <Layers3 size={30} />
                    <h2>Select an issue</h2>
                    <p>
                      Choose an issue from the list to explore its events, stack
                      trace, and context.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
          {data &&
            view === "members" &&
            (data.account?.role === "owner" ? (
              <MembersWorkspace
                key={memberProjectId || "none"}
                projects={data.projects}
                projectId={memberProjectId}
                onCountChange={onCountChange}
              />
            ) : (
              <div className="section-detail-empty">
                <Users size={30} />
                <h2>Members</h2>
                <p>Only the workspace owner can manage project access.</p>
              </div>
            ))}
          {data && view === "mcp" && <McpConnections />}
          {data && telemetryViews[view] && (
            <Telemetry
              key={view}
              view={view}
              projects={data.projects}
              onCountChange={onCountChange}
            />
          )}
          {data && ["releases", "sourcemaps", "alerts"].includes(view) && (
            <Operations
              key={view}
              view={view}
              projects={data.projects}
              onCountChange={onCountChange}
            />
          )}
          {data && view === "projects" && (
            <div
              className={`section-workspace ${projectDetail ? "has-selection" : ""}`}
            >
              <section
                className="section-list-pane"
                aria-label="Projects column"
              >
                {data.projects.length ? (
                  <div className="project-list">
                    {data.projects.map((p) => (
                      <AppLink
                        key={p.id}
                        aria-label={p.name}
                        href={href({ projectDetail: p.id })}
                        aria-current={
                          projectDetail === String(p.id) ? "true" : undefined
                        }
                        className={`section-list-row project-card ${projectDetail === String(p.id) ? "is-selected" : ""}`}
                      >
                        <div className="project-row-heading">
                          <Platform platform={p.platform} />
                          <strong>{p.name}</strong>
                          <ChevronRight size={14} className="row-chevron" />
                        </div>
                        <div className="issue-row-meta">
                          <span>
                            {p.platform === "node"
                              ? "Node.js"
                              : p.platform === "javascript"
                                ? "JavaScript"
                                : p.platform}
                          </span>
                          <span>PROJECT {p.id}</span>
                        </div>
                        <div className="issue-row-footer">
                          <span>
                            {(p.event_count || 0).toLocaleString()} events
                          </span>
                          <span className="live-pill">
                            <span />
                            {p.event_count
                              ? "Receiving events"
                              : "Awaiting first event"}
                          </span>
                        </div>
                      </AppLink>
                    ))}
                  </div>
                ) : (
                  <div className="project-empty">
                    <FolderKanban size={30} />
                    <h2>No projects yet</h2>
                    <p>
                      {data.account?.role === "owner"
                        ? "Create a project for your first application."
                        : "Ask the workspace owner for a project invitation."}
                    </p>
                    {data.account?.role === "owner" && (
                      <button
                        className="button primary"
                        onClick={() => setModal(true)}
                      >
                        <Plus size={15} />
                        Create project
                      </button>
                    )}
                  </div>
                )}
              </section>
              <section
                className="section-detail-pane"
                aria-label="Project details"
              >
                {projectDetail ? (
                  <>
                    <div className="section-detail-header">
                      <span>
                        <FolderKanban size={16} />
                        Project details
                      </span>
                      <AppLink
                        className="button"
                        href={href({ projectDetail: null })}
                      >
                        <ChevronLeft size={14} />
                        Back to projects
                      </AppLink>
                    </div>
                    {data.projects.find(
                      (p) => String(p.id) === projectDetail,
                    ) ? (
                      <ProjectDetails
                        project={data.projects.find(
                          (p) => String(p.id) === projectDetail,
                        )!}
                      />
                    ) : (
                      <div className="section-detail-empty">
                        <CircleAlert size={30} />
                        <h2>Project not found</h2>
                        <p>Choose an available project from the list.</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="section-detail-empty">
                    <FolderKanban size={30} />
                    <h2>Select a project</h2>
                    <p>
                      Choose a project to view its activity and connect your
                      application.
                    </p>
                  </div>
                )}
              </section>
            </div>
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
                      : data.account?.role === "owner"
                        ? "First, give your app a home."
                        : "No projects available."}
                  </h2>
                  <p>
                    {data.account?.role === "owner"
                      ? "Create a project to generate your Sentry-compatible DSN."
                      : "Ask the workspace owner for a project invitation."}
                  </p>
                  {data.account?.role === "owner" && (
                    <button
                      className="button primary"
                      onClick={() => setModal(true)}
                    >
                      <Plus size={16} />
                      Create project
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {modal && data?.account?.role === "owner" && (
        <ProjectModal
          onClose={() => setModal(false)}
          onCreated={(p) => {
            setModal(false);
            update({
              view: "setup",
              project: p.id,
              sdk: null,
              members: null,
              memberProject: null,
              member: null,
              invitation: null,
              membersTab: null,
            });
            setRefresh((n) => n + 1);
            notify(`${p.name} is ready to connect.`);
          }}
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
function ProjectDetails({ project }: { project: Project }) {
  const { href } = useAppNavigation();
  return (
    <div className="section-detail-body project-detail">
      <Platform platform={project.platform} />
      <h2>{project.name}</h2>
      <p>
        Project {project.id} ·{" "}
        {project.platform === "node"
          ? "Node.js"
          : project.platform === "javascript"
            ? "JavaScript"
            : project.platform}
      </p>
      <div className="project-detail-stats">
        <div>
          <span>Events received</span>
          <strong>{(project.event_count || 0).toLocaleString()}</strong>
        </div>
        <div>
          <span>Created</span>
          <strong>{new Date(project.created_at).toLocaleDateString()}</strong>
        </div>
      </div>
      <div className="project-detail-actions">
        <AppLink
          className="button primary"
          href={href({
            view: "issues",
            project: project.id,
            projectDetail: null,
            issue: null,
            event: null,
            tab: null,
            offset: null,
            q: null,
            environment: null,
            release: null,
            status: null,
          })}
        >
          View issues <ArrowRight size={14} />
        </AppLink>
        <AppLink
          className="button"
          href={href({
            view: "setup",
            project: project.id,
            projectDetail: null,
            sdk: null,
          })}
        >
          <Code2 size={15} />
          SDK setup
        </AppLink>
      </div>
      <div className="project-detail-note">
        <ShieldCheck size={20} />
        <div>
          <h3>
            {project.event_count
              ? "Your application is connected"
              : "Connect your application"}
          </h3>
          <p>
            {project.event_count
              ? "Explore captured issues or open SDK setup to configure your integration."
              : "Open SDK setup to get your project’s DSN, install the SDK, and send your first event."}
          </p>
        </div>
      </div>
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
