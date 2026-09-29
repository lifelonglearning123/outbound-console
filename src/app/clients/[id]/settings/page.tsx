import { notFound } from "next/navigation";
import { getClient } from "@/lib/clients";
import { ClientForm } from "@/components/ClientForm";

export default async function ClientSettingsPage({ params }: PageProps<"/clients/[id]/settings">) {
  const client = getClient(Number((await params).id));
  if (!client) notFound();
  return <ClientForm client={client} />;
}
