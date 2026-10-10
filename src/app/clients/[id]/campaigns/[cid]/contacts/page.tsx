import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { after } from "next/server";
import { all, get, getSetting } from "@/lib/db";
import { getCampaign } from "@/lib/campaigns";
import { requireClient } from "@/lib/clients";
import { verifyLeads, writeEmails } from "@/app/leads/actions";
import { runVerifier, uncheckedCount } from "@/lib/verify";
import { verificationReport, groupLeads, runVerificationActions } from "@/lib/verifyReport";
import { LeadImporter } from "@/components/LeadImporter";
import { VerificationGroups } from "@/components/VerificationGroups";
import { AutoRefresh } from "@/components/AutoRefresh";
import { SubmitButton } from "@/components/SubmitButton";
import { CONTACT_GROUPS, contactStatus } from "@/lib/stages";
import { ago } from "@/lib/format";
import { LEAD_STATUS, INTEREST_STATUS } from "@/lib/instantly";

const n = (v: number) => v.toLocaleString("en-GB");

type Row = {
  id: number; email: string; first_name: string | null; last_name: string | null; company: string | null; title: string | null;
  stage: string; stage_message: string | null; source: string; source_ref: string | null; instantly_status: number | null;
  interest_status: number | null; verification: string | null; created_at: string;
};

