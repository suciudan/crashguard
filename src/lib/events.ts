import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SentryEvent } from "./types";
const frame = z
  .object({
    filename: z.string().optional(),
    abs_path: z.string().optional(),
    function: z.string().optional(),
    lineno: z.number().optional(),
    colno: z.number().optional(),
    in_app: z.boolean().optional(),
    context_line: z.string().optional(),
    pre_context: z.array(z.string()).optional(),
    post_context: z.array(z.string()).optional(),
  })
  .passthrough();
const stacktrace = z
  .object({ frames: z.array(frame).max(500).optional() })
  .passthrough();
const message = z.union([
  z.string(),
  z
    .object({
      formatted: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
]);
const breadcrumb = z
  .object({
    timestamp: z.union([z.string(), z.number()]).optional(),
    category: z.string().optional(),
    message: z.string().optional(),
    level: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const schema = z
  .object({
    event_id: z
      .string()
      .regex(
        /^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12})$/,
      )
      .optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    platform: z.string().max(100).optional(),
    level: z
      .enum(["fatal", "error", "warning", "info", "debug", "log"])
      .optional(),
    message: message.optional(),
    logentry: z
      .object({
        formatted: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    exception: z
      .object({
        values: z
          .array(
            z
              .object({
                type: z.string().optional(),
                value: z.string().optional(),
                stacktrace: stacktrace.optional(),
                mechanism: z.record(z.string(), z.unknown()).optional(),
              })
              .passthrough(),
          )
          .max(50)
          .optional(),
      })
      .passthrough()
      .optional(),
    stacktrace: stacktrace.optional(),
    culprit: z.string().optional(),
    transaction: z.string().optional(),
    environment: z.string().max(200).optional(),
    release: z.string().max(300).optional(),
    fingerprint: z.array(z.string()).max(100).optional(),
    user: z.record(z.string(), z.unknown()).optional(),
    tags: z
      .union([z.record(z.string(), z.string()), z.array(z.array(z.string()))])
      .optional(),
    breadcrumbs: z
      .union([
        z.array(breadcrumb),
        z.object({ values: z.array(breadcrumb).optional() }).passthrough(),
      ])
      .optional(),
    contexts: z.record(z.string(), z.unknown()).optional(),
    request: z.record(z.string(), z.unknown()).optional(),
    sdk: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export function validateEvent(value: unknown): SentryEvent {
  return schema.parse(value) as SentryEvent;
}
const sensitive =
  /authorization|cookie|password|passwd|secret|token|api[_-]?key/i;
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 30) return "[Truncated]";
  if (Array.isArray(value)) {
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      sensitive.test(value[0])
    )
      return [value[0], "[Filtered]"];
    return value.map((v) => scrub(v, depth + 1));
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        sensitive.test(k) ? "[Filtered]" : scrub(v, depth + 1),
      ]),
    );
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()])
        if (sensitive.test(key)) url.searchParams.set(key, "[Filtered]");
      return url.toString();
    } catch {
      /* Keep non-URL strings. */
    }
  }
  return value;
}
export function normalizeEvent(input: SentryEvent) {
  const event = scrub(input) as SentryEvent;
  const exception = event.exception?.values?.at(-1);
  const frames =
    exception?.stacktrace?.frames ?? event.stacktrace?.frames ?? [];
  const inApp = frames.filter((f) => f.in_app !== false).slice(-5);
  const msg =
    typeof event.message === "string"
      ? event.message
      : (event.message?.formatted ?? event.message?.message);
  const title = (
    exception
      ? [exception.type || "Error", exception.value].filter(Boolean).join(": ")
      : msg ||
        event.logentry?.formatted ||
        event.logentry?.message ||
        event.transaction ||
        "Untitled event"
  ).slice(0, 1000);
  const base = JSON.stringify([
    exception?.type || "message",
    inApp.length
      ? inApp.map((f) => [f.filename || f.abs_path, f.function])
      : title,
  ]);
  const parts = event.fingerprint?.length
    ? event.fingerprint.map((p) => (p === "{{ default }}" ? base : p))
    : [base];
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
  const date = new Date(
    typeof event.timestamp === "number"
      ? event.timestamp * 1000
      : event.timestamp || Date.now(),
  );
  const occurred = Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
  const identity = event.user?.id ?? event.user?.email ?? event.user?.username;
  const userKey =
    identity == null
      ? null
      : createHash("sha256").update(String(identity)).digest("hex");
  event.event_id = (event.event_id || randomUUID())
    .replaceAll("-", "")
    .toLowerCase();
  return {
    event,
    fingerprint,
    title,
    culprit: (
      event.culprit ||
      event.transaction ||
      inApp.at(-1)?.filename ||
      ""
    ).slice(0, 1000),
    level: event.level || "error",
    occurred,
    userKey,
  };
}
