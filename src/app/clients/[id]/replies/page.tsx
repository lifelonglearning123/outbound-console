import { requireClientAccess } from "@/lib/auth";
import { getClient } from "@/lib/clients";
import { RepliesView } from "@/components/RepliesView";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Replies · ${client.name}` : "Replies" };
}

/** This client's replies, inside their workspace. The admin Inbox shows the same thing across all clients. */
export default async function ClientRepliesPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const id = Number((await params).id);
  const user = await requireClientAccess(id); // only admins and this client's own logins
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="font-semibold">Replies</h2>
        <p className="text-sm text-muted">Tagged by AI as they arrive. Interested replies go to the Nexus Portal automatically.</p>
      </header>
      <RepliesView user={user} clientId={id} basePath={`/clients/${id}/replies`} sp={await searchParams} />
    </div>
  );
}
