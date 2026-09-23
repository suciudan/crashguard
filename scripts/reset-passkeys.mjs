import Database from "better-sqlite3";
import { resolve } from "node:path";
if (!process.argv.includes("--confirm")) {
  console.error(
    "Stop CrashGuard and restrict access to it first. Run with --confirm to remove all passkeys and sessions, then enroll a new passkey. Issues and projects are preserved.",
  );
  process.exit(1);
}
const path = resolve(process.env.DATABASE_PATH || "./data/crashguard.sqlite");
const database = new Database(path, { fileMustExist: true });
try {
  database.pragma("foreign_keys = ON");
  database.transaction(() => {
    for (const table of [
      "auth_sessions",
      "auth_challenges",
      "passkeys",
      "auth_identity",
    ])
      database.prepare(`DELETE FROM ${table}`).run();
  })();
  console.log(
    `Passkeys and sessions reset in ${path}. Start CrashGuard and enroll your new passkey before allowing other visitors.`,
  );
} finally {
  database.close();
}
