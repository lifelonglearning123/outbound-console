import Link from "next/link";
import { pct } from "@/lib/format";
import { DIMENSIONS, type BreakdownRow, type Counts, type Dimension, type PeopleFilters } from "@/lib/people";

const BLUE = "#2a78d6"; // the stats pages' single-series colour
const n = (v: number) => v.toLocaleString("en-GB");

/**
 * What happened to people, split by one dimension (their email host, the mailbox that wrote to them, their
 * seniority…). Rates are of the people emailed in each row; every row opens the people behind it.
 */
export function Breakdown({
  dim,
  rows,
  total,
  dimHref,
  people,
  exportHref,
}: {
  dim: Dimension;
  rows: BreakdownRow[];
  total: Counts;
  /** The same page, broken down by another dimension. */
  dimHref: (d: Dimension) => string;
  /** The people list showing these filters. */
  people: (f: PeopleFilters) => string;
  exportHref: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.emailed));
  const chip = (on: boolean) => `rounded-md px-2.5 py-1 text-sm ${on ? "bg-ink text-paper" : "border border-line bg-card"}`;
  const label = DIMENSIONS.find((d) => d.key === dim)!.label;

  const row = (r: Counts & { label: string; filter: PeopleFilters | null }, strong = false) => (
    <tr key={r.label} className={`border-t border-line ${strong ? "bg-paper font-medium" : ""}`}>
      <td className="px-3 py-1.5">
        {r.filter ? <Link href={people(r.filter)} className="hover:underline">{r.label}</Link> : <span className="text-muted">{r.label}</span>}
      </td>
      <td className="num px-3 py-1.5 text-right">{n(r.contacts)}</td>
      <td className="px-3 py-1.5">
        <div className="flex items-center justify-end gap-2" title={`${n(r.emailed)} of ${n(r.contacts)} emailed`}>
          {!strong && (
            <div className="hidden h-2 w-20 rounded-r bg-paper sm:block">
              <div className="h-2 rounded-r" style={{ width: `${r.emailed ? Math.max(3, (r.emailed / max) * 100) : 0}%`, background: BLUE }} />
            </div>
          )}
          <span className="num">{n(r.emailed)}</span>
        </div>
      </td>
      <Rate n={r.opened} of={r.emailed} />
      <Rate n={r.replied} of={r.emailed} />
      <Rate n={r.interested} of={r.emailed} />
      <Rate n={r.bounced} of={r.emailed} bad={r.emailed > 0 && r.bounced / r.emailed > 0.03} />
    </tr>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm text-muted">Break down by</span>
        {DIMENSIONS.map((d) => (
          <Link key={d.key} href={dimHref(d.key)} scroll={false} className={chip(d.key === dim)}>{d.label}</Link>
        ))}
        <a href={exportHref} className="btn ml-auto text-xs">Download as CSV</a>
      </div>
      <div className="card">
        <table className="w-full text-sm">
          <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">{label}</th>
              <th className="px-3 py-2 text-right font-medium">Contacts</th>
              <th className="px-3 py-2 text-right font-medium">Emailed</th>
              <th className="px-3 py-2 text-right font-medium">Opened</th>
              <th className="px-3 py-2 text-right font-medium">Replied</th>
              <th className="px-3 py-2 text-right font-medium">Interested</th>
              <th className="px-3 py-2 text-right font-medium">Bounced</th>
            </tr>
          </thead>
          <tbody>
            {row({ ...total, label: "Everyone", filter: {} }, true)}
            {rows.map((r) => row(r))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Percentages are of the people emailed in each row. Opens are approximate: Apple Mail reports some that never happened and Outlook
        hides others. Click a row to see its people.
      </p>
    </div>
  );
}

function Rate({ n: count, of, bad = false }: { n: number; of: number; bad?: boolean }) {
  return (
    <td className={`num px-3 py-1.5 text-right ${bad ? "text-bad" : ""}`}>
      {n(count)} <span className={`text-xs ${bad ? "" : "text-muted"}`}>{of ? pct(count, of) : ""}</span>
    </td>
  );
}
