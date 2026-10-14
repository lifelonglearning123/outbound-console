import { requireClientAccess } from "@/lib/auth";
import { getClient, requireClient } from "@/lib/clients";
import Link from "next/link";
import { all } from "@/lib/db";
import { ACCOUNT_STATUS, WARMUP_STATUS } from "@/lib/instantly";
import { dateTime } from "@/lib/format";
import { CampaignTable, type CampaignRow } from "@/components/CampaignTable";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Campaigns · ${client.name}` : "Campaigns" };
}

/** The workspace landing: this client's campaigns, with mailbox health below. */
export default async function CampaignsPage({ params }: PageProps<"/clients/[id]/campaigns">) {
  const id = Number((await params).id);
  await requireClientAccess(id); // only admins and this client's own logins
  const client = await requireClient(id);

  if (!client.instantly_api_key) {
    return (
      <div className="card p-6 text-sm">
        Add this client&apos;s Instantly API key in <Link className="underline" href={`/clients/${id}/settings`}>Settings</Link> to get started.
      </div>
    );
  }

  const campaigns = await all<CampaignRow>("SELECT * FROM campaigns WHERE client_id = ? ORDER BY status = 'active' DESC, created_at DESC", id);
  const mailboxes = await all<{
    email: string; status: number | null; warmup_status: number | null; warmup_score: number | null;
    daily_limit: number | null; sent_today: number | null; auto_paused_at: string | null; auto_paused_reason: string | null;
  }>("SELECT * FROM mailboxes WHERE client_id = ? ORDER BY email", id);
  // One plain sentence per sending domain, so "5 paused to protect the old domain, 5 healthy" reads at a glance.
  const domains = [...new Set(mailboxes.map((m) => m.email.split("@")[1]))].map((domain) => {
    const boxes = mailboxes.filter((m) => m.email.endsWith(`@${domain}`));
    const active = boxes.filter((m) => m.status === 1).length;
    const autoPaused = boxes.filter((m) => m.status !== 1 && m.auto_paused_at).length;
    return { domain, total: boxes.length, active, autoPaused, otherOff: boxes.length - active - autoPaused };
  });

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-end justify-between">
          <header>
            <h2 className="font-semibold">Campaigns</h2>
            <p className="text-sm text-muted">Each campaign has its own contacts, email and approvals.</p>
          </header>
          <Link href={`/clients/${id}/campaigns/new`} className="btn-go">New campaign</Link>
        </div>
        <CampaignTable clientId={id} campaigns={campaigns} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Mailboxes <span className="num text-sm font-normal text-muted">{mailboxes.length}</span></h2>
        {domains.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {domains.map((d) => (
              <li key={d.domain}>
                <span className="font-medium">{d.domain}</span>:{" "}
                {d.active === d.total ? (
                  <span className="text-go">all {d.total} sending normally.</span>
                ) : d.active === 0 && d.autoPaused === d.total ? (
                  <span className="text-wait">all {d.total} paused automatically because too many emails bounced. This protects the domain; they stay out of sending until resumed.</span>
                ) : (
                  <span>
                    <span className="text-go">{d.active} sending</span>
                    {d.autoPaused > 0 && <span className="text-wait">, {d.autoPaused} paused automatically (too many bounces)</span>}
                    {d.otherOff > 0 && <span className="text-bad">, {d.otherOff} not connected</span>}.
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
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
                  <td className={`px-3 py-2 ${m.status === 1 ? "text-go" : m.auto_paused_at ? "text-wait" : "text-bad"}`}>
                    {m.status !== 1 && m.auto_paused_at ? "Paused automatically" : ACCOUNT_STATUS[m.status ?? 0] ?? m.status}
                    {m.status !== 1 && m.auto_paused_reason && (
                      <div className="text-xs text-muted">{dateTime(m.auto_paused_at)}: {m.auto_paused_reason}</div>
                    )}
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
