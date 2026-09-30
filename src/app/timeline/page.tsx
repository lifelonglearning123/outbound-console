import { canSeeClient, requireUser } from "@/lib/auth";
import Link from "next/link";
import { listClients } from "@/lib/clients";
import { SendTimeline } from "@/components/SendTimeline";
import { AutoRefresh } from "@/components/AutoRefresh";

const RANGES = [
  { key: "day", label: "Today ± 12h", past: 12, future: 12 },
  { key: "2d", label: "Last 24h + next 24h", past: 24, future: 24 },
  { key: "week", label: "Last 7 days", past: 168, future: 24 },
];

export default async function TimelinePage({ searchParams }: PageProps<"/timeline">) {
  const u = await requireUser();
  const sp = await searchParams;
  const asked = Number(sp.client) || null;
  // Client logins always see one of their own clients; admins can also see all at once.
  const clientId = asked && canSeeClient(u, asked) ? asked : u.role === "admin" ? null : (u.clientIds[0] ?? -1);
  const range = RANGES.find((r) => r.key === sp.range) ?? RANGES[1];
  const clients = (await listClients()).filter((c) => canSeeClient(u, c.id));
  const href = (patch: Record<string, string | number | null>) => {
    const q = new URLSearchParams();
    const next = { client: clientId, range: range.key, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, String(v));
    return `/timeline?${q}`;
  };
  const chip = (active: boolean) => `rounded-md px-2.5 py-1 text-sm ${active ? "bg-ink text-paper" : "border border-line bg-card"}`;

  return (
    <div className="flex flex-col gap-5">
      <AutoRefresh active everyMs={60_000} />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Send timeline</h1>
        <p className="text-sm text-muted">Every email per mailbox. Hover a dot for the lead and subject. Refreshes every minute.</p>
      </header>
      <div className="flex flex-wrap items-center gap-1.5">
        {u.role === "admin" && <Link href={href({ client: null })} className={chip(!clientId)}>All clients</Link>}
        {clients.map((c) => <Link key={c.id} href={href({ client: c.id })} className={chip(clientId === c.id)}>{c.name}</Link>)}
        <span className="mx-2 h-5 w-px bg-line" />
        {RANGES.map((r) => <Link key={r.key} href={href({ range: r.key })} className={chip(range.key === r.key)}>{r.label}</Link>)}
      </div>
      <SendTimeline clientId={clientId} pastHours={range.past} futureHours={range.future} />
    </div>
  );
}
