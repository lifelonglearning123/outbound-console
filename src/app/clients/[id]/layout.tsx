import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import { getClient } from "@/lib/clients";
import { get } from "@/lib/db";
import { Tabs } from "@/components/Tabs";
import { ConnectionBadge } from "@/components/ConnectionBadge";

export default async function ClientLayout({ children, params }: LayoutProps<"/clients/[id]">) {
  const id = Number((await params).id);
  const user = await requireClientAccess(id); // only admins and this client's own logins
  const client = await getClient(id);
  if (!client) notFound();
  const pending =
    (await get<{ n: number }>(
      "SELECT COUNT(DISTINCT d.lead_id) AS n FROM drafts d JOIN leads l ON l.id = d.lead_id WHERE l.client_id = ? AND l.stage = 'review'",
      id,
    ))?.n ?? 0;
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
            { href: "/stats", label: "Stats" },
            { href: "/leads", label: "Leads" },
            { href: "/verification", label: "Verification" },
            { href: "/approvals", label: "Approvals", count: pending },
            { href: "/campaigns", label: "Campaigns" },
            // Settings hold the API keys, so only admins see them.
            ...(user.role === "admin" ? [{ href: "/settings", label: "Settings" }] : []),
          ]}
        />
      </div>
      <div>{children}</div>
    </div>
  );
}
