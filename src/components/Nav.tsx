"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavClient = { id: number; name: string; keyStatus: string | null };

// Cross-client views. Admins only: a client login works inside its own client.
const ALL_CLIENTS = [
  { href: "/", label: "Dashboard" },
  { href: "/approvals", label: "Approvals" },
  { href: "/inbox", label: "Inbox" },
  { href: "/timeline", label: "Send timeline" },
  { href: "/mailboxes", label: "Mailboxes" },
  { href: "/activity", label: "Activity" },
];

/** Everything a client's workspace holds. The sidebar shows these under the open client, so you never leave it by accident. */
const sections = (isAdmin: boolean) => [
  { href: "", label: "Overview" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/approvals", label: "Approvals" },
  { href: "/replies", label: "Replies" },
  { href: "/stats", label: "Stats" },
  // Settings hold the API keys, so only admins see them.
  ...(isAdmin ? [{ href: "/settings", label: "Settings" }] : []),
];

export function Nav({ clients, user }: { clients: NavClient[]; user: { email: string; isAdmin: boolean } }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const item = (active: boolean) =>
    `flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm ${
      active ? "bg-ink text-paper" : "text-ink hover:bg-line/60"
    }`;
  // The client whose workspace is open, from the URL.
  const openId = Number(/^\/clients\/(\d+)/.exec(path)?.[1] ?? 0);

  return (
    <aside className="sticky top-0 flex h-screen w-56 print:hidden shrink-0 flex-col gap-6 border-r border-line bg-card px-3 py-5">
      <Link href={user.isAdmin ? "/" : clients[0] ? `/clients/${clients[0].id}/campaigns` : "/account"} className="px-2.5">
        <div className="text-[15px] font-semibold tracking-tight">Outbound Console</div>
        <div className="text-xs text-muted">{user.isAdmin ? "Instantly control room" : "Cold email campaigns"}</div>
      </Link>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center justify-between px-2.5 pb-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">{clients.length === 1 && !user.isAdmin ? "Your account" : "Clients"}</span>
          {user.isAdmin && (
            <Link href="/clients/new" className="text-xs text-muted hover:text-ink" title="Add client">
              + Add
            </Link>
          )}
        </div>
        <div className="flex flex-col gap-0.5 overflow-y-auto">
          {clients.length === 0 && <div className="px-2.5 text-xs text-muted">No clients yet</div>}
          {clients.map((c) => {
            const base = `/clients/${c.id}`;
            const open = c.id === openId;
            return (
              <div key={c.id} className="flex flex-col gap-0.5">
                <Link key={c.id} href={user.isAdmin ? base : `${base}/campaigns`} className={item(open)}>
                  <span className="truncate font-medium">{c.name}</span>
                  {user.isAdmin && (
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        c.keyStatus === "ok" ? "bg-go" : c.keyStatus === "error" ? "bg-bad" : "bg-line"
                      }`}
                      title={c.keyStatus === "ok" ? "Instantly connected" : c.keyStatus === "error" ? "Key problem" : "Key not checked"}
                    />
                  )}
                </Link>
                {open && (
                  <div className="mb-1 ml-2.5 flex flex-col gap-0.5 border-l border-line pl-1.5">
                    {sections(user.isAdmin).map((s) => {
                      const href = `${base}${s.href}`;
                      const active = s.href === "" ? path === base : path.startsWith(href);
                      return (
                        <Link
                          key={s.href}
                          href={href}
                          className={`rounded-md px-2 py-1 text-[13px] ${active ? "bg-line/70 font-medium text-ink" : "text-muted hover:bg-line/40 hover:text-ink"}`}
                        >
                          {s.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {user.isAdmin && (
        <nav className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-1 text-xs font-medium uppercase tracking-wide text-muted">Across all clients</div>
          {ALL_CLIENTS.map((m) => (
            <Link key={m.href} href={m.href} className={item(isActive(m.href))}>
              {m.label}
            </Link>
          ))}
        </nav>
      )}

      <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-3">
        {user.isAdmin && (
          <Link href="/admin/users" className={item(path.startsWith("/admin/users"))}>Users</Link>
        )}
        <Link href="/account" className={item(path === "/account")}>
          <span className="truncate text-xs">{user.email}</span>
        </Link>
      </div>
    </aside>
  );
}
