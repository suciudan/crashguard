import { db } from "@/lib/db";
export function GET() {
  db().prepare("SELECT 1").get();
  return Response.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
