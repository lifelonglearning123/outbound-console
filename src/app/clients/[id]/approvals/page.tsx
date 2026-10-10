import { redirect } from "next/navigation";

/** Approval happens on each campaign's Approve tab now. */
export default async function ClientApprovalsRedirect({ params }: PageProps<"/clients/[id]/approvals">) {
  redirect(`/clients/${(await params).id}/campaigns`);
}
