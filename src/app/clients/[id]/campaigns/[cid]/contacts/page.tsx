import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { after } from "next/server";
import { all, get, getSetting } from "@/lib/db";
import { getCampaign, liveSteps } from "@/lib/campaigns";
import { requireClient } from "@/lib/clients";
import { verifyLeads, writeEmails } from "@/app/leads/actions";
import { runVerifier, uncheckedCount } from "@/lib/verify";
import { verificationReport, groupLeads, runVerificationActions } from "@/lib/verifyReport";
import { LeadImporter } from "@/components/LeadImporter";
import { VerificationGroups } from "@/components/VerificationGroups";
import { AutoRefresh } from "@/components/AutoRefresh";
import { SubmitButton } from "@/components/SubmitButton";
import { detectMailDomains, GATEWAY_LABEL, uncheckedDomains, type Gateway } from "@/lib/mailhost";
import { heldNotYetEmailed } from "@/lib/push";
import { setGatewayHold, takeBackHeld } from "@/app/leads/actions";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PeopleList } from "@/components/PeopleList";

const n = (v: number) => v.toLocaleString("en-GB");

/** Contacts tab: add people; every address is checked on arrival; find, filter, download or remove anyone in the campaign. */
export default async function CampaignContactsPage({ params, searchParams }: PageProps<"/clients/[id]/campaigns/[cid]/contacts">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  const client = await requireClient(clientId);
  const sp = await searchParams;
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

  if (await uncheckedDomains(c.id)) after(detectMailDomains); // who handles each company's email, looked up in the background
  // Send-safety per mail filter: who sits behind each, what happened so far, and whether this campaign sends to it.
  const gateways = await all<{ gateway: Gateway; contacts: number; held: number; emailed: number; bounced: number }>(
    `SELECT md.gateway, COUNT(*) contacts, COUNT(*) FILTER (WHERE l.stage = 'approved') held,
       COUNT(*) FILTER (WHERE l.last_sent_at IS NOT NULL) emailed, COUNT(*) FILTER (WHERE l.instantly_status = -1) bounced
     FROM leads l JOIN mail_domains md ON md.domain = split_part(l.email, '@', 2)
     WHERE l.campaign_id = ? AND md.gateway IS NOT NULL AND l.stage NOT IN ('rejected', 'removed')
     GROUP BY md.gateway ORDER BY 2 DESC`,
    c.id,
  );
  const pullable = await heldNotYetEmailed(c.id);
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
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <LeadImporter clientId={clientId} campaigns={[{ id: c.id, name: c.name }]} campaignId={c.id} ghlTag={c.ghl_tag} hasGhl={Boolean(client.ghl_location_id && client.ghl_token)} />
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

      {/* 3. Mail filters: pause sending to the ones that reject you */}
      {gateways.length > 0 && (
        <section id="mail-filters" className="flex scroll-mt-16 flex-col gap-2">
          <header>
            <h2 className="font-semibold">Mail filters</h2>
            <p className="text-sm text-muted">
              Some companies put a security filter in front of their email. If a filter doesn&apos;t trust your sending domain, it refuses
              the email and that counts as a bounce. While a filter is paused, its contacts aren&apos;t sent to: they stay approved and go
              out when you resume it.
            </p>
          </header>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Filter</th>
                  <th className="px-3 py-2 text-right font-medium">Contacts</th>
                  <th className="px-3 py-2 text-right font-medium">Emailed</th>
                  <th className="px-3 py-2 text-right font-medium">Bounced</th>
                  <th className="px-3 py-2 font-medium">Sending</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {gateways.map((g) => {
                  const held = c.hold_gateways.includes(g.gateway);
                  return (
                    <tr key={g.gateway} className="border-t border-line">
                      <td className="px-3 py-2 font-medium">{GATEWAY_LABEL[g.gateway]}</td>
                      <td className="num px-3 py-2 text-right">{n(Number(g.contacts))}</td>
                      <td className="num px-3 py-2 text-right">{n(Number(g.emailed))}</td>
                      <td className={`num px-3 py-2 text-right ${Number(g.bounced) ? "font-semibold text-bad" : ""}`}>{n(Number(g.bounced))}</td>
                      <td className={`px-3 py-2 text-xs font-medium ${held ? "text-wait" : "text-go"}`}>
                        {held ? `Paused${Number(g.held) ? `: ${n(Number(g.held))} approved and waiting` : ""}` : "Sending normally"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <form action={setGatewayHold.bind(null, c.id, g.gateway, !held)}>
                          {held ? (
                            <ConfirmButton
                              className="btn text-xs"
                              message={
                                Number(g.held)
                                  ? `Resume sending to ${GATEWAY_LABEL[g.gateway]}? The ${n(Number(g.held))} approved contacts waiting behind it are handed to the sender straight away.`
                                  : `Resume sending to ${GATEWAY_LABEL[g.gateway]}? Its contacts will be sent to as they're approved.`
                              }
                            >
                              {Number(g.held) ? `Resume and send ${n(Number(g.held))}` : `Resume ${GATEWAY_LABEL[g.gateway]}`}
                            </ConfirmButton>
                          ) : (
                            <SubmitButton className="btn text-xs" pendingLabel="Pausing…">Pause {GATEWAY_LABEL[g.gateway]}</SubmitButton>
                          )}
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pullable > 0 && (
            <form action={takeBackHeld.bind(null, c.id)}>
              <SubmitButton pendingLabel="Taking them back…">
                Take {n(pullable)} contacts behind paused filters back out of Instantly before they&apos;re emailed
              </SubmitButton>
            </form>
          )}
        </section>
      )}

      {/* 4. Everyone: find, filter, download, remove */}
      <section id="people" className="flex scroll-mt-16 flex-col gap-2">
        <PeopleList
          scope={{ clientId, campaignId: c.id }}
          sp={sp}
          basePath={base}
          title="Everyone in this campaign"
          removable
          sequence={{ steps: c.steps.length, live: liveSteps(c), delays: c.steps.map((s) => s.delay_days) }}
          emptyText="No contacts yet. Add some above, from the Nexus Portal, a CSV file or by typing them in."
        />
      </section>
    </div>
  );
}
