import { requireAdmin } from "@/lib/auth";
import { notFound } from "next/navigation";
import { getClient } from "@/lib/clients";
import { ClientForm } from "@/components/ClientForm";

export default async function ClientSettingsPage({ params }: PageProps<"/clients/[id]/settings">) {
  await requireAdmin(); // settings hold the API keys
  const client = await getClient(Number((await params).id));
  if (!client) notFound();
  return <ClientForm client={client} />;
}
