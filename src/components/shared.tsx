"use client";
import { Code2, Server } from "lucide-react";
import type { ActionResult } from "@/lib/action-result";
export async function action<T>(pending: Promise<ActionResult<T>>): Promise<T> {
  const result = await pending;
  if (result.error !== undefined) {
    if (result.code === "UNAUTHENTICATED" && typeof window !== "undefined")
      window.location.assign(
        `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
    throw new Error(result.error);
  }
  return result.data;
}
export function relative(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
export function Platform({
  platform,
  small = false,
}: {
  platform: string;
  small?: boolean;
}) {
  return (
    <span
      className={`platform ${small ? "small" : ""} ${platform === "node" ? "node" : platform === "python" ? "python" : ""}`}
    >
      {platform === "javascript" ? (
        "JS"
      ) : platform === "node" ? (
        <Server size={small ? 13 : 18} />
      ) : platform === "python" ? (
        "Py"
      ) : (
        <Code2 size={18} />
      )}
    </span>
  );
}
