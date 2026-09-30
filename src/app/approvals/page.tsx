import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { reviewQueue, approvalCounts } from "@/lib/approvals";
import { ApprovalQueue } from "@/components/ApprovalQueue";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function ApprovalsPage() {
  const u = await requireUser();
  if (u.role !== "admin") redirect(u.clientIds.length ? `/clients/${u.clientIds[0]}/approvals` : "/account");
  const leads = await reviewQueue(null);
  const counts = await approvalCounts(null);
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted">Every email the AI writes waits here. Only approved leads are sent to Instantly.</p>
      </header>
      <AutoRefresh active={counts.drafting > 0 && leads.length === 0} />
      <ApprovalQueue leads={leads} clientId={null} approvedCount={counts.approved} draftingCount={counts.drafting} showClient />
    </div>
  );
}
