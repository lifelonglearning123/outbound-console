import { all } from "@/lib/db";
import { nowMs, toDate } from "@/lib/format";

type Event = { account: string; client: string; at: string; kind: "out" | "in" | "scheduled"; who: string | null; subject: string | null; step: number | null };

/**
 * One row per sending mailbox, time running left to right. Filled green = sent, amber = reply received,
 * hollow = queued in Instantly. The dark line is now.
 */
export function SendTimeline({ clientId, pastHours, futureHours }: { clientId: number | null; pastHours: number; futureHours: number }) {
  const now = nowMs();
  const start = now - pastHours * 3600_000;
  const end = now + futureHours * 3600_000;
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const scope = clientId ? "AND e.client_id = @clientId" : "";
  const p = { clientId: clientId ?? 0, startIso, endIso };

  const events = [
    ...all<Event>(
      `SELECT e.account_email account, c.name client, e.sent_at at, e.direction kind, e.lead_email who, e.subject, e.step
       FROM emails e JOIN clients c ON c.id = e.client_id
       WHERE e.sent_at >= @startIso AND e.sent_at <= @endIso ${scope}`,
      p,
    ),
    ...all<Event>(
      `SELECT e.account_email account, c.name client, e.due_at at, 'scheduled' kind, e.lead_email who, e.subject, e.step
       FROM scheduled e JOIN clients c ON c.id = e.client_id
       WHERE e.due_at >= @startIso AND e.due_at <= @endIso ${scope}`,
      p,
    ),
  ].filter((e) => e.account);

  const rows = new Map<string, { client: string; events: Event[] }>();
  for (const e of events) {
    const r = rows.get(e.account) ?? { client: e.client, events: [] };
    r.events.push(e);
    rows.set(e.account, r);
  }
  const sorted = [...rows.entries()].sort((a, b) => a[1].client.localeCompare(b[1].client) || a[0].localeCompare(b[0]));
  const x = (iso: string) => ((toDate(iso).getTime() - start) / (end - start)) * 100;

  // Hour (or day) gridlines
  const tickEvery = pastHours + futureHours > 72 ? 24 : pastHours + futureHours > 24 ? 6 : 3;
  const ticks: { left: number; label: string }[] = [];
  const first = new Date(start);
  first.setMinutes(0, 0, 0);
  for (let t = first.getTime() + 3600_000; t < end; t += 3600_000) {
    const d = new Date(t);
    if (d.getHours() % tickEvery !== 0) continue;
    ticks.push({
      left: ((t - start) / (end - start)) * 100,
      label: tickEvery === 24 || d.getHours() === 0
        ? d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })
        : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    });
  }
  const nowLeft = ((now - start) / (end - start)) * 100;
  const counts = { out: events.filter((e) => e.kind === "out").length, in: events.filter((e) => e.kind === "in").length, scheduled: events.filter((e) => e.kind === "scheduled").length };

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-4 border-b border-line px-4 py-2 text-xs text-muted">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-go align-middle" />sent <span className="num text-ink">{counts.out}</span></span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-wait align-middle" />replies <span className="num text-ink">{counts.in}</span></span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full border border-go align-middle" />queued <span className="num text-ink">{counts.scheduled}</span></span>
      </div>
      {sorted.length === 0 ? (
        <div className="p-6 text-sm text-muted">Nothing sent or queued in this window.</div>
      ) : (
        <div className="grid grid-cols-[240px_1fr]">
          <div />
          <div className="relative h-6 border-b border-line">
            {ticks.map((t) => (
              <span key={t.left} className="num absolute top-1 -translate-x-1/2 text-[10px] text-muted" style={{ left: `${t.left}%` }}>{t.label}</span>
            ))}
          </div>
          {sorted.map(([account, r]) => (
            <div key={account} className="contents">
              <div className="truncate border-b border-line px-4 py-2 text-xs" title={account}>
                <div className="font-mono">{account}</div>
                {!clientId && <div className="text-muted">{r.client}</div>}
              </div>
              <div className="relative border-b border-line">
                {ticks.map((t) => <span key={t.left} className="absolute inset-y-0 w-px bg-line/70" style={{ left: `${t.left}%` }} />)}
                <span className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `${nowLeft}%` }} />
                {r.events.map((e, i) => (
                  <span
                    key={i}
                    title={`${e.kind === "out" ? "Sent" : e.kind === "in" ? "Reply from" : "Queued for"} ${e.who ?? ""}${e.step ? ` · step ${e.step}` : ""}\n${e.subject ?? ""}\n${toDate(e.at).toLocaleString("en-GB")}`}
                    className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                      e.kind === "out" ? "bg-go/80" : e.kind === "in" ? "z-10 bg-wait ring-2 ring-card" : "border-[1.5px] border-go bg-card"
                    }`}
                    style={{ left: `${x(e.at)}%` }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
