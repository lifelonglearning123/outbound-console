import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { all, get } from "@/lib/db";
import { campaignStepProblems, getCampaign, isNexus, liveSteps } from "@/lib/campaigns";
import { campaignProgress } from "@/lib/progress";
import { approvedBreakdown } from "@/lib/push";
import { AutoRefresh } from "@/components/AutoRefresh";
import { holdStatus } from "@/lib/hold";
import { HoldPanel } from "@/components/HoldPanel";
import { nowMs, pct } from "@/lib/format";
import { breakdown, DIMENSIONS, peopleHref, totals, type Dimension, type PeopleFilters } from "@/lib/people";
import { daily, lastDays } from "@/lib/report";
import { Breakdown } from "@/components/Breakdown";
import { StageBars } from "@/components/stats/Parts";
import { TrendChart } from "@/components/stats/TrendChart";
import { utcToZoned } from "@/lib/startTime";

const n = (v: number) => v.toLocaleString("en-GB");

/** The periods "How it's going" can be looked at over: people first emailed in that period, and what they did. */
const PERIODS = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "Quarter" },
] as const;
const minusDays = (ymd: string, d: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) - d * 86400_000).toISOString().slice(0, 10);

/** Sending tab: how the campaign is doing and who responds, with every number opening the people behind it. */
export default async function CampaignSendingPage({ params, searchParams }: PageProps<"/clients/[id]/campaigns/[cid]">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  const sp = await searchParams;
  const dim: Dimension = DIMENSIONS.find((d) => d.key === sp.by)?.key ?? "host";
  const period = PERIODS.find((x) => x.key === sp.period) ?? PERIODS[0];
  const today = utcToZoned(new Date(nowMs()), c.schedule.timezone).slice(0, 10);
  const span =
    period.key === "today" ? { from: today, to: today }
    : period.key === "yesterday" ? { from: minusDays(today, 1), to: minusDays(today, 1) }
    : period.key === "7d" ? { from: minusDays(today, 6), to: today }
    : period.key === "30d" ? { from: minusDays(today, 29), to: today }
    : period.key === "90d" ? { from: minusDays(today, 89), to: today }
    : null;
  const inPeriod: PeopleFilters = span ? { from: span.from, to: span.to } : {};
  const p = await campaignProgress(c.id);
  const split = await approvedBreakdown(c.id);
  const base = `/clients/${clientId}/campaigns/${c.id}`;
  const scope = { clientId, campaignId: c.id };
  const rows = await breakdown(scope, dim, inPeriod);
  const t = totals(rows);
  const people = (f: PeopleFilters) => peopleHref(`${base}/contacts`, {}, { ...inPeriod, ...f });
  const here = (q: Record<string, string>) => {
    const u = new URLSearchParams({ ...(dim !== "host" ? { by: dim } : {}), ...(period.key !== "all" ? { period: period.key } : {}), ...q });
    for (const [k, v] of [...u]) if ((k === "period" && v === "all") || (k === "by" && v === "host")) u.delete(k);
    const s = u.toString();
    return `${base}${s ? `?${s}` : ""}`;
  };

  const days = await all<{ date: string; sent: number; opened: number; replied: number; bounced: number }>(
    `SELECT d.date, d.sent, d.opened, d.replied,
       (SELECT COUNT(*) FROM emails e JOIN leads l ON l.id = e.lead_id
         WHERE e.campaign_id = d.campaign_id AND e.direction = 'out' AND l.instantly_status = -1 AND substr(e.sent_at, 1, 10) = d.date) bounced
     FROM daily_stats d WHERE d.campaign_id = ? AND d.sent > 0 ${span ? "AND d.date BETWEEN ? AND ?" : ""} ORDER BY d.date DESC LIMIT ${span ? 92 : 14}`,
    ...(span ? [c.id, span.from, span.to] : [c.id]),
  );
  const recent = days.reduce((a, d) => ({ sent: a.sent + d.sent, opened: a.opened + d.opened, replied: a.replied + d.replied, bounced: a.bounced + d.bounced }), { sent: 0, opened: 0, replied: 0, bounced: 0 });
  // The chart covers the campaign's life so far: at least two weeks, at most ninety days.
  const first = (await get<{ d: string | null }>("SELECT MIN(date) d FROM daily_stats WHERE campaign_id = ? AND sent > 0", c.id))?.d;
  const life = first ? Math.min(90, Math.max(14, Math.round((nowMs() - Date.parse(`${first}T00:00:00Z`)) / 86400_000) + 1)) : 14;
  // A single day is shown within the week leading up to it, so the chart still has a shape.
  const chartRange = span
    ? (() => {
        const from = span.from === span.to ? minusDays(span.to, 6) : span.from;
        const days = Math.round((Date.parse(span.to) - Date.parse(from)) / 86400_000) + 1;
        return { from, to: span.to, days, key: period.key, label: period.label };
      })()
    : lastDays(life);
  const chart = await daily(scope, chartRange);

  const live = liveSteps(c);
  const hasHold = c.managed === 1 && (c.hold_after !== null || c.release_to !== null);
  const hold = hasHold ? await holdStatus(c.id) : null;
  const stepProblems = Object.fromEntries(c.steps.map((_, i) => [i + 1, campaignStepProblems(c.steps.slice(0, i + 1))]));
  const reached = c.steps.length > 1
    ? await all<{ step: number; n: number }>(
        "SELECT step, COUNT(DISTINCT lead_id) n FROM emails WHERE campaign_id = ? AND direction = 'out' AND step IS NOT NULL GROUP BY step",
        c.id,
      )
    : [];

  // Where the user should go next, when nothing is being sent yet. A Nexus campaign's people are written,
  // approved and handed over from Nexus, so its hints point at the contacts here and say Nexus is next.
  const nexus = isNexus(c);
  const approveHref = nexus ? `${base}/contacts` : `${base}/approve`;
  const next =
    p.contacts === 0
      ? { href: `${base}/contacts`, text: nexus ? "No contacts yet: Nexus adds them when the campaign starts there." : "Add contacts to this campaign." }
      : p.ready > 0 || split.sendable > 0
        ? { href: approveHref, text: nexus ? `${n(p.ready + split.sendable)} contacts are waiting for Nexus to hand them over.` : `${n(p.ready + split.sendable)} contacts are ready to send.` }
        : split.approved > 0
          ? { href: approveHref, text: `${n(split.approved)} approved contacts are held or waiting; see why.` }
        : p.checking > 0
          ? { href: `${base}/contacts`, text: `${n(p.checking)} addresses are still being checked.` }
          : p.unconfirmed > 0 && !nexus
            ? { href: approveHref, text: `${n(p.unconfirmed)} unconfirmed contacts could be sent in small batches.` }
            : null;
  const highBounce = t.emailed > 0 && t.bounced / t.emailed > 0.03;
  // Anyone ever handed to the sender: the results show (and the period can be changed) even when a period is empty.
  const everSent = p.sending > 0 || p.sent > 0;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={!!hold?.writing} />

      {p.sending === 0 && next && !c.start_at && (
        <div className="card border-wait/40 bg-wait-soft/40 p-4 text-sm">
          Nothing is being sent yet. <Link href={next.href} className="font-medium underline">{next.text}</Link>
        </div>
      )}
      {c.status === "draft" && p.sending > 0 && !c.start_at && (
        <div className="card border-wait/40 bg-wait-soft/40 p-4 text-sm">
          {n(p.sending)} contacts are approved and loaded, but sending hasn&apos;t been started. Use <strong>Start sending</strong> above.
        </div>
      )}

      {hold && <HoldPanel campaignId={c.id} clientId={clientId} status={hold} stepProblems={stepProblems} />}

      {everSent && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">How it&apos;s going</h3>
            <nav aria-label="Period" className="flex flex-wrap gap-1 text-xs">
              {PERIODS.map((x) => (
                <Link
                  key={x.key}
                  href={here({ period: x.key })}
                  scroll={false}
                  aria-current={x.key === period.key ? "page" : undefined}
                  className={`rounded-md border px-2.5 py-1 ${x.key === period.key ? "border-ink bg-ink text-paper" : "border-line text-muted hover:border-muted hover:text-ink"}`}
                >
                  {x.label}
                </Link>
              ))}
            </nav>
          </div>
          {t.handed === 0 ? (
            <p className="card p-6 text-center text-sm text-muted">Nobody was first emailed {period.key === "today" ? "today" : period.key === "yesterday" ? "yesterday" : `in the last ${period.label.toLowerCase()}`}.</p>
          ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="card flex flex-col gap-3 p-5">
              <div>
                <h4 className="text-sm font-medium">From first email to meeting</h4>
                <p className="text-xs text-muted">{span ? `People first emailed ${period.key === "today" ? "today" : period.key === "yesterday" ? "yesterday" : `in the last ${period.label.toLowerCase()}`}. ` : ""}Click a bar to see who.</p>
              </div>
              <StageBars
                stages={[
                  { label: "Emailed", n: t.emailed, href: people({ status: "emailed" }) },
                  { label: "Opened", n: t.opened, href: people({ status: "opened" }), note: pct(t.opened, t.emailed) },
                  { label: "Replied", n: t.replied, href: people({ status: "replied" }), note: pct(t.replied, t.emailed) },
                  { label: "Interested", n: t.interested, href: people({ status: "interested" }), note: pct(t.interested, t.emailed) },
                  { label: "Meeting booked", n: t.meetings, href: people({ status: "meeting" }), note: pct(t.meetings, t.emailed) },
                ]}
              />
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {t.queued > 0 && (
                  <Link href={people({ status: "queued" })} className="hover:underline">
                    <span className="num text-ink">{n(t.queued)}</span> queued, not emailed yet
                  </Link>
                )}
                <Link href={people({ status: "bounced" })} className={`hover:underline ${highBounce ? "text-bad" : ""}`}>
                  <span className="num">{n(t.bounced)}</span> bounced ({pct(t.bounced, t.emailed)})
                </Link>
                <Link href={people({ status: "unsubscribed" })} className="hover:underline">
                  <span className="num">{n(t.unsubscribed)}</span> unsubscribed
                </Link>
              </p>
            </div>
            <div className="card flex flex-col gap-3 p-5">
              <h4 className="text-sm font-medium">Sends and replies per day</h4>
              <TrendChart days={chart} />
              {days.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted">{days.length === 1 ? "The sending day" : `The last ${days.length} sending days`}, with opens and bounces</summary>
                  <table className="mt-2 w-full">
                    <thead className="text-left text-muted">
                      <tr>
                        <th className="py-1 font-medium">Day</th>
                        <th className="text-right font-medium">Sent</th>
                        <th className="text-right font-medium">Opened</th>
                        <th className="text-right font-medium">Replied</th>
                        <th className="text-right font-medium">Bounced</th>
                      </tr>
                    </thead>
                    <tbody>
                      {days.map((d) => (
                        <tr key={d.date} className="border-t border-line">
                          <td className="py-1">{d.date}</td>
                          <td className="num text-right">{n(d.sent)}</td>
                          <td className="num text-right">{n(d.opened)}</td>
                          <td className="num text-right">{n(d.replied)}</td>
                          <td className={`num text-right ${d.sent && d.bounced / d.sent > 0.03 ? "text-bad" : ""}`}>{n(d.bounced)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-line font-medium">
                        <td className="py-1">Together</td>
                        <td className="num text-right">{n(recent.sent)}</td>
                        <td className="num text-right">{n(recent.opened)} <span className="font-normal text-muted">{pct(recent.opened, recent.sent)}</span></td>
                        <td className="num text-right">{n(recent.replied)} <span className="font-normal text-muted">{pct(recent.replied, recent.sent)}</span></td>
                        <td className={`num text-right ${recent.sent && recent.bounced / recent.sent > 0.03 ? "text-bad" : ""}`}>
                          {n(recent.bounced)} <span className="font-normal text-muted">{pct(recent.bounced, recent.sent)}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          </div>
          )}
          {highBounce && (
            <p className="text-xs text-bad">
              Bounces above 3% put the mailboxes at risk. <Link href={people({ status: "bounced" })} className="underline">See who bounced</Link> and
              break them down by email host below before approving more.
            </p>
          )}
        </section>
      )}

      {reached.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">The sequence</h3>
          <div className="flex flex-wrap gap-2">
            {c.steps.map((_, i) => (
              <div key={i} className="card px-3 py-2 text-sm">
                <div className="text-xs text-muted">{i === 0 ? "Email 1" : `Follow-up ${i + 1}`}</div>
                <div>
                  <span className="num font-semibold">{n(reached.find((r) => r.step === i + 1)?.n ?? 0)}</span>{" "}
                  <span className="text-xs text-muted">people sent it</span>
                </div>
                {i + 1 > live && <div className="text-xs text-wait">On hold</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {t.contacts > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Who responds</h3>
          <Breakdown
            dim={dim}
            rows={rows}
            total={t}
            dimHref={(d) => here({ by: d })}
            people={people}
            exportHref={`/clients/${clientId}/people/export?campaign=${c.id}&by=${dim}`}
          />
        </section>
      )}

      {p.contacts > 0 && (
        <p className="text-sm">
          <Link href={`${base}/contacts#people`} className="underline">
            See all {n(p.contacts)} people in this campaign: search, filter or download them →
          </Link>
        </p>
      )}
    </div>
  );
}
