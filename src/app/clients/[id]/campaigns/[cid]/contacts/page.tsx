import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { after } from "next/server";
import { all, get, getSetting } from "@/lib/db";
import { getCampaign } from "@/lib/campaigns";
import { requireClient } from "@/lib/clients";
import { verifyLeads, writeEmails } from "@/app/leads/actions";
import { runVerifier, uncheckedCount, VERIFICATION_LABEL } from "@/lib/verify";
import { verificationReport, groupLeads, runVerificationActions } from "@/lib/verifyReport";
import { LeadImporter } from "@/components/LeadImporter";
import { VerificationGroups } from "@/components/VerificationGroups";
import { AutoRefresh } from "@/components/AutoRefresh";
import { SubmitButton } from "@/components/SubmitButton";
import { STAGES, stageLabel, stageTone } from "@/lib/stages";
import { ago } from "@/lib/format";
import { LEAD_STATUS, INTEREST_STATUS } from "@/lib/instantly";

const n = (v: number) => v.toLocaleString("en-GB");
const VERIFICATION_TONE: Record<string, string> = { verified: "text-go", catch_all: "text-wait", invalid: "text-bad", queued: "text-info", pending: "text-info" };

type Row = {
  id: number; email: string; first_name: string | null; last_name: string | null; company: string | null; title: string | null;
  stage: string; stage_message: string | null; source: string; source_ref: string | null; instantly_status: number | null;
  interest_status: number | null; verification: string | null; created_at: string;
};

