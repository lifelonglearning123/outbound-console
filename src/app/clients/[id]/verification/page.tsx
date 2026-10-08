import { redirect } from "next/navigation";

/** Address-check results live inside each campaign now (Campaign → Contacts). */
export default async function VerificationRedirect({ params }: PageProps<"/clients/[id]/verification">) {
  redirect(`/clients/${(await params).id}/campaigns`);
}
