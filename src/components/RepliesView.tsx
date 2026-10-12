import Link from "next/link";
import { clientScope, type User } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { INTEREST_LABELS } from "@/lib/triage";
import { dateTime } from "@/lib/format";
import { tagReply, markRead } from "@/app/inbox/actions";
import { ReplyBox, GhlButton } from "@/components/InboxControls";
import { SubmitButton } from "@/components/SubmitButton";

/**
 * The reply browser: filter chips, the list, and the open thread. Rendered in two places with the same look:
 * inside a client's workspace (/clients/[id]/replies, fixed client) and on the admin Inbox (/inbox, all clients).
 */

type Msg = {
  id: string; client_id: number; client_name: string; campaign_name: string | null; lead_email: string; direction: string;
  subject: string | null; body_text: string | null; sent_at: string; is_unread: number; interest: string | null;
  interest_reason: string | null; ghl_pushed_at: string | null; ghl_message: string | null; thread_id: string | null;
  first_name: string | null; last_name: string | null; company: string | null; step: number | null; account_email: string;
};

const FILTERS = [
  { key: "attention", label: "Needs attention", where: "(e.interest IS NULL OR e.interest IN ('interested','not_now','other'))" },
  { key: "interested", label: "Interested", where: "e.interest = 'interested'" },
  { key: "not_now", label: "Not now", where: "e.interest = 'not_now'" },
  { key: "negative", label: "No / wrong person", where: "e.interest IN ('not_interested','wrong_person','unsubscribe')" },
  { key: "ooo", label: "Out of office", where: "e.interest = 'ooo'" },
  { key: "all", label: "All replies", where: "1 = 1" },
];

const TAG_STYLE: Record<string, string> = {
  interested: "bg-go-soft text-go",
  not_now: "bg-info-soft text-info",
  not_interested: "bg-paper text-muted",
  wrong_person: "bg-paper text-muted",
  unsubscribe: "bg-bad-soft text-bad",
  ooo: "bg-paper text-muted",
  other: "bg-wait-soft text-wait",
};

