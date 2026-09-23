import { ingest } from "@/lib/ingest";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return ingest(request, (await context.params).projectId);
}
