import Link from "next/link";
import { all, get, getSetting } from "@/lib/db";
import { listClients } from "@/lib/clients";
import { funnelFor } from "@/lib/stats";
import { ago, nowMs } from "@/lib/format";
import { Funnel } from "@/components/Funnel";
import { SendTimeline } from "@/components/SendTimeline";
import { SyncButton } from "@/components/SyncButton";

type ClientRow = {
  id: number; name: string; key_status: string | null; key_message: string | null;
  active: number; review: number; approved: number; sent_today: number; replies_7d: number; interested_7d: number; mailboxes_bad: number;
};

export default function OverviewPage() {
  const clients = listClients();
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(nowMs() - 7 * 86400_000).toISOString();
  const rows = all<ClientRow>(
    `SELECT c.id, c.name, c.key_status, c.key_message,
       (SELECT COUNT(*) FROM campaigns x WHERE x.client_id = c.id AND x.status = 'active') active,
       (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id AND l.stage = 'review') review,
       (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id AND l.stage = 'approved') approved,
       (SELECT COALESCE(SUM(sent),0) FROM daily_stats d WHERE d.client_id = c.id AND d.date = ?) sent_today,
       (SELECT COUNT(*) FROM emails e WHERE e.client_id = c.id AND e.direction = 'in' AND e.sent_at >= ?) replies_7d,
       (SELECT COUNT(*) FROM emails e WHERE e.client_id = c.id AND e.direction = 'in' AND e.interest = 'interested' AND e.sent_at >= ?) interested_7d,
       (SELECT COUNT(*) FROM mailboxes m WHERE m.client_id = c.id AND (m.status != 1 OR m.auto_paused_at IS NOT NULL)) mailboxes_bad
     FROM clients c WHERE c.archived = 0 ORDER BY c.name COLLATE NOCASE`,
    today, week, week,
  );

  const attention = {
    review: rows.reduce((a, r) => a + r.review, 0),
    approved: rows.reduce((a, r) => a + r.approved, 0),
    replies: get<{ n: number }>("SELECT COUNT(*) n FROM emails WHERE direction = 'in' AND is_unread = 1 AND (interest IS NULL OR interest IN ('interested','not_now','other'))")?.n ?? 0,
    paused: get<{ n: number }>("SELECT COUNT(*) n FROM mailboxes WHERE auto_paused_at IS NOT NULL AND status != 1")?.n ?? 0,
    idle: all<{ id: number; client_id: number; name: string; not_sending: string }>(
      "SELECT id, client_id, name, not_sending FROM campaigns WHERE status = 'active' AND not_sending IS NOT NULL",
    ),
    broken: rows.filter((r) => r.key_status === "error"),
  };

  if (clients.length === 0) {
    return (
      <div className="mx-auto mt-24 flex max-w-md flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Outbound Console</h1>
        <p className="text-sm text-muted">Add your first client with their Instantly API key to see campaigns, mailboxes and replies here.</p>
        <Link href="/clients/new" className="btn-go">Add a client</Link>
      </div>
    );
  }

  const items = [
    attention.review > 0 && { href: "/approvals", tone: "wait", text: `${attention.review} leads waiting for email approval` },
    attention.approved > 0 && { href: "/approvals", tone: "go", text: `${attention.approved} approved leads not yet sent to Instantly` },
    attention.replies > 0 && { href: "/inbox", tone: "wait", text: `${attention.replies} unread replies need a look` },
    attention.paused > 0 && { href: "/mailboxes", tone: "bad", text: `${attention.paused} mailboxes auto-paused for health` },
    ...attention.idle.map((c) => ({ href: `/clients/${c.client_id}/campaigns/${c.id}`, tone: "wait", text: `"${c.name}" is active but not sending: ${c.not_sending}` })),
    ...attention.broken.map((c) => ({ href: `/clients/${c.id}/settings`, tone: "bad", text: `${c.name}: ${c.key_message ?? "Instantly connection problem"}` })),
  ].filter(Boolean) as { href: string; tone: string; text: string }[];

  const toneClass: Record<string, string> = {
    wait: "border-wait/30 bg-wait-soft text-wait",
    go: "border-go/30 bg-go-soft text-go",
    bad: "border-bad/30 bg-bad-soft text-bad",
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted">All clients, last 30 days.</p>
        </div>
        <SyncButton lastSync={ago(getSetting("last_sync_all", "") || null)} />
      </header>

      {items.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {items.map((i, n) => (
            <Link key={n} href={i.href} className={`rounded-md border px-3 py-2 text-sm hover:opacity-90 ${toneClass[i.tone]}`}>
              {i.text} →
            </Link>
          ))}
        </div>
      )}

      <Funnel data={funnelFor(null, 30)} />

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Clients</h2>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 text-right font-medium">Active campaigns</th>
                <th className="px-3 py-2 text-right font-medium">To review</th>
                <th className="px-3 py-2 text-right font-medium">Sent today</th>
                <th className="px-3 py-2 text-right font-medium">Replies 7d</th>
                <th className="px-3 py-2 text-right font-medium">Interested 7d</th>
                <th className="px-3 py-2 text-right font-medium">Mailbox issues</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <Link href={`/clients/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                    {r.key_status !== "ok" && <span className="ml-2 text-xs text-bad">{r.key_status === "error" ? "connection problem" : "not connected"}</span>}
                  </td>
                  <td className="num px-3 py-2 text-right">{r.active}</td>
                  <td className={`num px-3 py-2 text-right ${r.review ? "font-semibold text-wait" : ""}`}>{r.review}</td>
                  <td className="num px-3 py-2 text-right">{r.sent_today}</td>
                  <td className="num px-3 py-2 text-right">{r.replies_7d}</td>
                  <td className={`num px-3 py-2 text-right ${r.interested_7d ? "font-semibold text-go" : ""}`}>{r.interested_7d}</td>
                  <td className={`num px-3 py-2 text-right ${r.mailboxes_bad ? "text-bad" : ""}`}>{r.mailboxes_bad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Sending now</h2>
          <Link href="/timeline" className="text-sm text-muted hover:text-ink">Full timeline →</Link>
        </div>
        <SendTimeline clientId={null} pastHours={12} futureHours={12} />
      </section>
    </div>
  );
}
