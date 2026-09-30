import { requireClientAccess } from "@/lib/auth";
import Link from "next/link";
import { all } from "@/lib/db";
import { requireClient } from "@/lib/clients";
import { writeEmails } from "@/app/leads/actions";
import { LeadImporter } from "@/components/LeadImporter";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ago } from "@/lib/format";
import { LEAD_STATUS, INTEREST_STATUS } from "@/lib/instantly";

const STAGES = [
  { key: "new", label: "New", tone: "text-muted" },
  { key: "drafting", label: "AI writing", tone: "text-info" },
  { key: "review", label: "Needs review", tone: "text-wait" },
  { key: "approved", label: "Approved", tone: "text-go" },
  { key: "pushed", label: "In Instantly", tone: "text-go" },
  { key: "rejected", label: "Rejected", tone: "text-muted" },
  { key: "error", label: "Error", tone: "text-bad" },
  { key: "extending", label: "Writing next emails", tone: "text-info" },
  { key: "extend_review", label: "Next emails to review", tone: "text-wait" },
  { key: "extend_approved", label: "Next emails approved", tone: "text-go" },
  { key: "extend_rejected", label: "Leaving at release", tone: "text-muted" },
  { key: "extend_error", label: "Next emails failed", tone: "text-bad" },
  { key: "removed", label: "Removed", tone: "text-muted" },
];

type Row = {
  id: number; email: string; first_name: string | null; last_name: string | null; company: string | null;
  title: string | null; stage: string; stage_message: string | null; source: string; source_ref: string | null;
  campaign_name: string | null; instantly_status: number | null; interest_status: number | null; created_at: string;
};

export default async function LeadsPage({ params, searchParams }: PageProps<"/clients/[id]/leads">) {
  const id = Number((await params).id);
  await requireClientAccess(id); // only admins and this client's own logins
  const sp = await searchParams;
  const stage = typeof sp.stage === "string" ? sp.stage : "";
  const client = await requireClient(id);
  const campaigns = await all<{ id: number; name: string; managed: number; new_count: number; error_count: number }>(
    `SELECT c.id, c.name, c.managed,
       (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id AND l.stage = 'new') new_count,
       (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id AND l.stage = 'error' AND l.pushed_at IS NULL) error_count
     FROM campaigns c WHERE c.client_id = ? AND c.managed = 1 ORDER BY c.created_at DESC`,
    id,
  );
  const counts = Object.fromEntries(
    (await all<{ stage: string; n: number }>("SELECT stage, COUNT(*) n FROM leads WHERE client_id = ? GROUP BY stage", id)).map((r) => [r.stage, r.n]),
  );
  const rows = await all<Row>(
    `SELECT l.*, c.name campaign_name FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.client_id = ? ${stage ? "AND l.stage = ?" : ""} ORDER BY l.id DESC LIMIT 300`,
    ...(stage ? [id, stage] : [id]),
  );

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={(counts.drafting ?? 0) > 0} />
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <LeadImporter
          clientId={id}
          campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
          hasGhl={Boolean(client.ghl_location_id && client.ghl_token)}
        />
        <div className="card flex flex-col gap-3 p-5">
          <h2 className="font-semibold">Write emails</h2>
          {campaigns.every((c) => !c.new_count && !c.error_count) ? (
            <p className="text-sm text-muted">No new leads waiting. Import some first.</p>
          ) : (
            campaigns.filter((c) => c.new_count || c.error_count).map((c) => (
              <div key={c.id} className="flex flex-col gap-1.5">
                <div className="text-sm font-medium">{c.name}</div>
                <div className="flex gap-2">
                  {c.new_count > 0 && (
                    <form action={writeEmails.bind(null, c.id, false)}>
                      <button className="btn-go">Write {c.new_count} new</button>
                    </form>
                  )}
                  {c.error_count > 0 && (
                    <form action={writeEmails.bind(null, c.id, true)}>
                      <button className="btn">Retry {c.error_count} failed</button>
                    </form>
                  )}
                </div>
              </div>
            ))
          )}
          {(counts.drafting ?? 0) > 0 && <p className="text-sm text-info">AI is writing {counts.drafting} sequences…</p>}
          {(counts.review ?? 0) > 0 && (
            <Link href={`/clients/${id}/approvals`} className="text-sm text-wait underline">{counts.review} waiting for your review →</Link>
          )}
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5 text-sm">
          <Link href={`/clients/${id}/leads`} className={`rounded-md px-2.5 py-1 ${!stage ? "bg-ink text-paper" : "bg-card border border-line"}`}>
            All <span className="num">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
          </Link>
          {STAGES.filter((s) => counts[s.key]).map((s) => (
            <Link
              key={s.key}
              href={`/clients/${id}/leads?stage=${s.key}`}
              className={`rounded-md px-2.5 py-1 ${stage === s.key ? "bg-ink text-paper" : `border border-line bg-card ${s.tone}`}`}
            >
              {s.label} <span className="num">{counts[s.key]}</span>
            </Link>
          ))}
        </div>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Lead</th>
                <th className="px-3 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-muted">No leads.</td></tr>}
              {rows.map((r) => {
                const s = STAGES.find((x) => x.key === r.stage);
                return (
                  <tr key={r.id} className="border-t border-line">
                    <td className="px-3 py-2">
                      <div className="font-medium">{[r.first_name, r.last_name].filter(Boolean).join(" ") || r.email}</div>
                      <div className="text-xs text-muted">{[r.title, r.company].filter(Boolean).join(" · ") || r.email}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.campaign_name ?? "–"}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-medium ${s?.tone ?? ""}`}>{s?.label ?? r.stage}</span>
                      {r.stage === "pushed" && (
                        <span className="ml-1 text-xs text-muted">
                          · {r.interest_status !== null ? INTEREST_STATUS[r.interest_status] : LEAD_STATUS[r.instantly_status ?? 1]}
                        </span>
                      )}
                      {r.stage_message && <div className="max-w-sm truncate text-xs text-bad" title={r.stage_message}>{r.stage_message}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{r.source_ref ?? r.source}</td>
                    <td className="px-3 py-2 text-xs text-muted">{ago(r.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
