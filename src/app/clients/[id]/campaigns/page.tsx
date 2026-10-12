import { requireClientAccess } from "@/lib/auth";
import { getClient } from "@/lib/clients";
import Link from "next/link";
import { all } from "@/lib/db";
import { CampaignTable, type CampaignRow } from "@/components/CampaignTable";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Campaigns · ${client.name}` : "Campaigns" };
}

export default async function CampaignsPage({ params }: PageProps<"/clients/[id]/campaigns">) {
  const id = Number((await params).id);
  await requireClientAccess(id); // only admins and this client's own logins
  const campaigns = await all<CampaignRow>("SELECT * FROM campaigns WHERE client_id = ? ORDER BY status = 'active' DESC, created_at DESC", id);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between">
        <header>
          <h2 className="font-semibold">Campaigns</h2>
          <p className="text-sm text-muted">Each campaign has its own contacts, email and approvals.</p>
        </header>
        <Link href={`/clients/${id}/campaigns/new`} className="btn-go">New campaign</Link>
      </div>
      <CampaignTable clientId={id} campaigns={campaigns} />
    </div>
  );
}
