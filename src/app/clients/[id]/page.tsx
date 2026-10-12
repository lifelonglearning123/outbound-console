import { redirect } from "next/navigation";

/** The workspace landing is Campaigns; the old Overview merged into it so there's one home, not two. */
export default async function ClientHome({ params }: PageProps<"/clients/[id]">) {
  redirect(`/clients/${(await params).id}/campaigns`);
}
