/** SQLite datetime('now') is UTC without a zone marker; treat bare timestamps as UTC. */
export function toDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

export function ago(value: string | null | undefined): string {
  if (!value) return "never";
  const s = Math.round((Date.now() - toDate(value).getTime()) / 1000);
  if (s < 0) return inFuture(-s);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function inFuture(s: number): string {
  if (s < 3600) return `in ${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

export function pct(n: number, d: number): string {
  if (!d) return "–";
  const v = (n / d) * 100;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "";
  return toDate(value).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Current time for server components; each request renders fresh, so reading the clock is intended. */
export const nowMs = () => Date.now();
