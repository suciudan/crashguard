import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { migrateAccounts } from "../src/lib/accounts-schema";
import {
  withAccount,
  requireOwner,
  requireProject,
  type Account,
} from "../src/lib/access";
import {
  createProject,
  dashboard,
  db,
  issueDetail,
  saveEvents,
  setStatus,
} from "../src/lib/db";
import {
  createInvitation,
  consumeInvitation,
  findInvitation,
} from "../src/lib/invitations";
import { hashToken, saveChallenge, takeChallenge } from "../src/lib/auth";
import {
  listTelemetry,
  sidebarSections,
  telemetryDb,
  telemetryDetail,
} from "../src/lib/telemetry";

const temp = mkdtempSync(join(tmpdir(), "crashguard-invitations-"));
process.env.DATABASE_PATH = join(temp, "test.sqlite");
process.env.AUTH_ORIGIN = "http://localhost:5000";
after(() => {
  db().close();
  rmSync(temp, { recursive: true, force: true });
});
const owner: Account = {
  account_id: 1,
  account_name: "Owner",
  role: "owner",
  user_handle: "owner",
};
const colleague: Account = {
  account_id: 2,
  account_name: "Alex",
  role: "member",
  user_handle: "alex",
};
db().prepare("INSERT INTO accounts VALUES(2,'Alex','alex','member',0)").run();
const first = createProject("Invited project", "node");
const second = createProject("Private project", "node");