/** Contacts tab: add people, check their addresses, see where each one is. */
export default async function CampaignContactsPage({ params, searchParams }: PageProps<"/clients/[id]/campaigns/[cid]/contacts">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  const client = await requireClient(clientId);
  const sp = await searchParams;
  const stage = typeof sp.stage === "string" ? sp.stage : "";

  const counts = Object.fromEntries(
    (await all<{ stage: string; n: number }>("SELECT stage, COUNT(*) n FROM leads WHERE campaign_id = ? GROUP BY stage", c.id)).map((r) => [r.stage, r.n]),
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const newCount = counts.new ?? 0;
  const errorCount = (await get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND stage = 'error' AND pushed_at IS NULL", c.id))?.n ?? 0;

  // Address check
  const unchecked = await uncheckedCount(c.id);
  const report = await verificationReport(clientId, c.id);
  const verifyError = await getSetting(`verify_error_${clientId}`, "");
  const busy = report.checking > 0 || report.portal.queued > 0 || (counts.drafting ?? 0) > 0;
  if (report.checking > 0) after(runVerifier); // keep the job going while someone is watching
  if (report.portal.queued > 0) after(runVerificationActions);
  const lists = report.checked
    ? { verified: await groupLeads(clientId, "verified", c.id), catch_all: await groupLeads(clientId, "catch_all", c.id), invalid: await groupLeads(clientId, "invalid", c.id) }
    : { verified: [], catch_all: [], invalid: [] };

  const rows = await all<Row>(
    `SELECT * FROM leads WHERE campaign_id = ? ${stage ? "AND stage = ?" : ""} ORDER BY id DESC LIMIT 300`,
    ...(stage ? [c.id, stage] : [c.id]),
  );
  const base = `/clients/${clientId}/campaigns/${c.id}/contacts`;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={busy} />

      {/* 1. Add */}
      <section className="grid grid-cols-[1fr_320px] gap-6">
        <LeadImporter clientId={clientId} campaigns={[{ id: c.id, name: c.name }]} campaignId={c.id} hasGhl={Boolean(client.ghl_location_id && client.ghl_token)} />
        <div className="flex flex-col gap-6">
          <div className="card flex flex-col gap-3 p-5">
            <h2 className="font-semibold">Prepare emails</h2>
            {newCount === 0 && errorCount === 0 ? (
              <p className="text-sm text-muted">{total ? "Every contact has their email prepared." : "Add contacts first."}</p>
            ) : (
              <>
                <p className="text-sm text-muted">Each new contact gets their copy of the email, filled in with their name and company, ready for approval.</p>
                <div className="flex flex-wrap gap-2">
                  {newCount > 0 && (
                    <form action={writeEmails.bind(null, c.id, false)}><SubmitButton className="btn-go" pendingLabel="Starting…">Prepare {n(newCount)} new</SubmitButton></form>
                  )}
                  {errorCount > 0 && (
                    <form action={writeEmails.bind(null, c.id, true)}><SubmitButton pendingLabel="Starting…">Retry {n(errorCount)} failed</SubmitButton></form>
                  )}
                </div>
              </>
            )}
            {(counts.review ?? 0) > 0 && (
              <Link href={`/clients/${clientId}/campaigns/${c.id}/approve`} className="text-sm text-wait underline">
                {n(counts.review)} waiting for your approval →
              </Link>
            )}
          </div>

          <div className="card flex flex-col gap-3 p-5">
            <h2 className="font-semibold">Check addresses</h2>
            <p className="text-xs text-muted">
              Instantly checks each address exists before anyone is emailed. Invalid ones are set aside; ones it can&apos;t confirm get a note for the approver.
            </p>
            {unchecked > 0 ? (
              <form action={verifyLeads.bind(null, c.id)}><SubmitButton className="btn-go" pendingLabel="Starting…">Check {n(unchecked)} addresses</SubmitButton></form>
            ) : (
              <p className="text-sm text-muted">{report.checking ? "" : total ? "Every address that can be checked has been." : ""}</p>
            )}
            {verifyError && !report.checking && unchecked > 0 && <p className="text-sm text-bad">{verifyError}</p>}
            {report.checked > 0 && (
              <p className="text-xs text-muted">
                <span className="num text-go">{n(report.counts.verified)}</span> verified · <span className="num text-wait">{n(report.counts.catch_all)}</span> unable to verify ·{" "}
                <span className="num text-bad">{n(report.counts.invalid)}</span> invalid
              </p>
            )}
          </div>
        </div>
      </section>

      {/* 2. Results */}
      {report.checked > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold">Address check results</h2>
          <VerificationGroups clientId={clientId} campaignId={c.id} report={report} lists={lists} />
        </section>
      )}

      {/* 3. Everyone */}
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">All contacts <span className="num text-sm font-normal text-muted">{n(total)}</span></h2>
        <div className="flex flex-wrap gap-1.5 text-sm">
          <Link href={base} className={`rounded-md px-2.5 py-1 ${!stage ? "bg-ink text-paper" : "border border-line bg-card"}`}>All</Link>
          {STAGES.filter((s) => counts[s.key]).map((s) => (
            <Link key={s.key} href={`${base}?stage=${s.key}`} className={`rounded-md px-2.5 py-1 ${stage === s.key ? "bg-ink text-paper" : `border border-line bg-card ${s.tone}`}`}>
              {s.label} <span className="num">{counts[s.key]}</span>
            </Link>
          ))}
        </div>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Contact</th>
                <th className="px-3 py-2 font-medium">Address</th>
                <th className="px-3 py-2 font-medium">Where they are</th>
                <th className="px-3 py-2 font-medium">Added from</th>
                <th className="px-3 py-2 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted">
                    {total === 0 ? "No contacts yet. Add some above, from the Nexus Portal, a CSV file or by typing them in." : "No contacts at this stage."}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <div className="font-medium">{[r.first_name, r.last_name].filter(Boolean).join(" ") || r.email}</div>
                    <div className="text-xs text-muted">{[r.title, r.company].filter(Boolean).join(" · ") || r.email}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.verification ? <span className={VERIFICATION_TONE[r.verification] ?? ""}>{VERIFICATION_LABEL[r.verification] ?? r.verification}</span> : <span className="text-muted">Not checked</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-xs font-medium ${stageTone(r.stage)}`}>{stageLabel(r.stage)}</span>
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
              ))}
            </tbody>
          </table>
          {rows.length === 300 && <p className="px-3 py-2 text-xs text-muted">Showing the latest 300.</p>}
        </div>
      </section>
    </div>
  );
}
