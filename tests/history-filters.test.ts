import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, dashboard, db, saveEvents } from "../src/lib/db";
import { AccessError, withAccount, type Account } from "../src/lib/access";

const temp = mkdtempSync(join(tmpdir(), "crashguard-history-filters-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
});
const visible = createProject("Historical app", "node");
const hidden = createProject("Private app", "node");
const ids = saveEvents(
  visible.id,
  Array.from({ length: 65 }, (_, i) => ({
    message: `Historical issue ${String(i).padStart(2, "0")}`,
    fingerprint: ["history", String(i)],
    environment: "production",
    release: "old-release",
  })),
);
ids.forEach((id, i) =>
  db()
    .prepare("UPDATE events SET received_at=? WHERE event_id=?")
    .run(
      i === 0
        ? "2000-01-01T00:00:00.000Z"
        : i === 64
          ? "2000-01-01T23:59:59.999Z"
          : "2000-01-01T12:00:00.000Z",
      id,
    ),
);
saveEvents(visible.id, [
  { message: "Current issue", environment: "staging", release: "new-release" },
]);
saveEvents(hidden.id, [{ message: "Private issue" }]);
db().exec(
  "UPDATE issues SET status='resolved' WHERE id=(SELECT MIN(id) FROM issues)",
);
const member: Account = {
  account_id: 2,
  account_name: "Member",
  role: "member",
  user_handle: "member",
};
db().exec("INSERT INTO accounts VALUES(2,'Member','member','member',0)");
db()
  .prepare("INSERT INTO project_members VALUES(?,?,0)")
  .run(visible.id, member.account_id);
const read = (filters: Record<string, string> = {}) =>
  withAccount(member, () => dashboard(new URLSearchParams(filters)));

test("all-time history includes old issues and paginates the complete total in a deterministic order", () => {
  const pages = [read(), read({ offset: "30" }), read({ offset: "60" })];
  assert.deepEqual(
    pages.map((page) => page.issues.length),
    [30, 30, 6],
  );
  assert.ok(
    pages.every((page) => page.total === 66 && page.stats.events === 66),
  );
  assert.equal(
    new Set(pages.flatMap((page) => page.issues.map((issue) => issue.id))).size,
    66,
  );
  assert.equal(pages[0].issues[0].title, "Current issue");
  assert.deepEqual(
    read().issues.map((issue) => issue.id),
    pages[0].issues.map((issue) => issue.id),
  );
  assert.equal(read({ hours: "all" }).total, 66);
  const end = read({ offset: String(Number.MAX_SAFE_INTEGER) });
  assert.equal(end.offset, 60);
  assert.deepEqual(end.issues, pages[2].issues);
});

test("historical calendar ranges include both day boundaries and recent windows stay optional", () => {
  for (const hours of ["24", "168", "720"])
    assert.equal(read({ hours }).total, 1);
  const day = read({ hours: "custom", from: "2000-01-01", to: "2000-01-01" });
  assert.equal(day.total, 65);
  assert.equal(day.stats.events, 65);
  assert.equal(
    read({ hours: "custom", from: "1999-12-31", to: "1999-12-31" }).total,
    0,
  );
  assert.equal(
    read({ hours: "custom", from: "2000-01-02", to: "2000-01-02" }).total,
    0,
  );
  assert.equal(
    read({
      hours: "custom",
      from: "2000-01-01",
      to: "2000-01-01",
      q: "Historical issue 00",
    }).total,
    1,
  );
  assert.equal(
    read({
      hours: "custom",
      from: "2000-01-01",
      to: "2000-01-01",
      q: "Historical issue 64",
    }).total,
    1,
  );
});

test("history preserves status, text, project, release, environment and membership filters", () => {
  assert.equal(read({ status: "unresolved" }).total, 65);
  assert.equal(read({ status: "resolved" }).total, 1);
  assert.equal(
    read({ status: "all", release: "old-release", environment: "production" })
      .total,
    65,
  );
  assert.equal(read({ q: "Historical issue 00", status: "resolved" }).total, 1);
  assert.equal(read({ project: String(hidden.id) }).total, 0);
  assert.equal(
    withAccount(null, () => dashboard(new URLSearchParams({ hours: "all" })))
      .total,
    0,
  );
});

test("invalid calendar dates and reversed or incomplete ranges are rejected", () => {
  for (const filters of [
    { from: "2000-02-30", to: "2000-03-01" },
    { from: "2001-02-29", to: "2001-03-01" },
    { from: "2000-01-02", to: "2000-01-01" },
    { from: "", to: "2000-01-01" },
    { from: "2000-01-01", to: "" },
    { from: "not-a-date", to: "2000-01-01" },
  ])
    assert.throws(() => read({ hours: "custom", ...filters }), AccessError);
});
