import {
  TraceMap,
  originalPositionFor,
  sourceContentFor,
} from "@jridgewell/trace-mapping";
import { telemetryDb } from "./telemetry";
import type { Frame, SentryEvent } from "./types";

export function uploadSourceMap(
  project: number,
  release: string,
  filename: string,
  debugId: string,
  content: string,
) {
  const raw = JSON.parse(content);
  if (
    raw.version !== 3 ||
    !Array.isArray(raw.sources) ||
    typeof raw.mappings !== "string"
  )
    throw new Error("Upload a version 3 source map with sources and mappings.");
  const map = new TraceMap(raw);
  originalPositionFor(map, { line: 1, column: 0 });
  const debug = String(
    debugId || raw.debug_id || raw.debugId || "",
  ).toLowerCase();
  if (debug && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(debug))
    throw new Error("Invalid source map debug ID.");
  if (!debug && (!release || !filename))
    throw new Error(
      "Provide a debug ID, or both the release and generated file URL.",
    );
  telemetryDb()
    .prepare(
      `INSERT INTO source_maps(project_id,release,filename,debug_id,payload,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,release,filename,debug_id) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at`,
    )
    .run(project, release, filename, debug, content, new Date().toISOString());
}
// Resolve stored maps only. Ingested frame URLs never trigger outbound requests.
export function symbolicateEvent(
  project: number,
  input: SentryEvent,
): SentryEvent {
  const event = structuredClone(input);
  const sql = telemetryDb();
  const images =
    (
      event.debug_meta as {
        images?: { code_file?: string; debug_id?: string }[];
      }
    )?.images || [];
  const cache = new Map<string, TraceMap | null>();
  const resolve = (frame: Frame) => {
    const path = frame.abs_path || frame.filename || "";
    if (!frame.lineno || !path) return;
    const debug = images
      .find((image) => image.code_file === path)
      ?.debug_id?.toLowerCase();
    const key = debug || `${event.release}:${path}`;
    if (!cache.has(key)) {
      const row = debug
        ? sql
            .prepare(
              "SELECT payload FROM source_maps WHERE project_id=? AND debug_id=? ORDER BY id DESC LIMIT 1",
            )
            .get(project, debug)
        : sql
            .prepare(
              "SELECT payload FROM source_maps WHERE project_id=? AND release=? AND filename=? ORDER BY id DESC LIMIT 1",
            )
            .get(project, event.release || "", path);
      try {
        cache.set(
          key,
          row
            ? new TraceMap(JSON.parse((row as { payload: string }).payload))
            : null,
        );
      } catch {
        cache.set(key, null);
      }
    }
    const map = cache.get(key);
    if (!map) return;
    try {
      const original = originalPositionFor(map, {
        line: frame.lineno,
        column: Math.max(0, (frame.colno || 1) - 1),
      });
      if (!original.source || original.line === null) return;
      Object.assign(frame, {
        original: { ...frame },
        filename: original.source,
        abs_path: original.source,
        function: original.name || frame.function,
        lineno: original.line,
        colno: (original.column || 0) + 1,
        symbolicated: true,
      });
      const source = sourceContentFor(map, original.source);
      if (source) {
        const lines = source.split("\n");
        frame.context_line = lines[original.line - 1];
        frame.pre_context = lines.slice(
          Math.max(0, original.line - 4),
          original.line - 1,
        );
        frame.post_context = lines.slice(original.line, original.line + 3);
      }
    } catch {
      /* Leave the original frame available when no mapping matches. */
    }
  };
  event.stacktrace?.frames?.forEach(resolve);
  event.exception?.values?.forEach((value) =>
    value.stacktrace?.frames?.forEach(resolve),
  );
  return event;
}
