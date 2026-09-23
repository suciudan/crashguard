"use client";
import { useSearchParams } from "next/navigation";
import type { ComponentProps } from "react";

type Changes = Record<string, string | number | null>;
export function appHref(current: string, changes: Changes) {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
export function navigate(href: string, replace = false) {
  if (href === window.location.pathname + window.location.search) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", href);
}
export function useAppNavigation() {
  const params = useSearchParams();
  return {
    params,
    href: (changes: Changes) => appHref(params.toString(), changes),
    update: (changes: Changes, replace = false) =>
      navigate(appHref(window.location.search, changes), replace),
  };
}
export function AppLink({
  href,
  onClick,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.target === "_blank"
        )
          return;
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}
