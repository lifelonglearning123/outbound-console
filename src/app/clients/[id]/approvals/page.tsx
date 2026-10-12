import { requireClientAccess } from "@/lib/auth";
import { getClient } from "@/lib/clients";
import { reviewQueue, approvalCounts } from "@/lib/approvals";
import { ApprovalQueue } from "@/components/ApprovalQueue";
import { AutoRefresh } from "@/components/AutoRefresh";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Approvals · ${client.name}` : "Approvals" };
}

/** Every email waiting for a decision in this client, across its campaigns. */
export default async function ClientApprovalsPage({ params }: PageProps<"/clients/[id]/approvals">) {
  const id = Number((await params).id);
  await requireClientAccess(id); // only admins and this client's own logins
  const leads = await reviewQueue(id);
  const counts = await approvalCounts(id);
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="font-semibold">Approvals</h2>
        <p className="text-sm text-muted">Every email waits here for a decision. Only approved contacts are handed to the sender.</p>
      </header>
      <AutoRefresh active={counts.drafting > 0 && leads.length === 0} />
      <ApprovalQueue leads={leads} clientId={id} approvedCount={counts.approved} draftingCount={counts.drafting} showClient={false} />
    </div>
  );
}
