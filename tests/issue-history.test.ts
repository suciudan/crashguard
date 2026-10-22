import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, db, issueDetail, saveEvents } from "../src/lib/db";
import { withAccount, type Account } from "../src/lib/access";

const temp = mkdtempSync(join(tmpdir(), "crashguard-issue-history-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
});

const project = createProject("History", "node");
const hiddenProject = createProject("Private history", "node");
const eventIds = saveEvents(
  project.id,
  Array.from({ length: 125 }, (_, i) => ({
    event_id: (i + 1).toString(16).padStart(32, "0"),
    message: "Long-running issue",
    fingerprint: ["history"],
  })),
);
const foreignEvents = saveEvents(project.id, [{ message: "Different issue" }]);
const hiddenEvents = saveEvents(hiddenProject.id, [
  { message: "Private issue" },
]);
const issueFor = (eventId: string) =>
  (
    db()
      .prepare("SELECT issue_id FROM events WHERE event_id=?")
      .get(eventId) as { issue_id: number }
  ).issue_id;
const issueId = issueFor(eventIds[0]);
const hiddenId = issueFor(hiddenEvents[0]);
// All timestamps tie and are over a year old: IDs must produce stable ordering,
// and occurrence history must not inherit the dashboard's selected time range.
db()
  .prepare("UPDATE events SET received_at=? WHERE issue_id=?")
  .run("2020-01-01T00:00:00.000Z", issueId);

test("every occurrence is reachable through stable pages beyond the latest 50", () => {
  const seen: string[] = [];
  let offset: number | null = 0;
  const counts: number[] = [];
  while (offset !== null) {
    const detail: NonNullable<ReturnType<typeof issueDetail>> =
      issueDetail(issueId, undefined, offset)!;
    assert.equal(detail.eventTotal, 125);
    assert.equal(detail.eventOffset, offset);
    counts.push(detail.events.length);
    seen.push(...detail.events.map((event) => event.event_id));
    offset = detail.nextEventOffset;
  }
  assert.deepEqual(counts, [50, 50, 25]);
  assert.deepEqual(seen, eventIds.toReversed());
  assert.equal(new Set(seen).size, 125);
});

test("shared occurrences outside the current page remain accessible without duplication", () => {
  const oldest = eventIds[0];
  const linked = issueDetail(issueId, oldest)!;
  assert.equal(linked.events.length, 51);
  assert.equal(linked.events.at(-1)?.event_id, oldest);
  assert.equal(linked.eventTotal, 125);
  assert.equal(linked.nextEventOffset, 50);
  const onPage = issueDetail(issueId, oldest, 100)!;
  assert.equal(onPage.events.length, 25);
  assert.equal(
    onPage.events.filter((event) => event.event_id === oldest).length,
    1,
  );
  const newerLink = issueDetail(issueId, eventIds.at(-1), 100)!;
  assert.equal(newerLink.events.length, 26);
  assert.equal(newerLink.events.at(-1)?.event_id, eventIds.at(-1));
});

test("occurrence pages and linked events respect issue and project boundaries", () => {
  const member: Account = {
    account_id: 2,
    account_name: "History reader",
    role: "member",
    user_handle: "history-reader",
  };
  db()
    .prepare("INSERT INTO accounts VALUES(?,?,?,?,0)")
    .run(
      member.account_id,
      member.account_name,
      member.user_handle,
      member.role,
    );
  db()
    .prepare("INSERT INTO project_members VALUES(?,?,0)")
    .run(project.id, member.account_id);
  withAccount(member, () => {
    assert.equal(issueDetail(issueId, undefined, 100)?.events.length, 25);
    assert.equal(issueDetail(hiddenId, hiddenEvents[0], 100), null);
    for (const eventId of [...foreignEvents, ...hiddenEvents]) {
      const detail = issueDetail(issueId, eventId, 100)!;
      assert.equal(detail.events.length, 25);
      assert.ok(!detail.events.some((event) => event.event_id === eventId));
    }
  });
  assert.equal(
    withAccount(null, () => issueDetail(issueId, eventIds[0], 100)),
    null,
  );
});

test("invalid offsets reset safely and out-of-range offsets reach the final page", () => {
  for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const detail = issueDetail(issueId, undefined, offset)!;
    assert.equal(detail.eventOffset, 0);
    assert.equal(detail.events.length, 50);
  }
  for (const offset of [125, 1000001, Number.MAX_SAFE_INTEGER]) {
    const detail = issueDetail(issueId, undefined, offset)!;
    assert.equal(detail.eventOffset, 100);
    assert.equal(detail.events.length, 25);
    assert.equal(detail.nextEventOffset, null);
  }
  assert.equal(issueDetail(issueId, undefined, 75)?.eventOffset, 50);
});

test("issues without occurrences return an empty page and no older page", () => {
  const [eventId] = saveEvents(project.id, [{ message: "Empty issue" }]);
  const emptyId = issueFor(eventId);
  db().prepare("DELETE FROM events WHERE issue_id=?").run(emptyId);
  const detail = issueDetail(emptyId, undefined, 100)!;
  assert.equal(detail.eventTotal, 0);
  assert.equal(detail.eventOffset, 0);
  assert.equal(detail.nextEventOffset, null);
  assert.deepEqual(detail.events, []);
});
