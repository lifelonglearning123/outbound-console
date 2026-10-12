import { requireAdmin } from "@/lib/auth";
import { notFound } from "next/navigation";
import { getClient } from "@/lib/clients";
import { ClientForm } from "@/components/ClientForm";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Settings · ${client.name}` : "Settings" };
}

export default async function ClientSettingsPage({ params }: PageProps<"/clients/[id]/settings">) {
  await requireAdmin(); // settings hold the API keys
  const client = await getClient(Number((await params).id));
  if (!client) notFound();
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="font-semibold">Settings</h2>
        <p className="text-sm text-muted">Connections and defaults for this client.</p>
      </header>
      <ClientForm client={client} />
    </div>
  );
}
