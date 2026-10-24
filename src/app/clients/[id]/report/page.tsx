import { requireClientAccess } from "@/lib/auth";
import { getClient } from "@/lib/clients";
import Link from "next/link";
import { buildReport, RANGES } from "@/lib/report";
import { requireClient } from "@/lib/clients";
import { dateTime } from "@/lib/format";
import { TrendChart } from "@/components/stats/TrendChart";
import { ClientTiles, FunnelBars, HBars, StepPerformance } from "@/components/stats/Parts";
import { PrintButton } from "@/components/PrintButton";
import { sendingHealthReport } from "@/lib/mailboxHealth";
import { pct } from "@/lib/format";

const STATE_WORD: Record<string, string> = { sending: "sending", easing: "easing in", resting: "resting", paused: "paused", error: "not connected" };

// Client-facing: results only by default (no mailboxes, bounces or tooling); "Include sending health" adds a section
// on the sending domains when the client should see it. Print → "Save as PDF" to send it.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Report · ${client.name}` : "Report" };
}

export default async function ClientReportPage({ params, searchParams }: PageProps<"/clients/[id]/report">) {
  const clientId = Number((await params).id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const sp = await searchParams;
  const campaignId = Number(sp.campaign) || null;
  const client = await requireClient(clientId);
  const r = await buildReport(clientId, typeof sp.range === "string" ? sp.range : "30d", campaignId);
  const campaign = r.campaigns.find((c) => c.id === campaignId);
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const replyRows = r.replies.filter((x) => x.n > 0 && x.key !== "ooo").map((x) => ({ label: x.label, value: x.n }));
  // Sending health is for when the client should see it (it's left out by default: the report is about results).
  const withHealth = sp.health === "1";
  const health = withHealth ? await sendingHealthReport(clientId, r.range.from, r.range.to) : null;
  const q = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams({ range: r.range.key, ...(campaignId ? { campaign: String(campaignId) } : {}), ...(withHealth ? { health: "1" } : {}) });
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    return `/clients/${clientId}/report?${next}`;
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 print:max-w-none print:gap-4">
      <div className="flex flex-wrap items-center gap-1.5 print:hidden">
        {RANGES.map((x) => (
          <Link
            key={x.key}
            href={q({ range: x.key })}
            className={`rounded-md px-2.5 py-1 text-sm ${r.range.key === x.key ? "bg-ink text-paper" : "border border-line bg-card"}`}
          >
            {x.label}
          </Link>
        ))}
        <Link href={q({ health: withHealth ? null : "1" })} className={`rounded-md px-2.5 py-1 text-sm ${withHealth ? "bg-ink text-paper" : "border border-line bg-card"}`}>
          {withHealth ? "Sending health included" : "Include sending health"}
        </Link>
        <span className="ml-auto flex items-center gap-2">
          <Link href={`/clients/${clientId}/stats?range=${r.range.key}`} className="btn">Back to stats</Link>
          <PrintButton />
        </span>
      </div>

      <header className="border-b border-line pb-4">
        <div className="text-xs uppercase tracking-wide text-muted">Outbound email report</div>
        <h1 className="text-3xl font-semibold tracking-tight">{client.name}</h1>
        <p className="text-sm text-muted">
          {fmt(r.range.from)} – {fmt(r.range.to)}
          {campaign ? ` · ${campaign.name}` : " · all campaigns"} · compared with the {r.range.days} days before
        </p>
      </header>

      <ClientTiles now={r.now} before={r.before} />

      <section className="card flex flex-col gap-3 p-5 print:break-inside-avoid">
        <h2 className="font-semibold">From first email to meeting</h2>
        <FunnelBars h={r.now} />
      </section>

      <section className="card flex flex-col gap-3 p-5 print:break-inside-avoid">
        <h2 className="font-semibold">Activity over the period</h2>
        <TrendChart days={r.daily} />
      </section>

      <div className="grid grid-cols-2 gap-5 print:break-inside-avoid">
        <section className="card flex flex-col gap-3 p-5">
          <h2 className="font-semibold">How each email performed</h2>
          <StepPerformance steps={r.steps} />
        </section>
        <section className="card flex flex-col gap-3 p-5">
          <h2 className="font-semibold">What people said</h2>
          {replyRows.length ? <HBars rows={replyRows} /> : <p className="text-sm text-muted">No replies in this period yet.</p>}
          <p className="text-xs text-muted">Automatic out-of-office replies are left out.</p>
        </section>
      </div>

      <section className="card flex flex-col gap-3 p-5 print:break-inside-avoid">
        <h2 className="font-semibold">Meetings booked</h2>
        {r.meetings.length === 0 ? (
          <p className="text-sm text-muted">No meetings booked in this period yet.</p>
        ) : (
          <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1.5 font-medium">Who</th>
                <th className="font-medium">Company</th>
                <th className="font-medium">Booked</th>
                <th className="font-medium">Meeting</th>
              </tr>
            </thead>
            <tbody>
              {r.meetings.map((m, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1.5 font-medium">{m.name}</td>
                  <td>{m.company ?? "–"}</td>
                  <td className="text-muted">{dateTime(m.booked_at)}</td>
                  <td>{m.starts_at ? dateTime(m.starts_at) : m.source === "pipeline" ? "Agreed (in pipeline)" : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {health && (
        <section className="card flex flex-col gap-3 p-5 print:break-inside-avoid">
          <div>
            <h2 className="font-semibold">Sending health</h2>
            <p className="text-xs text-muted">
              How the sending domains did over the period. Warmup emails are exchanged between mailboxes to keep their reputation up;
              where they land shows whether mail from the domain reaches the inbox.
            </p>
          </div>
          <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1.5 font-medium">Domain</th>
                <th className="text-right font-medium">Emails sent</th>
                <th className="text-right font-medium">Bounced</th>
                <th className="text-right font-medium">Warmup in inbox</th>
                <th className="font-medium">Mailboxes now</th>
              </tr>
            </thead>
            <tbody>
              {health.domains.map((d) => (
                <tr key={d.domain} className="border-t border-line">
                  <td className="py-1.5 font-medium">{d.domain}</td>
                  <td className="num text-right">{d.sent.toLocaleString("en-GB")}</td>
                  <td className="num text-right">{pct(d.bounced, d.sent)}</td>
                  <td className="num text-right">{pct(d.warmupInbox, d.warmupSent)}</td>
                  <td className="text-xs">{d.states.map((s) => `${s.n} ${STATE_WORD[s.key] ?? s.key}`).join(", ") || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {health.actions.length > 0 && (
            <div>
              <h3 className="text-sm font-medium">What was done to protect them</h3>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {health.actions.slice(0, 12).map((a) => (
                  <li key={a.id}><span className="text-xs text-muted">{dateTime(a.at)}</span> {a.message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <p className="text-xs text-muted">
        Replies and interest are counted per person. &ldquo;Interested&rdquo; means they asked to talk or for more information.
      </p>
    </div>
  );
}
