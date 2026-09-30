import { requireClientAccess } from "@/lib/auth";
import Link from "next/link";
import { buildReport, RANGES } from "@/lib/report";
import { requireClient } from "@/lib/clients";
import { dateTime } from "@/lib/format";
import { TrendChart } from "@/components/stats/TrendChart";
import { ClientTiles, FunnelBars, HBars, StepPerformance } from "@/components/stats/Parts";
import { PrintButton } from "@/components/PrintButton";

// Client-facing: results only (no mailboxes, bounces or tooling). Print → "Save as PDF" to send it.
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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 print:max-w-none print:gap-4">
      <div className="flex flex-wrap items-center gap-1.5 print:hidden">
        {RANGES.map((x) => (
          <Link
            key={x.key}
            href={`/clients/${clientId}/report?range=${x.key}${campaignId ? `&campaign=${campaignId}` : ""}`}
            className={`rounded-md px-2.5 py-1 text-sm ${r.range.key === x.key ? "bg-ink text-paper" : "border border-line bg-card"}`}
          >
            {x.label}
          </Link>
        ))}
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

      <p className="text-xs text-muted">
        Replies and interest are counted per person. &ldquo;Interested&rdquo; means they asked to talk or for more information.
      </p>
    </div>
  );
}
