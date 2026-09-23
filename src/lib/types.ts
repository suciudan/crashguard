export type Project = {
  id: number;
  name: string;
  platform: string;
  public_key: string;
  created_at: string;
  event_count?: number;
};
export type Issue = {
  id: number;
  project_id: number;
  project_name: string;
  platform: string;
  title: string;
  culprit: string;
  level: string;
  status: "unresolved" | "resolved" | "ignored";
  first_seen: string;
  last_seen: string;
  event_count: number;
  user_count: number;
  environment: string;
};
export type Frame = {
  filename?: string;
  abs_path?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
};
export type SentryEvent = {
  event_id?: string;
  timestamp?: string | number;
  platform?: string;
  level?: string;
  message?: string | { formatted?: string; message?: string };
  logentry?: { formatted?: string; message?: string };
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: Frame[] };
      mechanism?: Record<string, unknown>;
    }[];
  };
  stacktrace?: { frames?: Frame[] };
  culprit?: string;
  transaction?: string;
  environment?: string;
  release?: string;
  fingerprint?: string[];
  user?: Record<string, unknown>;
  tags?: Record<string, string> | string[][];
  breadcrumbs?:
    | {
        timestamp?: string | number;
        category?: string;
        message?: string;
        level?: string;
        data?: Record<string, unknown>;
      }[]
    | {
        values?: {
          timestamp?: string | number;
          category?: string;
          message?: string;
          level?: string;
          data?: Record<string, unknown>;
        }[];
      };
  contexts?: Record<string, unknown>;
  request?: Record<string, unknown>;
  sdk?: Record<string, unknown>;
  [key: string]: unknown;
};
export type StoredEvent = {
  id: number;
  event_id: string;
  issue_id: number;
  received_at: string;
  occurred_at: string;
  environment: string;
  release: string;
  payload: SentryEvent;
};
export const optionalSections = [
  "transactions",
  "logs",
  "replays",
  "profiles",
  "attachments",
  "releases",
  "sourcemaps",
  "alerts",
] as const;
export type SidebarSections = Record<
  (typeof optionalSections)[number],
  boolean
>;
export type DashboardData = {
  sections: SidebarSections;
  projects: Project[];
  issues: Issue[];
  total: number;
  environments: string[];
  stats: {
    events: number;
    issues: number;
    users: number;
    active: number;
    resolved: number;
  };
  activity: { hour: string; count: number }[];
};
