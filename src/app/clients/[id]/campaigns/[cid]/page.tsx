import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { all } from "@/lib/db";
import { campaignStepProblems, getCampaign, liveSteps } from "@/lib/campaigns";
import { campaignProgress } from "@/lib/progress";
import { AutoRefresh } from "@/components/AutoRefresh";
import { holdStatus } from "@/lib/hold";
import { HoldPanel } from "@/components/HoldPanel";
import { LeadJourney } from "@/components/LeadJourney";
import { pct } from "@/lib/format";

const n = (v: number) => v.toLocaleString("en-GB");

/** Sending tab: what has gone out, how it's doing, and who is where in the sequence. */
export default async function CampaignSendingPage({ params }: PageProps<"/clients/[id]/campaigns/[cid]">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  const p = await campaignProgress(c.id);
  const base = `/clients/${clientId}/campaigns/${c.id}`;

  const days = await all<{ date: string; sent: number; opened: number; replied: number; bounced: number }>(
    `SELECT d.date, d.sent, d.opened, d.replied,
       (SELECT COUNT(*) FROM emails e JOIN leads l ON l.id = e.lead_id
         WHERE e.campaign_id = d.campaign_id AND e.direction = 'out' AND l.instantly_status = -1 AND substr(e.sent_at, 1, 10) = d.date) bounced
     FROM daily_stats d WHERE d.campaign_id = ? AND d.sent > 0 ORDER BY d.date DESC LIMIT 14`,
    c.id,
  );
  const totals = days.reduce((a, d) => ({ sent: a.sent + d.sent, opened: a.opened + d.opened, replied: a.replied + d.replied, bounced: a.bounced + d.bounced }), { sent: 0, opened: 0, replied: 0, bounced: 0 });

  const live = liveSteps(c);
  const hasHold = c.managed === 1 && (c.hold_after !== null || c.release_to !== null);
  const hold = hasHold ? await holdStatus(c.id) : null;
  const stepProblems = Object.fromEntries(c.steps.map((_, i) => [i + 1, campaignStepProblems(c.steps.slice(0, i + 1))]));

  // Where the user should go next, when nothing is being sent yet.
  const next =
    p.contacts === 0
      ? { href: `${base}/contacts`, text: "Add contacts to this campaign." }
      : p.waiting > 0 || p.approved - p.sending > 0
        ? { href: `${base}/approve`, text: `${n(p.waiting + (p.approved - p.sending))} contacts are ready for you to approve and send.` }
        : p.checked < p.contacts
          ? { href: `${base}/contacts`, text: "Check the contacts' addresses before sending." }
          : null;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={!!hold?.writing} />

      {p.sending === 0 && next && (
        <div className="card border-wait/40 bg-wait-soft/40 p-4 text-sm">
          Nothing is being sent yet. <Link href={next.href} className="font-medium underline">{next.text}</Link>
        </div>
      )}
      {c.status === "draft" && p.sending > 0 && (
        <div className="card border-wait/40 bg-wait-soft/40 p-4 text-sm">
          {n(p.sending)} contacts are approved and loaded, but sending hasn&apos;t been started. Use <strong>Start sending</strong> above.
        </div>
      )}

      {hold && <HoldPanel campaignId={c.id} clientId={clientId} status={hold} stepProblems={stepProblems} />}

      {days.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Recent days</h3>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Day</th>
                  <th className="num px-3 py-2 text-right font-medium">Sent</th>
                  <th className="num px-3 py-2 text-right font-medium">Opened</th>
                  <th className="num px-3 py-2 text-right font-medium">Replied</th>
                  <th className="num px-3 py-2 text-right font-medium">Bounced</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date} className="border-t border-line">
                    <td className="px-3 py-1.5">{d.date}</td>
                    <td className="num px-3 py-1.5 text-right">{n(d.sent)}</td>
                    <td className="num px-3 py-1.5 text-right">{n(d.opened)}</td>
                    <td className="num px-3 py-1.5 text-right">{n(d.replied)}</td>
                    <td className={`num px-3 py-1.5 text-right ${d.sent && d.bounced / d.sent > 0.03 ? "text-bad" : ""}`}>{n(d.bounced)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line bg-paper font-medium">
                  <td className="px-3 py-1.5">Last {days.length} sending days</td>
                  <td className="num px-3 py-1.5 text-right">{n(totals.sent)}</td>
                  <td className="num px-3 py-1.5 text-right">{n(totals.opened)} <span className="text-xs font-normal text-muted">{pct(totals.opened, totals.sent)}</span></td>
                  <td className="num px-3 py-1.5 text-right">{n(totals.replied)} <span className="text-xs font-normal text-muted">{pct(totals.replied, totals.sent)}</span></td>
                  <td className={`num px-3 py-1.5 text-right ${totals.sent && totals.bounced / totals.sent > 0.03 ? "text-bad" : ""}`}>
                    {n(totals.bounced)} <span className="text-xs font-normal text-muted">{pct(totals.bounced, totals.sent)}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {totals.sent > 0 && totals.bounced / totals.sent > 0.03 && (
            <p className="text-xs text-bad">Bounces above 3% put the mailboxes at risk. Check addresses on the Contacts tab before approving more.</p>
          )}
        </section>
      )}

      {c.managed ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Who has had what</h3>
          <LeadJourney campaignId={c.id} stepCount={c.steps.length} live={live} delays={c.steps.map((s) => s.delay_days)} />
        </section>
      ) : null}
    </div>
  );
}
