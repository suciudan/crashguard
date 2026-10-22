import { AccessError } from "./access";

// Stored receipt timestamps use UTC ISO strings, so inclusive calendar dates
// can be compared directly without locale-dependent parsing or time zones.
export function issueRange(params: URLSearchParams) {
  const hours = params.get("hours");
  if (["24", "168", "720"].includes(hours || ""))
    return {
      from: new Date(Date.now() - Number(hours) * 3600000).toISOString(),
      to: null,
      chart: true,
    };
  if (hours !== "custom") return { from: null, to: null, chart: false };
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const valid = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  };
  if (!valid(from) || !valid(to) || from > to)
    throw new AccessError(
      "Choose valid From and Through dates, with From on or before Through (UTC).",
    );
  return {
    from: `${from}T00:00:00.000Z`,
    to: `${to}T23:59:59.999Z`,
    chart: false,
  };
}
