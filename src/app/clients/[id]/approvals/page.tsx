import { reviewQueue, approvalCounts } from "@/lib/approvals";
import { ApprovalQueue } from "@/components/ApprovalQueue";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function ClientApprovalsPage({ params }: PageProps<"/clients/[id]/approvals">) {
  const id = Number((await params).id);
  const leads = reviewQueue(id);
  const counts = approvalCounts(id);
  return (
    <>
      <AutoRefresh active={counts.drafting > 0 && leads.length === 0} />
      <ApprovalQueue leads={leads} clientId={id} approvedCount={counts.approved} draftingCount={counts.drafting} showClient={false} />
    </>
  );
}
