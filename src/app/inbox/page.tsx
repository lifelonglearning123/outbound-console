import Link from "next/link";
import { canSeeClient, requireUser } from "@/lib/auth";
import { listClients } from "@/lib/clients";
import { RepliesView } from "@/components/RepliesView";

export const metadata = { title: "Inbox" };

/** Admin view: replies from every client in one place. Each client also has its own Replies page in its workspace. */
export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const u = await requireUser();
  const sp = await searchParams;
  const asked = Number(sp.client) || null;
  const clientId = asked && canSeeClient(u, asked) ? asked : null;
  const clients = (await listClients()).filter((c) => canSeeClient(u, c.id));
  const scoped = clientId ? clients.find((c) => c.id === clientId) : null;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted">
          {scoped ? `Replies for ${scoped.name}, tagged by AI.` : "Replies from every client, tagged by AI."} Interested replies go to the client&apos;s Nexus Portal automatically.
        </p>
      </header>
      {scoped && (
        <Link
          href={`/clients/${scoped.id}/replies`}
          className="rounded-md border border-info/30 bg-info-soft px-3 py-2 text-sm text-info hover:opacity-90"
        >
          You&apos;re only seeing {scoped.name}. Open {scoped.name}&apos;s own Replies page →
        </Link>
      )}
      <RepliesView user={u} clientId={clientId} basePath="/inbox" sp={sp} clientChips={clients.map((c) => ({ id: c.id, name: c.name }))} showClientName={!clientId} />
    </div>
  );
}
