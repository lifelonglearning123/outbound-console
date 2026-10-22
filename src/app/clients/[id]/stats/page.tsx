import { requireClientAccess } from "@/lib/auth";
import { getClient } from "@/lib/clients";
import Link from "next/link";
import { buildReport, RANGES } from "@/lib/report";
import { requireClient } from "@/lib/clients";
import { ago, pct } from "@/lib/format";
import { ACCOUNT_STATUS } from "@/lib/instantly";
import { breakdown, DIMENSIONS, nonPeopleParams, peopleHref, totals, type Dimension } from "@/lib/people";
import { TrendChart } from "@/components/stats/TrendChart";
import { FunnelBars, HBars, HeadlineTiles, ReplyHeatmap, StepPerformance } from "@/components/stats/Parts";
import { Breakdown } from "@/components/Breakdown";
import { PeopleList } from "@/components/PeopleList";

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

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Stats · ${client.name}` : "Stats" };
}

export default async function StatsPage({ params, searchParams }: PageProps<"/clients/[id]/stats">) {
  const clientId = Number((await params).id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const sp = await searchParams;
  const rangeKey = typeof sp.range === "string" ? sp.range : "30d";
  const campaignId = Number(sp.campaign) || null;
  const dim: Dimension = DIMENSIONS.find((d) => d.key === sp.by)?.key ?? "host";
  const client = await requireClient(clientId);
  const r = await buildReport(clientId, rangeKey, campaignId);
  // The breakdown follows the date range: people first emailed in it, and what has happened to them since.
  const emailedInRange = { from: r.range.from, to: r.range.to };
  const rows = await breakdown({ clientId, campaignId }, dim, emailedInRange);
  const rules = { bounce: 0.03 };

  const href = (patch: Record<string, string | number | null>) => {
    const q = new URLSearchParams();
    const next = { range: r.range.key, campaign: campaignId, by: dim === "host" ? null : dim, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, String(v));
    return `/clients/${clientId}/stats?${q}`;
  };
  const chip = (active: boolean) => `rounded-md px-2.5 py-1 text-sm ${active ? "bg-ink text-paper" : "border border-line bg-card"}`;
  const fmtRange = (a: string, b: string) =>
    `${new Date(`${a}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(`${b}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h2 className="font-semibold">Stats</h2>
        <p className="text-sm text-muted">How the sending is doing, with the previous period alongside.</p>
      </header>
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

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_380px]">
        <Section title="Sends and replies" note="Two panels on one timeline, so replies aren't dwarfed by sends.">
          <TrendChart days={r.daily} />
        </Section>
        <div className="flex flex-col gap-5">
          <Section title="Funnel">
            <FunnelBars h={r.now} />
          </Section>
          <Section title="Replies by type" note="Leads by their reply, tagged by AI (you can retag on the Replies page).">
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
        title="Who responds"
        note={`People first emailed ${fmtRange(r.range.from, r.range.to)}, and what has happened to them since. Click a row to list them below.`}
      >
        <Breakdown
          dim={dim}
          rows={rows}
          total={totals(rows)}
          dimHref={(d) => href({ by: d === "host" ? null : d })}
          people={(f) => peopleHref(`/clients/${clientId}/stats`, nonPeopleParams(sp), { ...emailedInRange, ...f })}
          exportHref={`/clients/${clientId}/people/export?${new URLSearchParams({ by: dim, ...emailedInRange, ...(campaignId ? { campaign: String(campaignId) } : {}) })}`}
        />
      </Section>

      <section id="people" className="flex scroll-mt-16 flex-col gap-2">
        <PeopleList
          scope={{ clientId, campaignId }}
          sp={sp}
          basePath={`/clients/${clientId}/stats`}
          title={campaignId ? "People in this campaign" : "People in all campaigns"}
        />
        <p className="text-xs text-muted">
          Everyone added from this console, whatever the date range above; set the Emailed dates to narrow it. Campaigns built directly in
          Instantly don&apos;t list individual people here.
        </p>
      </section>

      <p className="text-xs text-muted">
        Opens: {r.now.opened.toLocaleString("en-GB")} unique opens ({pct(r.now.opened, r.now.sent)} of emails sent). Treat these loosely: Apple Mail
        reports opens that never happened and Outlook often hides real ones, so the figures on this page are built on replies instead.
      </p>
    </div>
  );
}