test("migration preserves existing credential ownership and WebAuthn identity, and runs only once", () => {
  const legacy = new Database(":memory:");
  legacy.pragma("foreign_keys=ON");
  legacy.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY);
    CREATE TABLE passkeys(id TEXT PRIMARY KEY);
    CREATE TABLE auth_challenges(token_hash TEXT PRIMARY KEY);
    CREATE TABLE auth_identity(id INTEGER PRIMARY KEY,user_id TEXT);
    INSERT INTO auth_identity VALUES(1,'existing-user-handle');
    INSERT INTO passkeys VALUES('existing-key');`);
  migrateAccounts(legacy);
  assert.deepEqual(
    legacy.prepare("SELECT user_handle,role FROM accounts").get(),
    { user_handle: "existing-user-handle", role: "owner" },
  );
  assert.deepEqual(legacy.prepare("SELECT * FROM account_passkeys").get(), {
    credential_id: "existing-key",
    account_id: 1,
  });
  legacy.prepare("INSERT INTO passkeys VALUES('unassigned-key')").run();
  migrateAccounts(legacy);
  assert.deepEqual(
    legacy.prepare("SELECT COUNT(*) AS n FROM account_passkeys").get(),
    { n: 1 },
  );
  legacy.close();
});

test("only owners create invitations, tokens are hashed, expired and revoked links fail", () => {
  assert.throws(() => withAccount(colleague, () => createInvitation(first.id)));
  assert.throws(() => withAccount(null, requireOwner));
  const link = withAccount(owner, () => createInvitation(first.id));
  assert.match(link.token, /^[a-f0-9]{64}$/);
  assert.equal(link.id, findInvitation(link.token).id);
  assert.equal(findInvitation(link.token).project_id, first.id);
  assert.ok(
    db()
      .prepare("SELECT 1 FROM project_invitations WHERE token_hash=?")
      .get(hashToken(link.token)),
  );
  assert.equal(
    db()
      .prepare("SELECT 1 FROM project_invitations WHERE token_hash=?")
      .get(link.token),
    undefined,
  );
  db()
    .prepare("UPDATE project_invitations SET expires_at=0 WHERE token_hash=?")
    .run(hashToken(link.token));
  assert.throws(() => findInvitation(link.token));
  const revoked = withAccount(owner, () => createInvitation(first.id));
  db()
    .prepare("UPDATE project_invitations SET revoked_at=? WHERE token_hash=?")
    .run(Date.now(), hashToken(revoked.token));
  assert.throws(() => findInvitation(revoked.token));
  assert.throws(() => findInvitation("invalid"));
});

test("acceptance is single-use and membership rolls back when enrollment fails", () => {
  const link = withAccount(owner, () => createInvitation(first.id));
  assert.throws(() =>
    db()
      .transaction(() => {
        consumeInvitation(hashToken(link.token), colleague.account_id);
        throw new Error("Credential insertion failed");
      })
      .immediate(),
  );
  assert.deepEqual(
    db().prepare("SELECT COUNT(*) AS n FROM project_members").get(),
    { n: 0 },
  );
  assert.ok(findInvitation(link.token));
  assert.equal(
    db()
      .transaction(() =>
        consumeInvitation(hashToken(link.token), colleague.account_id),
      )
      .immediate(),
    first.id,
  );
  assert.throws(() =>
    db()
      .transaction(() =>
        consumeInvitation(hashToken(link.token), colleague.account_id),
      )
      .immediate(),
  );
  assert.deepEqual(
    db().prepare("SELECT COUNT(*) AS n FROM project_members").get(),
    { n: 1 },
  );
});

test("members cannot enumerate other projects, issues, environments, telemetry, or navigation", async () => {
  saveEvents(first.id, [
    { message: "Visible error", environment: "production" },
  ]);
  saveEvents(second.id, [
    { message: "Private error", environment: "secret-environment" },
  ]);
  const ownIssue = db()
    .prepare("SELECT id FROM issues WHERE project_id=?")
    .get(first.id) as { id: number };
  const privateIssue = db()
    .prepare("SELECT id FROM issues WHERE project_id=?")
    .get(second.id) as { id: number };
  const hiddenTelemetry = Number(
    telemetryDb()
      .prepare(
        "INSERT INTO telemetry(project_id,kind,external_id,name,occurred_at,received_at,size,metadata,payload) VALUES(?,'log','private','Secret log','2026','2026',1,'{}','{}')",
      )
      .run(second.id).lastInsertRowid,
  );
  await Promise.all([
    withAccount(colleague, async () => {
      await Promise.resolve();
      const visible = dashboard(new URLSearchParams());
      assert.deepEqual(
        visible.projects.map((p) => p.id),
        [first.id],
      );
      assert.equal(visible.stats.events, 1);
      assert.ok(!visible.environments.includes("secret-environment"));
      assert.equal(
        dashboard(new URLSearchParams({ project: String(second.id) })).stats
          .events,
        0,
      );
      assert.equal(issueDetail(privateIssue.id), null);
      assert.equal(setStatus(privateIssue.id, "resolved"), 0);
      assert.equal(setStatus(ownIssue.id, "resolved"), 1);
      assert.throws(() => requireProject(second.id));
      assert.equal(listTelemetry({ kind: "log" }).total, 0);
      assert.equal(telemetryDetail(hiddenTelemetry), null);
      assert.equal(sidebarSections().logs, false);
    }),
    withAccount(owner, async () => {
      await Promise.resolve();
      assert.equal(dashboard(new URLSearchParams()).stats.events, 2);
      assert.ok(issueDetail(privateIssue.id));
      assert.equal(listTelemetry({ kind: "log" }).total, 1);
      assert.equal(sidebarSections().logs, true);
    }),
  ]);
  db()
    .prepare("DELETE FROM project_members WHERE account_id=?")
    .run(colleague.account_id);
  withAccount(colleague, () => {
    assert.equal(dashboard(new URLSearchParams()).projects.length, 0);
    assert.equal(issueDetail(ownIssue.id), null);
  });
});

test("enrollment context is bound to the browser challenge and deleted on consumption", () => {
  const values = new Map<string, string>();
  const jar = {
    get: (name: string) =>
      values.has(name) ? { value: values.get(name)! } : undefined,
    set: (name: string, value: string) => values.set(name, value),
  };
  saveChallenge(jar, "webauthn-challenge", "register", null, {
    invitationHash: "test",
    accountName: "Alex",
  });
  const challenge = takeChallenge({ cookies: jar }, "register");
  assert.deepEqual(JSON.parse(challenge.data!), {
    invitationHash: "test",
    accountName: "Alex",
  });
  assert.deepEqual(
    db().prepare("SELECT COUNT(*) AS n FROM auth_enrollments").get(),
    { n: 0 },
  );
  assert.throws(() => takeChallenge({ cookies: jar }, "register"));
});

test("workspace recovery revokes pending invitations and preserves project data", async () => {
  const link = withAccount(owner, () => createInvitation(first.id));
  const recoveryPath = join(temp, "recovery.sqlite");
  await db().backup(recoveryPath);
  const recovery = new Database(recoveryPath);
  recovery.exec(
    "INSERT INTO passkeys VALUES('recovery-key',X'01',0,'[]','Recovery',0); INSERT INTO account_passkeys VALUES('recovery-key',1);",
  );
  recovery.close();
  execFileSync(process.execPath, ["scripts/reset-passkeys.mjs", "--confirm"], {
    env: { ...process.env, DATABASE_PATH: recoveryPath },
    stdio: "pipe",
  });
  const reset = new Database(recoveryPath);
  assert.deepEqual(reset.prepare("SELECT COUNT(*) AS n FROM passkeys").get(), {
    n: 0,
  });
  assert.deepEqual(
    reset.prepare("SELECT COUNT(*) AS n FROM account_passkeys").get(),
    { n: 0 },
  );
  assert.ok(
    (
      reset
        .prepare(
          "SELECT revoked_at FROM project_invitations WHERE token_hash=?",
        )
        .get(hashToken(link.token)) as { revoked_at: number }
    ).revoked_at,
  );
  assert.deepEqual(reset.prepare("SELECT COUNT(*) AS n FROM projects").get(), {
    n: 2,
  });
  assert.deepEqual(reset.prepare("SELECT COUNT(*) AS n FROM events").get(), {
    n: 2,
  });
  reset.close();
});
