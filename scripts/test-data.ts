import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
// Fixtures/readbacks use only an explicitly selected disposable host database.
// Browser workflows exercise the production Server Actions.
const configured = process.env.TEST_DATABASE_PATH;
if (!configured)
  throw new Error(
    "Set TEST_DATABASE_PATH to the disposable instance's SQLite file under test-results/.",
  );
const path = realpathSync(resolve(configured));
const rel = relative(realpathSync(resolve("test-results")), path);
if (rel.startsWith("..") || isAbsolute(rel))
  throw new Error("Integration tests require a database inside test-results/.");
process.env.DATABASE_PATH = path;
export { createProject, dashboard, issueDetail, db } from "../src/lib/db";
export function envelope(event: object) {
  return `{}\n{"type":"event"}\n${JSON.stringify(event)}\n`;
}