/** Contacts tab: add people; every address is checked on arrival; see each contact's result and where they are. */
export default async function CampaignContactsPage({ params, searchParams }: PageProps<"/clients/[id]/campaigns/[cid]/contacts">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  const client = await requireClient(clientId);
  const sp = await searchParams;
  const group = CONTACT_GROUPS.find((g) => g.key === sp.group) ?? null;

  const total = (await get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ?", c.id))?.n ?? 0;
  const groupCounts = Object.fromEntries(
    await Promise.all(CONTACT_GROUPS.map(async (g) => [g.key, (await get<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND ${g.where}`, c.id))?.n ?? 0] as const)),
  );
  const errorCount = (await get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND stage = 'error' AND pushed_at IS NULL", c.id))?.n ?? 0;
  const stuckNew = (await get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND stage = 'new' AND verification IN ('verified', 'catch_all')", c.id))?.n ?? 0;

  // Address checks run by themselves; this is only for contacts added before that was true.
  const unchecked = await uncheckedCount(c.id);
  const report = await verificationReport(clientId, c.id);
  const verifyError = await getSetting(`verify_error_${clientId}`, "");
  if (report.checking > 0) after(runVerifier); // keep the job going while someone is watching
  if (report.portal.queued > 0) after(runVerificationActions);
  const lists = report.checked
    ? { verified: await groupLeads(clientId, "verified", c.id), catch_all: await groupLeads(clientId, "catch_all", c.id), invalid: await groupLeads(clientId, "invalid", c.id) }
    : { verified: [], catch_all: [], invalid: [] };

  const rows = await all<Row>(
    `SELECT * FROM leads WHERE campaign_id = ? ${group ? `AND ${group.where}` : ""} ORDER BY id DESC LIMIT 300`,
    c.id,
  );
  const base = `/clients/${clientId}/campaigns/${c.id}/contacts`;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={report.checking > 0 || report.portal.queued > 0} />

      {/* 1. Results: what to do with each group */}
      {report.checked > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold">Address check results: tag or clean up each group</h2>
          <VerificationGroups clientId={clientId} campaignId={c.id} report={report} lists={lists} />
        </section>
      )}

      {/* 2. Add */}
      <section className="grid grid-cols-[1fr_320px] gap-6">
        <LeadImporter clientId={clientId} campaigns={[{ id: c.id, name: c.name }]} campaignId={c.id} hasGhl={Boolean(client.ghl_location_id && client.ghl_token)} />
        <div className="card flex flex-col gap-3 p-5">
          <h2 className="font-semibold">What happens next</h2>
          <ol className="flex flex-col gap-2 text-sm text-muted">
            <li><span className="font-medium text-ink">1. Checked.</span> Every address is checked with Instantly as soon as it arrives. Invalid ones are set aside.</li>
            <li><span className="font-medium text-ink">2. Prepared.</span> Contacts that pass get their copy of the email, with their name and company filled in.</li>
            <li><span className="font-medium text-ink">3. Ready to send.</span> Verified contacts wait for your go on the Approve tab; unconfirmed ones are your call.</li>
          </ol>
          {verifyError && report.checking > 0 && <p className="text-sm text-bad">{verifyError}</p>}
          {report.credits && (
            <p className="text-xs text-muted">Check credits left: <span className="num">{Number(report.credits).toLocaleString("en-GB")}</span> (a quarter of a credit per contact)</p>
          )}
          {unchecked > 0 && (
            <form action={verifyLeads.bind(null, c.id)} className="flex flex-col gap-1">
              <SubmitButton pendingLabel="Starting…">Check {n(unchecked)} added before checks were automatic</SubmitButton>
            </form>
          )}
          {(stuckNew > 0 || errorCount > 0) && (
            <div className="flex flex-wrap gap-2">
              {stuckNew > 0 && <form action={writeEmails.bind(null, c.id, false)}><SubmitButton pendingLabel="Starting…">Prepare {n(stuckNew)} emails</SubmitButton></form>}
              {errorCount > 0 && <form action={writeEmails.bind(null, c.id, true)}><SubmitButton pendingLabel="Starting…">Retry {n(errorCount)} that failed</SubmitButton></form>}
            </div>
          )}
          {report.counts.verified > 0 && (
            <Link href={`/clients/${clientId}/campaigns/${c.id}/approve`} className="text-sm text-go underline">Go to Approve →</Link>
          )}
        </div>
      </section>

      {/* 3. Everyone */}
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">All contacts <span className="num text-sm font-normal text-muted">{n(total)}</span></h2>
        <div className="flex flex-wrap gap-1.5 text-sm">
          <Link href={base} className={`rounded-md px-2.5 py-1 ${!group ? "bg-ink text-paper" : "border border-line bg-card"}`}>All</Link>
          {CONTACT_GROUPS.filter((g) => groupCounts[g.key]).map((g) => (
            <Link key={g.key} href={`${base}?group=${g.key}`} className={`rounded-md px-2.5 py-1 ${group?.key === g.key ? "bg-ink text-paper" : `border border-line bg-card ${g.tone}`}`}>
              {g.label} <span className="num">{n(groupCounts[g.key])}</span>
            </Link>
          ))}
        </div>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Contact</th>
                <th className="px-3 py-2 font-medium">Address check</th>
                <th className="px-3 py-2 font-medium">Where they are</th>
                <th className="px-3 py-2 font-medium">Added from</th>
                <th className="px-3 py-2 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted">
                    {total === 0 ? "No contacts yet. Add some above, from the Nexus Portal, a CSV file or by typing them in." : "No contacts in this group."}
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const check = CONTACT_GROUPS.find((g) => (g.key === "checking" ? r.verification === "queued" || r.verification === "pending" : g.key === "unchecked" ? !r.verification : g.key === r.verification));
                const where = contactStatus(r.stage, r.verification);
                return (
                  <tr key={r.id} className="border-t border-line">
                    <td className="px-3 py-2">
                      <div className="font-medium">{[r.first_name, r.last_name].filter(Boolean).join(" ") || r.email}</div>
                      <div className="text-xs text-muted">{[r.title, r.company].filter(Boolean).join(" · ") || r.email}</div>
                    </td>
                    <td className={`px-3 py-2 text-xs font-medium ${check?.tone ?? "text-muted"}`}>{check?.label ?? "Not checked"}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-medium ${where.tone}`}>{where.label}</span>
                      {r.stage === "pushed" && (
                        <span className="ml-1 text-xs text-muted">
                          · {r.interest_status !== null ? INTEREST_STATUS[r.interest_status] : LEAD_STATUS[r.instantly_status ?? 1]}
                        </span>
                      )}
                      {r.stage_message && r.verification !== "invalid" && <div className="max-w-sm truncate text-xs text-bad" title={r.stage_message}>{r.stage_message}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{r.source_ref ?? r.source}</td>
                    <td className="px-3 py-2 text-xs text-muted">{ago(r.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 300 && <p className="px-3 py-2 text-xs text-muted">Showing the latest 300.</p>}
        </div>
      </section>
    </div>
  );
}
