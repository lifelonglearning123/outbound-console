import { requireClientAccess } from "@/lib/auth";
import { getClient, requireClient } from "@/lib/clients";
import Link from "next/link";
import { all } from "@/lib/db";
import { mailboxHealth } from "@/lib/mailboxHealth";
import { clientAttention } from "@/lib/attention";
import { CampaignTable, type CampaignRow } from "@/components/CampaignTable";
import { TodayBox } from "@/components/TodayBox";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Campaigns · ${client.name}` : "Campaigns" };
}

/** The workspace landing: what to do today, this client's campaigns, and a line per sending domain. */
export default async function CampaignsPage({ params }: PageProps<"/clients/[id]/campaigns">) {
  const id = Number((await params).id);
  const user = await requireClientAccess(id); // only admins and this client's own logins
  const client = await requireClient(id);

  if (!client.instantly_api_key) {
    return (
      <div className="card p-6 text-sm">
        Add this client&apos;s Instantly API key in <Link className="underline" href={`/clients/${id}/settings`}>Settings</Link> to get started.
      </div>
    );
  }

  const campaigns = await all<CampaignRow>("SELECT * FROM campaigns WHERE client_id = ? ORDER BY status = 'active' DESC, created_at DESC", id);
  const mailboxes = await mailboxHealth(id);
  const attention = await clientAttention(client, user.role === "admin", mailboxes);
  // One plain sentence per sending domain, so "5 sending, 5 resting while warmup rebuilds" reads at a glance.
  const domains = [...new Set(mailboxes.map((m) => m.domain))].map((domain) => {
    const boxes = mailboxes.filter((m) => m.domain === domain);
    const count = (k: string) => boxes.filter((m) => m.state.key === k).length;
    return {
      domain,
      total: boxes.length,
      parts: [
        count("sending") && { text: `${count("sending")} sending`, tone: "text-go" },
        count("easing") && { text: `${count("easing")} easing in`, tone: "text-info" },
        count("resting") && { text: `${count("resting")} resting while they recover`, tone: "text-wait" },
        count("paused") && { text: `${count("paused")} paused${boxes.some((m) => m.stuck) ? ", with warmup stopped" : ""}`, tone: "text-bad" },
        count("error") && { text: `${count("error")} not connected`, tone: "text-bad" },
        count("maintenance") && { text: `${count("maintenance")} in maintenance`, tone: "text-wait" },
      ].filter(Boolean) as { text: string; tone: string }[],
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <TodayBox clientId={id} items={attention} />

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
        <div className="flex items-end justify-between gap-3">
          <h2 className="font-semibold">Mailboxes <span className="num text-sm font-normal text-muted">{mailboxes.length}</span></h2>
          <Link href={`/clients/${id}/mailboxes`} className="text-sm underline">Health, warmup and bounces →</Link>
        </div>
        {domains.length === 0 ? (
          <p className="text-sm text-muted">No mailboxes found in this workspace.</p>
        ) : (
          <ul className="card flex flex-col gap-1 p-4 text-sm">
            {domains.map((d) => (
              <li key={d.domain}>
                <span className="font-medium">{d.domain}</span>:{" "}
                {d.parts.map((p, i) => (
                  <span key={p.text} className={p.tone}>{i > 0 && ", "}{p.text}</span>
                ))}
                .
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
