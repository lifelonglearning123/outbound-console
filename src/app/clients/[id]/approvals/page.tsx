import { requireClientAccess } from "@/lib/auth";
import { reviewQueue, approvalCounts } from "@/lib/approvals";
import { ApprovalQueue } from "@/components/ApprovalQueue";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function ClientApprovalsPage({ params }: PageProps<"/clients/[id]/approvals">) {
  const id = Number((await params).id);
  await requireClientAccess(id); // only admins and this client's own logins
  const leads = await reviewQueue(id);
  const counts = await approvalCounts(id);
  return (
    <>
      <AutoRefresh active={counts.drafting > 0 && leads.length === 0} />
      <ApprovalQueue leads={leads} clientId={id} approvedCount={counts.approved} draftingCount={counts.drafting} showClient={false} />
    </>
  );
}