export async function RepliesView({
  user,
  clientId,
  basePath,
  sp,
  clientChips = null,
  showClientName = false,
}: {
  user: User;
  /** Fixed client (workspace page), or the admin Inbox's current filter (null = all clients). */
  clientId: number | null;
  /** Where the chips and list link back to: "/inbox" or "/clients/2/replies". */
  basePath: string;
  sp: { [key: string]: string | string[] | undefined };
  /** Admin Inbox only: clients to offer as filter chips. */
  clientChips?: { id: number; name: string }[] | null;
  /** Show which client each reply belongs to (admin Inbox, all clients). */
  showClientName?: boolean;
}) {
  const filter = FILTERS.find((f) => f.key === sp.f) ?? FILTERS[0];
  const selectedId = typeof sp.id === "string" ? sp.id : null;

  const base = `FROM emails e JOIN clients cl ON cl.id = e.client_id LEFT JOIN campaigns c ON c.id = e.campaign_id
                LEFT JOIN leads l ON l.id = e.lead_id
                WHERE e.direction = 'in' ${clientId ? "AND e.client_id = @clientId" : ""} ${clientScope(user, "e.client_id")}`;
  const p = { clientId: clientId ?? 0 };
  const list = await all<Msg>(
    `SELECT e.*, cl.name client_name, c.name campaign_name, l.first_name, l.last_name, l.company ${base} AND ${filter.where}
     ORDER BY e.sent_at DESC LIMIT 200`,
    p,
  );
  const counts = Object.fromEntries(
    await Promise.all(
      FILTERS.map(async (f) => [f.key, (await get<{ n: number }>(`SELECT COUNT(*) n ${base} AND ${f.where}`, p))?.n ?? 0] as const),
    ),
  );
  const selected = (selectedId && list.find((m) => m.id === selectedId)) || list[0] || null;
  const thread = selected
    ? await all<Msg>(
        `SELECT e.* FROM emails e WHERE e.client_id = ? AND (e.thread_id = ? OR e.lead_email = ?) ${clientScope(user, "e.client_id")} ORDER BY e.sent_at`,
        selected.client_id, selected.thread_id ?? "", selected.lead_email,
      )
    : [];
  const href = (patch: Record<string, string | number | null>) => {
    const q = new URLSearchParams();
    const next = { f: filter.key, ...(clientChips ? { client: clientId } : {}), ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, String(v));
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const chip = (active: boolean) => `rounded-md px-2.5 py-1 text-sm ${active ? "bg-ink text-paper" : "border border-line bg-card"}`;
  const name = (m: Msg) => [m.first_name, m.last_name].filter(Boolean).join(" ") || m.lead_email;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <Link key={f.key} href={href({ f: f.key, id: null })} className={chip(filter.key === f.key)}>
            {f.label} <span className="num">{counts[f.key]}</span>
          </Link>
        ))}
        {clientChips && (
          <>
            <span className="mx-2 h-5 w-px bg-line" />
            <Link href={href({ client: null, id: null })} className={chip(!clientId)}>All clients</Link>
            {clientChips.map((c) => <Link key={c.id} href={href({ client: c.id, id: null })} className={chip(clientId === c.id)}>{c.name}</Link>)}
          </>
        )}
      </div>

      {list.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">No replies here.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[340px_1fr]">
          <ul className="card max-h-80 overflow-y-auto md:max-h-[calc(100vh-230px)]">
            {list.map((m) => (
              <li key={m.id}>
                <Link
                  href={href({ id: m.id })}
                  className={`block border-b border-line px-3 py-2 ${m.id === selected?.id ? "bg-wait-soft" : "hover:bg-paper"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`truncate text-sm ${m.is_unread ? "font-semibold" : ""}`}>{name(m)}</span>
                    <span className="shrink-0 text-xs text-muted">{dateTime(m.sent_at)}</span>
                  </div>
                  <div className="truncate text-xs text-muted">{[showClientName ? m.client_name : null, m.company].filter(Boolean).join(" · ") || m.lead_email}</div>
                  <div className="mt-0.5 flex items-center gap-2">
                    {m.interest && <span className={`rounded px-1.5 text-[11px] ${TAG_STYLE[m.interest] ?? ""}`}>{INTEREST_LABELS[m.interest]}</span>}
                    {m.ghl_pushed_at && <span className="text-[11px] text-go">in Nexus Portal</span>}
                    <span className="truncate text-xs text-muted">{m.body_text?.slice(0, 80)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {selected && (
            <div className="flex flex-col gap-4">
              <div className="card flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-semibold">{name(selected)} <span className="font-mono text-xs font-normal text-muted">{selected.lead_email}</span></div>
                    <div className="text-xs text-muted">
                      {[showClientName ? selected.client_name : null, selected.campaign_name ?? "no campaign", `to ${selected.account_email}`].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  {selected.is_unread ? (
                    <form action={markRead.bind(null, selected.id)}><SubmitButton className="btn text-xs" pendingLabel="Marking…">Mark read</SubmitButton></form>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {Object.entries(INTEREST_LABELS).map(([k, label]) => (
                    <form key={k} action={tagReply.bind(null, selected.id, k)}>
                      <SubmitButton
                        className={`rounded-md border px-2 py-0.5 text-xs disabled:opacity-50 ${selected.interest === k ? `border-transparent ${TAG_STYLE[k]} font-medium` : "border-line hover:border-ink"}`}
                        pendingLabel="Saving…"
                      >
                        {label}
                      </SubmitButton>
                    </form>
                  ))}
                </div>
                {selected.interest_reason && <div className="text-xs text-muted">Why: {selected.interest_reason}</div>}
                <GhlButton emailId={selected.id} pushedAt={selected.ghl_pushed_at} message={selected.ghl_message} />
              </div>

              <div className="flex flex-col gap-2">
                {thread.map((m) => (
                  <div key={m.id} className={`card p-4 ${m.direction === "in" ? "border-wait/40" : ""} ${m.id === selected.id ? "ring-1 ring-wait" : ""}`}>
                    <div className="mb-2 flex justify-between text-xs text-muted">
                      <span>{m.direction === "in" ? `From ${m.lead_email}` : `Sent from ${m.account_email}${m.step ? ` · step ${m.step}` : ""}`}</span>
                      <span>{dateTime(m.sent_at)}</span>
                    </div>
                    {m.subject && <div className="mb-1 text-sm font-medium">{m.subject}</div>}
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">{m.body_text}</div>
                  </div>
                ))}
              </div>
              <ReplyBox emailId={selected.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
