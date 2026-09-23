"use client";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, Download, RefreshCw } from "lucide-react";
import {
  getTelemetry,
  getTelemetryDetail,
  downloadAttachment,
  getReplay,
  retryJob,
} from "@/app/actions/telemetry";
import { action, relative } from "./shared";
import { AppLink, useAppNavigation } from "./navigation";
import type { Project } from "@/lib/types";
import type { TelemetryRow } from "@/lib/telemetry";

export const telemetryViews: Record<string, { title: string; kind: string }> = {
  transactions: { title: "Performance", kind: "transaction" },
  logs: { title: "Logs", kind: "log" },
  replays: { title: "Replays", kind: "replay_event" },
  profiles: { title: "Profiles", kind: "profile_chunk" },
  attachments: { title: "Attachments", kind: "attachment" },
};
export function Telemetry({
  view,
  projects,
}: {
  view: string;
  projects: Project[];
}) {
  const { params, href, update } = useAppNavigation();
  const project = Number(params.get("project")) || undefined;
  const kind =
    view === "profiles" && params.get("profileType") === "transaction"
      ? "profile"
      : telemetryViews[view].kind;
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const selected = Number(params.get("record")) || 0;
  const q = params.get("q") || "";
  const trace = params.get("trace") || undefined;
  const event = params.get("relatedEvent") || undefined;
  const [list, setList] = useState<{
    total: number;
    rows: Omit<TelemetryRow, "payload">[];
  }>({ total: 0, rows: [] });
  const [detail, setDetail] =
    useState<Awaited<ReturnType<typeof getTelemetryDetail>>["data"]>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await action(
          getTelemetry({ project, kind, q, offset, trace, event }),
        );
        if (active) {
          setList(result);
          setError("");
          setLoading(false);
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };
    setLoading(true);
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project, kind, q, offset, trace, event, refresh]);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    if (selected)
      void action(getTelemetryDetail(selected))
        .then((d) => {
          if (active) setDetail(d);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [selected, refresh]);
  return (
    <div className="telemetry-view">
      <div className="filterbar">
        <select
          className="text-input"
          aria-label="Telemetry project"
          value={project || ""}
          onChange={(e) =>
            update({ project: e.target.value, offset: null, record: null })
          }
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="text-input"
          aria-label="Search telemetry"
          placeholder="Search…"
          value={q}
          onChange={(e) => update({ q: e.target.value, offset: null }, true)}
        />
        {view === "profiles" && (
          <select
            className="text-input"
            aria-label="Profile type"
            value={params.get("profileType") || "continuous"}
            onChange={(e) =>
              update({
                profileType: e.target.value,
                offset: null,
                record: null,
              })
            }
          >
            <option value="continuous">Continuous profiles</option>
            <option value="transaction">Transaction profiles</option>
          </select>
        )}
        <button
          className="button"
          aria-label="Refresh telemetry"
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {(trace || event) && (
        <p className="telemetry-filter">
          {trace ? `Trace ${trace}` : `Event ${event}`}{" "}
          <AppLink
            href={href({ trace: null, relatedEvent: null, offset: null })}
          >
            Clear filter
          </AppLink>
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {selected ? (
        <>
          <AppLink className="button" href={href({ record: null })}>
            <ArrowLeft size={15} />
            Back to list
          </AppLink>
          {detail && (
            <RecordDetail row={detail.row} processing={detail.processing} />
          )}
        </>
      ) : (
        <section className="telemetry-card">
          <div className="telemetry-table-wrap">
            <table className="telemetry-table">
              <thead>
                <tr>
                  <th>{view === "logs" ? "Message" : "Name"}</th>
                  <th>Project</th>
                  <th>{view === "transactions" ? "Duration" : "Size"}</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <AppLink href={href({ record: row.id })}>
                        {row.name}
                      </AppLink>
                      {row.environment && <small>{row.environment}</small>}
                    </td>
                    <td>
                      {projects.find((p) => p.id === row.project_id)?.name}
                    </td>
                    <td>
                      {view === "transactions"
                        ? `${row.duration.toFixed(1)} ms`
                        : `${(row.size / 1024).toFixed(1)} KB`}
                    </td>
                    <td>{relative(row.received_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.rows.length && (
            <div className="empty-state">
              <Activity size={28} />
              <h2>{loading ? "Loading…" : "No telemetry in this view"}</h2>
              <p>Data appears here when your Sentry SDK sends it.</p>
            </div>
          )}
          <div className="table-footer">
            <span>{list.total} records</span>
            <div>
              <button
                className="button"
                disabled={!offset}
                onClick={() => update({ offset: Math.max(0, offset - 50) })}
              >
                Previous
              </button>
              <button
                className="button"
                disabled={offset + 50 >= list.total}
                onClick={() => update({ offset: offset + 50 })}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
function RecordDetail({
  row,
  processing,
}: {
  row: TelemetryRow;
  processing?: {
    id: number;
    status: string;
    error: string;
    result: unknown;
  } | null;
}) {
  const { href } = useAppNavigation();
  const [error, setError] = useState("");
  const payload = row.payload;
  return (
    <section className="telemetry-card telemetry-detail" key={row.id}>
      <h2>{row.name}</h2>
      <p className="subtle">
        {row.kind} · {new Date(row.occurred_at).toLocaleString()} ·{" "}
        {row.environment || "No environment"}
      </p>
      <div className="telemetry-links">
        {row.trace_id && (
          <>
            <AppLink
              className="button"
              href={href({
                view: "transactions",
                trace: row.trace_id,
                record: null,
                offset: null,
                relatedEvent: null,
              })}
            >
              Trace transactions
            </AppLink>
            <AppLink
              className="button"
              href={href({
                view: "logs",
                trace: row.trace_id,
                record: null,
                offset: null,
                relatedEvent: null,
              })}
            >
              Trace logs
            </AppLink>
          </>
        )}
        {row.kind === "attachment" && (
          <button
            className="button"
            onClick={async () => {
              try {
                const file = await action(downloadAttachment(row.id));
                const bytes = Uint8Array.from(atob(file.data), (c) =>
                  c.charCodeAt(0),
                );
                const url = URL.createObjectURL(
                  new Blob([bytes], { type: "application/octet-stream" }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = file.name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Download size={15} />
            Download attachment
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {processing && (
        <div className="processing-state">
          <strong>Native symbolication: {processing.status}</strong>
          {processing.error && <p>{processing.error}</p>}
          {processing.status === "failed" && (
            <button
              className="button"
              onClick={async () => {
                try {
                  await action(retryJob(processing.id));
                  setError("Retry queued. Refresh to check progress.");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Retry processing
            </button>
          )}
          {!!processing.result && (
            <details>
              <summary>Native stack traces</summary>
              <pre>{JSON.stringify(processing.result, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      {row.kind === "transaction" && <Waterfall payload={payload} />}
      {(row.kind === "profile" || row.kind === "profile_chunk") && (
        <Profile payload={payload} />
      )}
      {(row.kind === "replay_event" || row.kind === "replay_recording") && (
        <Replay id={row.id} />
      )}
      {row.kind === "log" && (
        <div className="log-detail">
          <span className="status-pill">{String(payload.level)}</span>
          <p>{String(payload.body)}</p>
          <h3>Attributes</h3>
          <pre>{JSON.stringify(payload.attributes || {}, null, 2)}</pre>
        </div>
      )}
      <details className="raw-telemetry">
        <summary>Raw payload</summary>
        <pre>{JSON.stringify(payload, null, 2)}</pre>
      </details>
    </section>
  );
}
function Waterfall({ payload }: { payload: Record<string, unknown> }) {
  const spans = (payload.spans || []) as {
    span_id: string;
    parent_span_id?: string;
    op?: string;
    description?: string;
    start_timestamp: number;
    timestamp: number;
    status?: string;
  }[];
  const start = Number(payload.start_timestamp),
    end = Number(payload.timestamp),
    duration = Math.max(end - start, 0.000001);
  return (
    <div className="waterfall">
      <h3>Spans · {spans.length}</h3>
      <p>{(duration * 1000).toFixed(1)} ms total</p>
      {spans.map((span, i) => (
        <div className="span-row" key={`${span.span_id}-${i}`}>
          <details>
            <summary>
              {span.op || "span"} · {span.description || span.span_id}
            </summary>
            <pre>{JSON.stringify(span, null, 2)}</pre>
          </details>
          <div className="span-track">
            <div
              style={{
                marginLeft: `${Math.max(0, Math.min(100, ((span.start_timestamp - start) / duration) * 100))}%`,
                width: `${Math.max(0.3, Math.min(100, ((span.timestamp - span.start_timestamp) / duration) * 100))}%`,
              }}
              title={`${((span.timestamp - span.start_timestamp) * 1000).toFixed(1)} ms`}
            />
          </div>
          <span>
            {((span.timestamp - span.start_timestamp) * 1000).toFixed(1)} ms
          </span>
        </div>
      ))}
    </div>
  );
}
function Profile({ payload }: { payload: Record<string, unknown> }) {
  const profile = (payload.profile || payload) as {
    frames: Record<string, unknown>[];
    stacks: number[][];
    samples: {
      stack_id: number;
      thread_id?: string;
      elapsed_since_start_ns?: string;
      timestamp?: number;
    }[];
  };
  const [thread, setThread] = useState("");
  const threads = [
    ...new Set(profile.samples.map((s) => String(s.thread_id || "main"))),
  ];
  const samples = profile.samples.filter(
    (s) => !thread || String(s.thread_id || "main") === thread,
  );
  const counts = new Map<number, number>();
  samples.forEach((sample) =>
    new Set(profile.stacks[sample.stack_id]).forEach((frame) =>
      counts.set(frame, (counts.get(frame) || 0) + 1),
    ),
  );
  const sorted = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 100);
  return (
    <div className="profile-view">
      <h3>Sampled call stacks</h3>
      <label>
        Thread{" "}
        <select
          className="text-input"
          value={thread}
          onChange={(e) => setThread(e.target.value)}
        >
          <option value="">All threads</option>
          {threads.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <p>{samples.length.toLocaleString()} samples · Inclusive sample share</p>
      {sorted.map(([index, count]) => {
        const frame = profile.frames[index];
        return (
          <div className="profile-row" key={index}>
            <span>
              {String(
                frame.function ||
                  frame.name ||
                  frame.instruction_addr ||
                  "anonymous",
              )}
              <small>
                {String(frame.filename || frame.abs_path || frame.module || "")}
              </small>
            </span>
            <div className="span-track">
              <div
                style={{
                  width: `${(count / Math.max(samples.length, 1)) * 100}%`,
                }}
              />
            </div>
            <span>
              {((count / Math.max(samples.length, 1)) * 100).toFixed(1)}%
            </span>
          </div>
        );
      })}
      <details>
        <summary>First 100 samples</summary>
        <pre>
          {samples
            .slice(0, 100)
            .map(
              (s) =>
                `${s.elapsed_since_start_ns || s.timestamp || ""} [${s.thread_id || "main"}] ${profile.stacks[s.stack_id].map((i) => String(profile.frames[i].function || profile.frames[i].name || profile.frames[i].instruction_addr || "anonymous")).join(" → ")}`,
            )
            .join("\n")}
        </pre>
      </details>
    </div>
  );
}
function Replay({ id }: { id: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const player = useRef<import("rrweb").Replayer | null>(null);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [duration, setDuration] = useState(0),
    [incomplete, setIncomplete] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [recording, { Replayer }] = await Promise.all([
          action(getReplay(id)),
          import("rrweb"),
        ]);
        if (!active) return;
        if (
          recording.events.length < 2 ||
          !recording.events.some((e) => e.type === 2)
        )
          throw new Error("No full snapshot has arrived for this replay yet.");
        const root = frame.current?.contentDocument?.getElementById("replay");
        if (!root)
          throw new Error("Replay frame is not ready. Reopen this recording.");
        setIncomplete(recording.incomplete);
        const instance = new Replayer(
          recording.events as ConstructorParameters<typeof Replayer>[0],
          {
            root,
            showWarning: false,
            showDebug: false,
            mouseTail: false,
            UNSAFE_replayCanvas: false,
          },
        );
        const fit = () => {
          const width = instance.iframe.width
            ? Number(instance.iframe.width)
            : instance.iframe.clientWidth;
          if (width && root.clientWidth) {
            instance.wrapper.style.transformOrigin = "top left";
            instance.wrapper.style.transform = `scale(${Math.min(1, root.clientWidth / width)})`;
          }
        };
        instance.on("resize", fit);
        fit();
        player.current = instance;
        setDuration(instance.getMetaData().totalTime);
        setReady(true);
        instance.pause(0);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    })();
    return () => {
      active = false;
      player.current?.destroy();
      player.current = null;
    };
  }, [id]);
  return (
    <div className="replay-view">
      <h3>Session replay</h3>
      {incomplete && (
        <p>
          Some recording segments have not arrived; playback may contain gaps.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="telemetry-links">
        <button
          className="button"
          disabled={!ready}
          onClick={() => {
            const p = player.current;
            if (p)
              p.play(p.getCurrentTime() >= duration ? 0 : p.getCurrentTime());
          }}
        >
          Play
        </button>
        <button
          className="button"
          disabled={!ready}
          onClick={() => player.current?.pause()}
        >
          Pause
        </button>
        <label>
          Seek{" "}
          <input
            aria-label="Replay position"
            type="range"
            min={0}
            max={duration}
            defaultValue={0}
            disabled={!ready}
            onChange={(e) => player.current?.pause(Number(e.target.value))}
          />
        </label>
        <span>{(duration / 1000).toFixed(1)}s</span>
      </div>
      <iframe
        ref={frame}
        title="Session replay"
        sandbox="allow-same-origin"
        srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>body{margin:0;background:#fff}iframe{border:0}.replayer-wrapper{position:relative}.replayer-mouse{position:absolute;width:12px;height:12px;border-radius:100%;background:#4c9fff;z-index:9999}</style></head><body><div id="replay"></div></body></html>`}
      />
    </div>
  );
}
