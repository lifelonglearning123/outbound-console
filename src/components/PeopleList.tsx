import Link from "next/link";
import { getSetting } from "@/lib/db";
import { requireClient, type Client } from "@/lib/clients";
import { dateTime } from "@/lib/format";
import { otherCampaigns, type OtherCampaign } from "@/lib/leads";
import {
  checkOption, defaultDir, describeFilters, hostLabel, listPeople, nonPeopleParams, peopleFacets, personName, personState, readFilters,
  readSort, sortParams, sourceLabel, type Facet, type PeopleScope, type SortKey,
} from "@/lib/people";
import { removeMatching, removeSelected } from "@/app/leads/actions";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PeopleFilters } from "@/components/PeopleFilters";

const n = (v: number) => v.toLocaleString("en-GB");
const PAGE = 100;

/**
 * A list of people to search, filter, sort, page through and download: a campaign's on its Contacts tab, a
 * client's on Stats. Reads its filters, sort and page from the page's search params; anchors at #people.
 */
export async function PeopleList({
  scope,
  sp,
  basePath,
  title,
  removable = false,
  steps = 1,
  emptyText = "No contacts yet.",
}: {
  scope: PeopleScope;
  sp: Record<string, string | string[] | undefined>;
  /** The page the list is on; filter changes reload it. */
  basePath: string;
  title: string;
  /** A campaign's Contacts tab: contacts not yet with the sender can be ticked, or matched by the filters, and removed. */
  removable?: boolean;
  /** Emails in the campaign's sequence, to show how far each person has got. */
  steps?: number;
  emptyText?: string;
}) {
  const filters = readFilters(sp);
  const sort = readSort(sp);
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const [facets, list, client] = await Promise.all([
    peopleFacets(scope, filters),
    listPeople(scope, filters, sort, page, PAGE),
    requireClient(scope.clientId),
  ]);
  const elsewhere: Map<string, OtherCampaign[]> = scope.campaignId
    ? await otherCampaigns(scope.clientId, scope.campaignId, list.rows.map((r) => r.email))
    : new Map();
  const note = await titleNote(client, facets);

  const own = nonPeopleParams(sp);
  const values = filters as Record<string, string>;
  const sorted = sortParams(sort);
  const href = (patch: Record<string, string | number | null>) => {
    const q = new URLSearchParams({ ...own, ...values, ...sorted });
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) q.delete(k);
      else q.set(k, String(v));
    }
    return `${basePath}?${q}#people`;
  };
  const exportHref = `/clients/${scope.clientId}/people/export?${new URLSearchParams({
    ...(scope.campaignId ? { campaign: String(scope.campaignId) } : {}),
    ...values,
    ...sorted,
  })}`;
  const active = Object.keys(filters).length > 0;
  const pages = Math.max(1, Math.ceil(list.total / PAGE));
  const canTick = removable && scope.campaignId !== null && list.rows.some((r) => !r.handed && r.stage !== "removed");
  const columns = 6 + (removable ? 1 : 0) + (scope.campaignId ? 0 : 1);

  const sortHead = (k: SortKey, label: string) => {
    const on = sort.key === k;
    const dir = on ? (sort.dir === "asc" ? "desc" : "asc") : defaultDir(k);
    return (
      <Link href={href({ sort: k, dir, page: null })} scroll={false} className={`hover:underline ${on ? "text-ink" : ""}`}>
        {label}
        {on ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
      </Link>
    );
  };

  const table = (
    <div className="card">
      <table className="w-full text-sm">
        <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            {removable && <th className="w-8 px-3 py-2"><span className="sr-only">Select</span></th>}
            <th className="px-3 py-2 font-medium">{sortHead("name", "Contact")}</th>
            <th className="px-3 py-2 font-medium">{sortHead("recent", "Where they are")}</th>
            <th className="px-3 py-2 font-medium">Address check</th>
            <th className="px-3 py-2 font-medium">Email host</th>
            <th className="px-3 py-2 font-medium">{sortHead("sent", "Emailed")}</th>
            {!scope.campaignId && <th className="px-3 py-2 font-medium">Campaign</th>}
            <th className="px-3 py-2 font-medium">Came from</th>
          </tr>
        </thead>
        <tbody>
          {list.rows.length === 0 && (
            <tr>
              <td colSpan={columns} className="px-3 py-8 text-center text-sm text-muted">{active ? "Nobody matches these filters." : emptyText}</td>
            </tr>
          )}
          {list.rows.map((r) => {
            const state = personState(r);
            const check = checkOption(r.check_key);
            const name = personName(r);
            return (
              <tr key={r.id} className="border-t border-line align-top">
                {removable && (
                  <td className="px-3 py-2">
                    {!r.handed && r.stage !== "removed" && (
                      <input type="checkbox" name="ids" value={r.id} aria-label={`Select ${r.email}`} className="mt-1" />
                    )}
                  </td>
                )}
                <td className="px-3 py-2">
                  <div className="font-medium">{name || r.email}</div>
                  {(r.title || r.company) && <div className="text-xs text-muted">{[r.title, r.company].filter(Boolean).join(" · ")}</div>}
                  {name && <div className="break-all text-xs text-muted">{r.email}</div>}
                </td>
                <td className="px-3 py-2">
                  <div className={`text-xs font-medium ${state.tone}`}>{state.label}</div>
                  {!r.replied_at && r.reply_tag === "ooo" && <div className="text-xs text-muted">Out-of-office reply</div>}
                  {r.stage_message && r.verification !== "invalid" && (
                    <div
                      className={`max-w-sm truncate text-xs ${/^(Held back|Waiting|Removed|Deleted)/.test(r.stage_message) ? "text-muted" : "text-bad"}`}
                      title={r.stage_message}
                    >
                      {r.stage_message}
                    </div>
                  )}
                  {(elsewhere.get(r.email) ?? []).map((o, i) => (
                    <div key={i} className="text-xs text-muted">
                      Also in {o.campaign} <span className={o.tone}>· {o.outcome}</span>
                    </div>
                  ))}
                </td>
                <td className={`px-3 py-2 text-xs font-medium ${check?.tone ?? "text-muted"}`}>{check?.label ?? r.check_key}</td>
                <td className={`px-3 py-2 text-xs ${r.gateway ? "font-medium text-wait" : "text-muted"}`}>{hostLabel(r.host)}</td>
                <td className="px-3 py-2 text-xs">
                  {r.emailed ? (
                    <>
                      <div>{dateTime(r.first_sent) || "Yes"}</div>
                      {r.sender && <div className="break-all text-muted">from {r.sender}</div>}
                      {steps > 1 && <div className="text-muted">{n(r.steps_sent)} of {steps} emails</div>}
                    </>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </td>
                {!scope.campaignId && <td className="px-3 py-2 text-xs">{r.campaign}</td>}
                <td className="px-3 py-2 text-xs text-muted">{sourceLabel(r.source)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">
          {title} <span className="num text-sm font-normal text-muted">{active ? `${n(list.total)} match` : n(list.total)}</span>
        </h2>
        {list.total > 0 && (
          <a href={exportHref} className="btn text-xs">Download {n(list.total)} as CSV</a>
        )}
      </div>
      {note && <p className="text-xs text-muted">{note}</p>}

      <PeopleFilters
        basePath={basePath}
        keep={{ ...own, ...sorted }}
        values={values}
        facets={facets}
        chips={filters.title ? [{ key: "title", label: `Job title: ${filters.title}` }] : []}
      >
        <div className="flex flex-col gap-2">
          {removable && scope.campaignId !== null && active && list.removable > 0 && (
            <form action={removeMatching.bind(null, scope.campaignId, new URLSearchParams(values).toString())} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-card px-3 py-2 text-sm">
              <ConfirmButton
                className="btn-bad text-xs"
                message={`Remove ${n(list.removable)} contacts (${describeFilters(filters)}) from this campaign? They won't be emailed by it. Their record is kept under "Removed".`}
              >
                Remove the {n(list.removable)} not yet with the sender
              </ConfirmButton>
              {list.removable < list.total && (
                <span className="text-muted">{n(list.total - list.removable)} already with the sender stay as they are.</span>
              )}
            </form>
          )}
          {canTick ? (
            <form action={removeSelected.bind(null, scope.campaignId!)} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs text-muted">
                <ConfirmButton className="btn text-xs" message="Remove the ticked contacts from this campaign? Their record is kept under &quot;Removed&quot;.">
                  Remove ticked contacts
                </ConfirmButton>
                <span>Only contacts not yet with the sender can be ticked.</span>
              </div>
              {table}
            </form>
          ) : (
            table
          )}
          {list.total > PAGE && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>
                Showing {n((page - 1) * PAGE + 1)}–{n(Math.min(page * PAGE, list.total))} of {n(list.total)}
              </span>
              <span className="flex gap-2">
                {page > 1 && <Link href={href({ page: page === 2 ? null : page - 1 })} className="btn text-xs">← Previous</Link>}
                {page < pages && <Link href={href({ page: page + 1 })} className="btn text-xs">Next →</Link>}
              </span>
            </div>
          )}
        </div>
      </PeopleFilters>
    </div>
  );
}

/** When most people have no job title, say where titles come from, so it's clear how to get them. */
async function titleNote(client: Client, facets: Facet[]): Promise<string | null> {
  const options = facets.find((f) => f.key === "seniority")?.options ?? [];
  const total = options.reduce((a, o) => a + o.n, 0);
  const missing = options.find((o) => o.value === "none")?.n ?? 0;
  if (!total || missing / total < 0.5) return null;
  const lead = `${n(missing)} of these ${n(total)} have no job title.`;
  if (!client.ghl_location_id || !client.ghl_token) return `${lead} Titles come from a CSV file's "Job title" column.`;
  let found: { name?: string; none?: boolean; error?: string } = {};
  try {
    found = JSON.parse(await getSetting(`ghl_title_field_${client.id}`, "{}"));
  } catch {}
  if (found.name) return `${lead} Titles are read from the Nexus Portal field "${found.name}" and a CSV file's "Job title" column; these have none in either.`;
  if (found.none) {
    return `${lead} The Nexus Portal has no field named like "Job title", so titles only come from a CSV file's "Job title" column. Add and fill one in the portal, and the sync reads it within a day.`;
  }
  if (found.error) return `${lead} Couldn't read the Nexus Portal's fields to find job titles: ${found.error}`;
  return `${lead} They're read from the Nexus Portal at the next sync.`;
}
