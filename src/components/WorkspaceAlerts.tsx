import Link from "next/link";
import { all, getSetting } from "@/lib/db";
import type { Client } from "@/lib/clients";

/**
 * Problems that need a person, shown at the top of the client's workspace instead of only in the Activity log:
 * a broken connection, address checks that stopped, campaigns with no mailbox left to send from, and errors that
 * keep repeating. Settings-level problems (keys) are only shown to admins, who can fix them.
 */
export async function WorkspaceAlerts({ client, isAdmin }: { client: Client; isAdmin: boolean }) {
  const alerts: { tone: "bad" | "wait"; text: string; href?: string; link?: string }[] = [];
  const base = `/clients/${client.id}`;

  if (isAdmin && client.key_status === "error") {
    alerts.push({ tone: "bad", text: `Instantly connection problem: ${client.key_message ?? "the API key was refused"}.`, href: `${base}/settings`, link: "Fix in Settings" });
  }

  const verifyError = await getSetting(`verify_error_${client.id}`, "");
  if (verifyError) alerts.push({ tone: "wait", text: verifyError });

  // Active campaigns whose every chosen mailbox is paused or disconnected: nothing can go out.
  const campaigns = await all<{ id: number; name: string; accounts: string }>(
    "SELECT id, name, accounts FROM campaigns WHERE client_id = ? AND managed = 1 AND status = 'active'",
    client.id,
  );
  const activeBoxes = new Set(
    (await all<{ email: string }>("SELECT email FROM mailboxes WHERE client_id = ? AND status = 1", client.id)).map((m) => m.email),
  );
  for (const c of campaigns) {
    let accounts: string[] = [];
    try {
      accounts = JSON.parse(c.accounts || "[]");
    } catch {}
    if (accounts.length > 0 && !accounts.some((a) => activeBoxes.has(a))) {
      alerts.push({
        tone: "bad",
        text: `"${c.name}" has no working mailbox to send from: every mailbox it uses is paused or disconnected.`,
        href: `${base}/campaigns/${c.id}/email`,
        link: "Choose mailboxes",
      });
    }
  }

  // Errors that keep happening. The same failure differs only by address or number, so those are blanked to group.
  if (isAdmin) {
    const errors = await all<{ message: string; at: string }>(
      "SELECT message, at FROM activity WHERE client_id = ? AND kind = 'error' AND at >= to_char(now() - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS') ORDER BY id DESC LIMIT 200",
      client.id,
    );
    const groups = new Map<string, { message: string; n: number }>();
    for (const e of errors) {
      const key = e.message.replace(/[\w.+-]+@[\w.-]+/g, "@").replace(/\d+/g, "#").slice(0, 80);
      const g = groups.get(key);
      if (g) g.n++;
      else groups.set(key, { message: e.message, n: 1 });
    }
    for (const g of [...groups.values()].filter((g) => g.n >= 3).slice(0, 3)) {
      const text = g.message.length > 180 ? `${g.message.slice(0, 180)}…` : g.message;
      alerts.push({ tone: "bad", text: `Happened ${g.n} times in the last day: ${text}`, href: "/activity", link: "See activity" });
    }
  }

  if (alerts.length === 0) return null;
  const tone = { bad: "border-bad/30 bg-bad-soft text-bad", wait: "border-wait/30 bg-wait-soft text-wait" };
  return (
    <div className="flex flex-col gap-1.5 print:hidden" role="status">
      {alerts.map((a, i) => (
        <div key={i} className={`flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-3 py-2 text-sm ${tone[a.tone]}`}>
          <span className="min-w-0 break-words">{a.text}</span>
          {a.href && <Link href={a.href} className="shrink-0 font-medium underline">{a.link}</Link>}
        </div>
      ))}
    </div>
  );
}
