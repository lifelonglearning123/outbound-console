"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

type Facet = { key: string; label: string; options: { value: string; label: string; n: number }[] };

/**
 * The filter row above a people list. Every change reloads the list with the filters in the URL, so a filtered list
 * can be bookmarked or shared; the current list stays on screen, dimmed, until the new one arrives.
 */
export function PeopleFilters({
  basePath,
  keep,
  values,
  facets,
  chips,
  children,
}: {
  basePath: string;
  /** Params that aren't filters but stay as they are: the page's own (Stats' range) and the sort. */
  keep: Record<string, string>;
  /** The filters in force. */
  values: Record<string, string>;
  facets: Facet[];
  /** Filters in force that have no control of their own (a job title picked from a breakdown), shown to clear. */
  chips: { key: string; label: string }[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = (patch: Record<string, string>) => {
    const q = new URLSearchParams(keep);
    for (const [k, v] of Object.entries({ ...values, ...patch })) if (v) q.set(k, v);
    const s = q.toString();
    start(() => router.push(s ? `${basePath}?${s}` : basePath, { scroll: false }));
  };
  const clear = () => {
    const s = new URLSearchParams(keep).toString();
    start(() => router.push(s ? `${basePath}?${s}` : basePath, { scroll: false }));
  };
  const n = (v: number) => v.toLocaleString("en-GB");

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: String(new FormData(e.currentTarget).get("q") ?? "").trim() });
        }}
      >
        <input
          key={values.q ?? ""}
          name="q"
          type="search"
          defaultValue={values.q}
          placeholder="Search name, email, company or title"
          aria-label="Search"
          className="field"
          style={{ width: "17rem" }}
        />
        {facets.map((f) => (
          <select
            key={f.key}
            value={values[f.key] ?? ""}
            onChange={(e) => go({ [f.key]: e.target.value })}
            aria-label={f.label}
            className={`field ${values[f.key] ? "border-ink font-medium" : ""}`}
            style={{ width: "auto", maxWidth: "15rem" }}
          >
            <option value="">{f.label}: all</option>
            {f.options
              .filter((o) => o.n > 0 || o.value === values[f.key])
              .map((o) => (
                <option key={o.value} value={o.value}>{o.label} ({n(o.n)})</option>
              ))}
          </select>
        ))}
        <span className="flex items-center gap-1 text-xs text-muted">
          Emailed
          <input type="date" value={values.from ?? ""} onChange={(e) => go({ from: e.target.value })} aria-label="Emailed from" className="field" style={{ width: "auto" }} />
          to
          <input type="date" value={values.to ?? ""} onChange={(e) => go({ to: e.target.value })} aria-label="Emailed until" className="field" style={{ width: "auto" }} />
        </span>
        {chips.map((c) => (
          <button key={c.key} type="button" onClick={() => go({ [c.key]: "" })} className="rounded-md border border-ink bg-card px-2 py-1 text-xs font-medium" title="Clear this filter">
            {c.label} ✕
          </button>
        ))}
        {Object.keys(values).length > 0 && (
          <button type="button" onClick={clear} className="text-xs underline">Clear filters</button>
        )}
      </form>
      <div className={`transition-opacity ${pending ? "opacity-50" : ""}`} aria-busy={pending}>{children}</div>
    </div>
  );
}
