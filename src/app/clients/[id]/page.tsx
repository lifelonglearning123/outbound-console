import { requireClientAccess } from "@/lib/auth";
import Link from "next/link";
import { all } from "@/lib/db";
import { requireClient } from "@/lib/clients";
import { ACCOUNT_STATUS, WARMUP_STATUS } from "@/lib/instantly";
import { Funnel } from "@/components/Funnel";
import { CampaignTable, type CampaignRow } from "@/components/CampaignTable";
import { funnelFor } from "@/lib/stats";

export default async function ClientOverview({ params }: PageProps<"/clients/[id]">) {
  const id = Number((await params).id);
  await requireClientAccess(id); // only admins and this client's own logins
  const client = await requireClient(id);
  const campaigns = await all<CampaignRow>("SELECT * FROM campaigns WHERE client_id = ? ORDER BY status = 'active' DESC, created_at DESC", id);
  const mailboxes = await all<{
    email: string; status: number | null; warmup_status: number | null; warmup_score: number | null;
    daily_limit: number | null; sent_today: number | null; auto_paused_at: string | null;
  }>("SELECT * FROM mailboxes WHERE client_id = ? ORDER BY email", id);

  if (!client.instantly_api_key) {
    return (
      <div className="card p-6 text-sm">
        Add this client&apos;s Instantly API key in <Link className="underline" href={`/clients/${id}/settings`}>Settings</Link> to get started.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Last 30 days</h2>
        <Funnel data={await funnelFor(id, 30)} />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Campaigns</h2>
          <Link href={`/clients/${id}/campaigns/new`} className="btn">New campaign</Link>
        </div>
        <CampaignTable clientId={id} campaigns={campaigns} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Mailboxes <span className="num text-sm font-normal text-muted">{mailboxes.length}</span></h2>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Mailbox</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Warmup</th>
                <th className="px-3 py-2 text-right font-medium">Health</th>
                <th className="px-3 py-2 text-right font-medium">Daily limit</th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-4 text-muted">No mailboxes found in this workspace.</td></tr>
              )}
              {mailboxes.map((m) => (
                <tr key={m.email} className="border-t border-line">
                  <td className="px-3 py-2 font-mono text-xs">{m.email}</td>
                  <td className={`px-3 py-2 ${m.status === 1 ? "text-go" : "text-bad"}`}>
                    {ACCOUNT_STATUS[m.status ?? 0] ?? m.status}
                    {m.auto_paused_at && <span className="ml-1 text-xs text-bad">(auto-paused)</span>}
                  </td>
                  <td className="px-3 py-2">{WARMUP_STATUS[m.warmup_status ?? 0] ?? "–"}</td>
                  <td className="num px-3 py-2 text-right">{m.warmup_score ?? "–"}</td>
                  <td className="num px-3 py-2 text-right">{m.daily_limit ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
