import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { timingSafeEqual } from "node:crypto";
import { getProject, takeRateLimit } from "./db";
import { saveEnvelope, type Item } from "./telemetry";
export const MAX_BYTES = 25 * 1024 * 1024;
export class IngestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function objectJson(bytes: Buffer): Record<string, unknown> {
  try {
    const result = JSON.parse(bytes.toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error();
    return result;
  } catch {
    throw new IngestError("Expected a JSON object");
  }
}
export function parseEnvelope(body: Buffer) {
  let cursor = 0;
  function line() {
    const end = body.indexOf(10, cursor);
    const result = body.subarray(cursor, end < 0 ? body.length : end);
    cursor = end < 0 ? body.length : end + 1;
    return result;
  }
  const headers = objectJson(line());
  const items: Item[] = [];
  while (cursor < body.length) {
    if (items.length >= 100) throw new IngestError("Too many envelope items");
    const item = objectJson(line());
    if (typeof item.type !== "string")
      throw new IngestError("Missing item type");
    let payload: Buffer;
    if (item.length !== undefined) {
      if (
        !Number.isSafeInteger(item.length) ||
        Number(item.length) < 0 ||
        cursor + Number(item.length) > body.length
      )
        throw new IngestError("Invalid item length");
      payload = body.subarray(cursor, cursor + Number(item.length));
      cursor += Number(item.length);
      if (cursor < body.length && body[cursor++] !== 10)
        throw new IngestError("Invalid item delimiter");
    } else {
      payload = line();
    }
    items.push({ type: item.type, headers: item, payload });
  }
  return { headers, items };
}
export async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new IngestError("Empty request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new IngestError("Payload exceeds 25 MB", 413);
    }
    chunks.push(part.value);
  }
  let body = Buffer.concat(chunks);
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  try {
    const options = { maxOutputLength: MAX_BYTES };
    if (encoding === "gzip") body = gunzipSync(body, options);
    else if (encoding === "deflate") body = inflateSync(body, options);
    else if (encoding === "br") body = brotliDecompressSync(body, options);
    else if (encoding && encoding !== "identity")
      throw new IngestError("Unsupported content encoding", 415);
  } catch (e) {
    if (e instanceof IngestError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      throw new IngestError("Payload exceeds 25 MB", 413);
    throw new IngestError("Invalid compressed payload");
  }
  if (body.length > MAX_BYTES)
    throw new IngestError("Payload exceeds 25 MB", 413);
  return body;
}
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "X-Sentry-Rate-Limits, Retry-After",
  "Cache-Control": "no-store",
};
export async function ingest(request: Request, projectId: string) {
  try {
    if (!/^\d+$/.test(projectId)) throw new IngestError("Unknown project", 404);
    const project = getProject(Number(projectId));
    if (!project) throw new IngestError("Unknown project", 404);
    const body = await readBody(request);
    const envelope = parseEnvelope(body);
    const keys: string[] = [];
    const queryKey = new URL(request.url).searchParams.get("sentry_key");
    if (queryKey) keys.push(queryKey);
    const auth = request.headers.get("x-sentry-auth");
    const headerKey = auth?.match(
      /(?:^Sentry\s+|,\s*)sentry_key=([^,\s]+)/,
    )?.[1];
    if (headerKey) keys.push(headerKey);
    if (envelope.headers.dsn !== undefined) {
      try {
        const dsn = new URL(String(envelope.headers.dsn));
        if (dsn.pathname.split("/").filter(Boolean).at(-1) !== projectId)
          throw new Error();
        keys.push(dsn.username);
      } catch {
        throw new IngestError("Invalid envelope DSN", 401);
      }
    }
    if (
      !keys.length ||
      keys.some(
        (key) =>
          Buffer.byteLength(key) !== Buffer.byteLength(project.public_key) ||
          !timingSafeEqual(Buffer.from(key), Buffer.from(project.public_key)),
      )
    )
      throw new IngestError("Invalid project key", 401);
    if (!takeRateLimit(project.id))
      return Response.json(
        { error: "Project rate limit exceeded" },
        {
          status: 429,
          headers: {
            ...cors,
            "Retry-After": "60",
            "X-Sentry-Rate-Limits": "60::organization",
          },
        },
      );
    try {
      return Response.json(
        saveEnvelope(project.id, envelope.headers, envelope.items),
        { headers: cors },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        String(error.code).startsWith("SQLITE")
      )
        throw error;
      throw new IngestError("Invalid telemetry payload");
    }
  } catch (error) {
    if (error instanceof IngestError)
      return Response.json(
        { error: error.message },
        { status: error.status, headers: cors },
      );
    console.error(
      "Ingestion failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    return Response.json(
      { error: "Unable to store event" },
      { status: 500, headers: cors },
    );
  }
}
