import { redirect } from "next/navigation";

/** Contacts are added and checked inside each campaign now (Campaign → Contacts). */
export default async function LeadsRedirect({ params }: PageProps<"/clients/[id]/leads">) {
  redirect(`/clients/${(await params).id}/campaigns`);
}
