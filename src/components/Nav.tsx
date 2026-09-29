"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavClient = { id: number; name: string; keyStatus: string | null };

const MAIN = [
  { href: "/", label: "Overview" },
  { href: "/approvals", label: "Approvals" },
  { href: "/inbox", label: "Inbox" },
  { href: "/timeline", label: "Send timeline" },
  { href: "/mailboxes", label: "Mailboxes" },
  { href: "/activity", label: "Activity" },
];

export function Nav({ clients }: { clients: NavClient[] }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const item = (href: string, active: boolean) =>
    `flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm ${
      active ? "bg-ink text-paper" : "text-ink hover:bg-line/60"
    }`;

  return (
    <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col gap-6 border-r border-line bg-card px-3 py-5">
      <Link href="/" className="px-2.5">
        <div className="text-[15px] font-semibold tracking-tight">Outbound Console</div>
        <div className="text-xs text-muted">Instantly control room</div>
      </Link>

      <nav className="flex flex-col gap-0.5">
        {MAIN.map((m) => (
          <Link key={m.href} href={m.href} className={item(m.href, isActive(m.href))}>
            {m.label}
          </Link>
        ))}
      </nav>

      <div className="flex min-h-0 flex-col gap-0.5">
        <div className="flex items-center justify-between px-2.5 pb-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Clients</span>
          <Link href="/clients/new" className="text-xs text-muted hover:text-ink" title="Add client">
            + Add
          </Link>
        </div>
        <div className="flex flex-col gap-0.5 overflow-y-auto">
          {clients.length === 0 && <div className="px-2.5 text-xs text-muted">No clients yet</div>}
          {clients.map((c) => {
            const href = `/clients/${c.id}`;
            const active = path === href || path.startsWith(`${href}/`);
            return (
              <Link key={c.id} href={href} className={item(href, active)}>
                <span className="truncate">{c.name}</span>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    c.keyStatus === "ok" ? "bg-go" : c.keyStatus === "error" ? "bg-bad" : "bg-line"
                  }`}
                  title={c.keyStatus === "ok" ? "Instantly connected" : c.keyStatus === "error" ? "Key problem" : "Key not checked"}
                />
              </Link>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
