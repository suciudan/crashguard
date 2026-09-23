import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, db } from "../src/lib/db";
import { sidebarSections, telemetryDb } from "../src/lib/telemetry";
import { optionalSections } from "../src/lib/types";

const temp = mkdtempSync(join(tmpdir(), "crashguard-sidebar-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
});
const empty = Object.fromEntries(optionalSections.map((key) => [key, false]));

test("a fresh workspace hides all optional sections", () => {
  assert.deepEqual(sidebarSections(), empty);
});

test("each telemetry format reveals only its section, including old records", () => {
  const project = createProject("Sidebar fixture", "node");
  const sql = telemetryDb();
  const insert = sql.prepare(`INSERT INTO telemetry
    (project_id,kind,external_id,name,occurred_at,received_at,size,metadata,payload)
    VALUES (?,?,'fixture','Fixture','2000-01-01','2000-01-01',0,'{}','{}')`);
  for (const [kind, section] of [
    ["transaction", "transactions"],
    ["log", "logs"],
    ["replay_event", "replays"],
    ["replay_recording", "replays"],
    ["profile", "profiles"],
    ["profile_chunk", "profiles"],
    ["attachment", "attachments"],
  ]) {
    insert.run(project.id, kind);
    assert.deepEqual(sidebarSections(), { ...empty, [section]: true });
    sql.prepare("DELETE FROM telemetry").run();
    assert.deepEqual(sidebarSections(), empty);
  }
});

test("configuration sections appear with records and disappear when removed", () => {
  const project = createProject("Configured project", "node");
  const sql = telemetryDb();
  sql
    .prepare(
      "INSERT INTO releases(project_id,version,created_at) VALUES (?,'v1','2000-01-01')",
    )
    .run(project.id);
  sql
    .prepare(
      "INSERT INTO source_maps(project_id,release,filename,debug_id,payload,created_at) VALUES (?,'v1','app.js','','{}','2000-01-01')",
    )
    .run(project.id);
  sql
    .prepare(
      "INSERT INTO alert_rules(project_id,name,url,secret,enabled) VALUES (?,'Disabled alert','https://example.com','fixture',0)",
    )
    .run(project.id);
  assert.deepEqual(sidebarSections(), {
    ...empty,
    releases: true,
    sourcemaps: true,
    alerts: true,
  });
  sql.exec(
    "DELETE FROM releases; DELETE FROM source_maps; DELETE FROM alert_rules;",
  );
  assert.deepEqual(sidebarSections(), empty);
});
