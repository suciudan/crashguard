import { handleMcpRequest } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = handleMcpRequest;
export const GET = handleMcpRequest;
export const DELETE = handleMcpRequest;
