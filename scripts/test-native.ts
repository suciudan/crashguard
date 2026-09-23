import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createProject, db } from "./test-data";
import { saveEnvelope, telemetryDb } from "../src/lib/telemetry";
import { runJobs } from "../src/lib/jobs";
async function main() {
  if (!process.env.TEST_MINIDUMP_PATH || !process.env.SYMBOLICATOR_URL)
    throw new Error(
      "Set TEST_MINIDUMP_PATH to a real minidump fixture and SYMBOLICATOR_URL to the test Symbolicator.",
    );
  const project = createProject("Native integration", "other"),
    eventId = randomUUID().replaceAll("-", "");
  const payload = readFileSync(process.env.TEST_MINIDUMP_PATH);
  saveEnvelope(project.id, { event_id: eventId }, [
    {
      type: "attachment",
      headers: {
        type: "attachment",
        attachment_type: "event.minidump",
        filename: "crash.dmp",
      },
      payload,
    },
  ]);
  for (let i = 0; i < 20; i++) {
    await runJobs();
    const job = telemetryDb()
      .prepare(
        "SELECT status,error,result FROM jobs WHERE kind='minidump' AND json_extract(payload,'$.eventId')=?",
      )
      .get(eventId) as { status: string; error: string; result: string };
    if (job.status === "complete") {
      const result = JSON.parse(job.result);
      assert.ok(result.stacktraces.length > 0);
      assert.ok(
        result.stacktraces.some(
          (s: { frames: unknown[] }) => s.frames.length > 0,
        ),
      );
      assert.ok(
        db().prepare("SELECT 1 FROM events WHERE event_id=?").get(eventId),
      );
      console.log(
        `Real minidump processed: ${result.stacktraces.length} native thread stack traces.`,
      );
      db().close();
      process.exit(0);
    }
    if (job.status === "failed") throw new Error(job.error);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Native processing did not finish within the test deadline.");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
