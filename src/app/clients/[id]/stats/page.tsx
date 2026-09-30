import { requireClientAccess } from "@/lib/auth";
import Link from "next/link";
import { buildReport, leadList, LEAD_FILTERS, RANGES } from "@/lib/report";
import { requireClient } from "@/lib/clients";
import { ago, dateTime, pct } from "@/lib/format";
import { ACCOUNT_STATUS } from "@/lib/instantly";
import { INTEREST_LABELS } from "@/lib/triage";
import { TrendChart } from "@/components/stats/TrendChart";
import { FunnelBars, HBars, HeadlineTiles, ReplyHeatmap, StepPerformance } from "@/components/stats/Parts";

function Section({ title, note, children, className = "" }: { title: string; note?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card flex flex-col gap-3 p-5 ${className}`}>
      <div>
        <h2 className="font-semibold">{title}</h2>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

export default async function StatsPage({ params, searchParams }: PageProps<"/clients/[id]/stats">) {
  const clientId = Number((await params).id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const sp = await searchParams;
  const rangeKey = typeof sp.range === "string" ? sp.range : "30d";
  const campaignId = Number(sp.campaign) || null;
  const leadFilter = typeof sp.leads === "string" ? sp.leads : "interested_no_meeting";
  const client = await requireClient(clientId);
  const r = await buildReport(clientId, rangeKey, campaignId);
  const leads = await leadList({ clientId, campaignId }, leadFilter);
  const rules = { bounce: 0.03 };

  const href = (patch: Record<string, string | number | null>) => {
    const q = new URLSearchParams();
    const next = { range: r.range.key, campaign: campaignId, leads: leadFilter, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, String(v));
    return `/clients/${clientId}/stats?${q}`;
  };
  const chip = (active: boolean) => `rounded-md px-2.5 py-1 text-sm ${active ? "bg-ink text-paper" : "border border-line bg-card"}`;
  const fmtRange = (a: string, b: string) =>
    `${new Date(`${a}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(`${b}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;

  return (
    <div className="flex flex-col gap-5">
      {/* Filters: one row above everything they affect */}
      <div className="flex flex-wrap items-center gap-1.5">
        {RANGES.map((x) => (
          <Link key={x.key} href={href({ range: x.key })} className={chip(r.range.key === x.key)}>{x.label}</Link>
        ))}
        <span className="mx-2 h-5 w-px bg-line" />
        <Link href={href({ campaign: null })} className={chip(!campaignId)}>All campaigns</Link>
        {r.campaigns.map((c) => (
          <Link key={c.id} href={href({ campaign: c.id })} className={chip(campaignId === c.id)}>{c.name}</Link>
        ))}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted">
          {fmtRange(r.range.from, r.range.to)} vs {fmtRange(r.previousRange.from, r.previousRange.to)} · synced {ago(r.lastSync)}
          <Link href={`/clients/${clientId}/report?range=${r.range.key}${campaignId ? `&campaign=${campaignId}` : ""}`} className="btn">
            Client report
          </Link>
        </span>
      </div>

      <HeadlineTiles now={r.now} before={r.before} />

      <div className="grid grid-cols-[1fr_380px] gap-5">
        <Section title="Sends and replies" note="Two panels on one timeline, so replies aren't dwarfed by sends.">
          <TrendChart days={r.daily} />
        </Section>
        <div className="flex flex-col gap-5">
          <Section title="Funnel">
            <FunnelBars h={r.now} />
          </Section>
          <Section title="Replies by type" note="Leads by their reply, tagged by AI (you can retag in the Inbox).">
            <HBars rows={r.replies.map((x) => ({ label: x.label, value: x.n }))} />
          </Section>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <Section title="Step performance">
          <StepPerformance steps={r.steps} />
        </Section>
        <Section title="Best time for replies" note="When replies arrive tells you when leads are reading.">
          <ReplyHeatmap grid={r.replyTimes} />
        </Section>
      </div>

      <Section
        title="Mailbox health"
        note={`${client.name}'s sending mailboxes in this period. Bounce rate above 3% hurts every mailbox on the domain.`}
      >
        <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1.5 font-medium">Mailbox</th>
              <th className="font-medium">Status</th>
              <th className="text-right font-medium">Sent</th>
              <th className="text-right font-medium">Replies</th>
              <th className="text-right font-medium">Reply rate</th>
              <th className="text-right font-medium">Bounce rate</th>
              <th className="text-right font-medium">Warmup health</th>
            </tr>
          </thead>
          <tbody>
            {r.mailboxes.map((m) => {
              const bounce = m.sent ? m.bounced / m.sent : 0;
              return (
                <tr key={m.email} className="border-t border-line">
                  <td className="py-1.5 font-mono text-xs">{m.email}</td>
                  <td className={m.status === 1 ? "text-go" : "text-bad"}>
                    {ACCOUNT_STATUS[m.status ?? 0] ?? "–"}
                    {m.auto_paused_reason && <span className="ml-1 text-xs">({m.auto_paused_reason})</span>}
                  </td>
                  <td className="num text-right">{m.sent}</td>
                  <td className="num text-right">{m.replied}</td>
                  <td className="num text-right">{pct(m.replied, m.sent)}</td>
                  <td className={`num text-right ${bounce > rules.bounce ? "font-semibold text-bad" : ""}`}>
                    {bounce > rules.bounce && "⚠ "}{pct(m.bounced, m.sent)}
                  </td>
                  <td className={`num text-right ${m.warmup_score !== null && m.warmup_score < 70 ? "text-bad" : ""}`}>{m.warmup_score ?? "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section
        title="Leads"
        note="Everyone emailed from this console so far (not limited to the date range). Campaigns built directly in Instantly don't list individual leads here."
      >
        <div className="flex flex-wrap gap-1.5">
          {LEAD_FILTERS.map((f) => (
            <Link key={f.key} href={href({ leads: f.key })} className={chip(leadFilter === f.key)} scroll={false}>{f.label}</Link>
          ))}
        </div>
        <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1.5 font-medium">Lead</th>
              <th className="font-medium">Campaign</th>
              <th className="text-right font-medium">Emails sent</th>
              <th className="font-medium">Last email</th>
              <th className="font-medium">Reply</th>
              <th className="font-medium">Meeting</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td colSpan={6} className="py-3 text-muted">No leads match.</td></tr>
            )}
            {leads.slice(0, 300).map((l) => (
              <tr key={l.id} className="border-t border-line">
                <td className="py-1.5">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-xs text-muted">{l.company ?? l.email}</div>
                </td>
                <td className="text-xs">{l.campaign}</td>
                <td className="num text-right">{l.steps_sent}</td>
                <td className="text-xs text-muted">{dateTime(l.last_sent)}</td>
                <td className="text-xs">
                  {l.replied_at ? (
                    <Link href={`/inbox?f=all&client=${clientId}`} className="hover:underline">
                      {INTEREST_LABELS[l.interest ?? "other"] ?? "Replied"} · {dateTime(l.replied_at)}
                    </Link>
                  ) : [-1, -2].includes(l.status ?? 0) ? (
                    <span className="text-bad">{l.status === -1 ? "Bounced" : "Unsubscribed"}</span>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </td>
                <td className="text-xs">{l.meeting_at ? <span className="text-go">✓ {dateTime(l.meeting_at)}</span> : <span className="text-muted">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {leads.length > 300 && <p className="text-xs text-muted">Showing the first 300 of {leads.length}.</p>}
      </Section>

      <p className="text-xs text-muted">
        Opens: {r.now.opened.toLocaleString("en-GB")} unique opens ({pct(r.now.opened, r.now.sent)} of emails sent). Treat these loosely: Apple Mail
        reports opens that never happened and Outlook often hides real ones, so the figures on this page are built on replies instead.
      </p>
    </div>
  );
}
