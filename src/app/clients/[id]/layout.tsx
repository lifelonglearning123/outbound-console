import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import { getClient } from "@/lib/clients";
import { Tabs } from "@/components/Tabs";
import { ConnectionBadge } from "@/components/ConnectionBadge";

export default async function ClientLayout({ children, params }: LayoutProps<"/clients/[id]">) {
  const id = Number((await params).id);
  const user = await requireClientAccess(id); // only admins and this client's own logins
  const client = await getClient(id);
  if (!client) notFound();
  const base = `/clients/${id}`;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
          <p className="text-sm text-muted">
            {client.instantly_workspace_name ? `Instantly workspace: ${client.instantly_workspace_name}` : "Instantly not connected yet"}
          </p>
        </div>
        <ConnectionBadge client={client} />
      </header>
      <div className="print:hidden">
        <Tabs
          base={base}
          tabs={[
            { href: "", label: "Overview" },
            { href: "/campaigns", label: "Campaigns" },
            { href: `/inbox?client=${id}`, label: "Replies", absolute: true },
            { href: "/stats", label: "Stats" },
            // Settings hold the API keys, so only admins see them.
            ...(user.role === "admin" ? [{ href: "/settings", label: "Settings" }] : []),
          ]}
        />
      </div>
      <div>{children}</div>
    </div>
  );
}
