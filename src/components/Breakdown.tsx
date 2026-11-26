import Link from "next/link";
import { pct } from "@/lib/format";
import { DIMENSIONS, type BreakdownRow, type Counts, type Dimension, type PeopleFilters } from "@/lib/people";
import { DimensionSelect } from "./DimensionSelect";

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
  // Rows nobody has been emailed in yet are only zeros: folded into one line that opens to show them.
  const shown = rows.filter((r) => r.emailed > 0);
  const quiet = rows.filter((r) => r.emailed === 0);
  const quietContacts = quiet.reduce((a, r) => a + r.contacts, 0);
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
          <span className={`num ${r.emailed ? "" : "text-muted"}`}>{r.emailed ? n(r.emailed) : "–"}</span>
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
      <div className="flex flex-wrap items-center gap-2">
        <DimensionSelect value={dim} options={DIMENSIONS.map((d) => ({ key: d.key, label: d.label, href: dimHref(d.key) }))} />
        <a href={exportHref} className="btn ml-auto text-xs">Download as CSV</a>
      </div>
      {/* Scrolls sideways on a narrow screen rather than hiding columns. */}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed text-sm">
          <colgroup><col className="w-[26%]" /><col /><col className="w-[16%]" /><col /><col /><col /><col /></colgroup>
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
            {shown.map((r) => row(r))}
          </tbody>
        </table>
        {quiet.length > 0 && (
          <details className="border-t border-line text-sm">
            <summary className="cursor-pointer px-3 py-2 text-muted">
              {quiet.length} more with nobody emailed yet ({n(quietContacts)} {quietContacts === 1 ? "contact" : "contacts"})
            </summary>
            <table className="w-full min-w-[640px] table-fixed text-sm"><colgroup><col className="w-[26%]" /><col /><col className="w-[16%]" /><col /><col /><col /><col /></colgroup><tbody>{quiet.map((r) => row(r))}</tbody></table>
          </details>
        )}
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
      {count ? (
        <>
          {n(count)} <span className={`text-xs ${bad ? "" : "text-muted"}`}>{of ? pct(count, of) : ""}</span>
        </>
      ) : (
        <span className="text-muted">–</span>
      )}
    </td>
  );
}
