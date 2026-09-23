"use server";
import { z } from "zod";
import { createProject, dashboard, issueDetail, setStatus } from "@/lib/db";
import { ActionError, runAction } from "@/lib/action-guard";
import { symbolicateEvent } from "@/lib/sourcemaps";
import { sidebarSections } from "@/lib/telemetry";

export async function getDashboard(filters: Record<string, string>) {
  return runAction(() => {
    const parsed = z
      .record(z.string(), z.string().max(1000))
      .safeParse(filters);
    if (!parsed.success || Object.keys(parsed.data).length > 12)
      throw new ActionError("Invalid dashboard filters.");
    return {
      ...dashboard(new URLSearchParams(parsed.data)),
      sections: sidebarSections(),
    };
  });
}
export async function addProject(input: { name: string; platform: string }) {
  return runAction(() => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(60),
        platform: z.enum(["javascript", "node", "python", "php", "other"]),
      })
      .safeParse(input);
    if (!parsed.success)
      throw new ActionError(
        "Provide a project name (1–60 characters) and a supported platform.",
      );
    return createProject(parsed.data.name, parsed.data.platform);
  });
}
export async function getIssue(id: number, eventId?: string | null) {
  return runAction(() => {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new ActionError("Invalid issue ID.");
    if (eventId && !/^[a-f0-9]{32}$/i.test(eventId))
      throw new ActionError("Invalid event ID.");
    const detail = issueDetail(id, eventId || undefined);
    if (!detail) throw new ActionError("Issue not found");
    return {
      ...detail,
      events: detail.events.map((event) => ({
        ...event,
        payload: symbolicateEvent(detail.issue.project_id, event.payload),
      })),
    };
  });
}
export async function updateIssueStatus(id: number, status: string) {
  return runAction(() => {
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !z.enum(["unresolved", "resolved", "ignored"]).safeParse(status).success
    )
      throw new ActionError("Invalid issue status.");
    if (!setStatus(id, status)) throw new ActionError("Issue not found");
    return { status };
  });
}
