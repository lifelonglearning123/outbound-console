import type { Headline, StepRow } from "@/lib/report";
import { pct } from "@/lib/format";

const BLUE = "#2a78d6";

const rate = (n: number, d: number) => (d ? n / d : 0);

type Tile = {
  label: string;
  value: number;
  prev: number;
  sub?: string;
  isRate?: boolean;
  goodWhenUp?: boolean; // false for bounces and unsubscribes
  note?: string;
};

function Delta({ now, prev, isRate, goodWhenUp = true }: { now: number; prev: number; isRate?: boolean; goodWhenUp?: boolean }) {
  if (!prev && !now) return <span className="text-muted">–</span>;
  if (!prev) return <span className="text-muted">new</span>;
  const diff = now - prev;
  if (Math.abs(diff) < (isRate ? 0.0005 : 0.5)) return <span className="text-muted">no change</span>;
  const up = diff > 0;
  const good = up === goodWhenUp;
  const text = isRate ? `${(Math.abs(diff) * 100).toFixed(1)} pts` : `${Math.round((Math.abs(diff) / prev) * 100)}%`;
  return (
    <span className={good ? "text-go" : "text-bad"}>
      {up ? "▲" : "▼"} {text}
    </span>
  );
}

export function HeadlineTiles({ now, before, compact = false }: { now: Headline; before: Headline; compact?: boolean }) {
  const tiles: Tile[] = [
    { label: "Leads contacted", value: now.contacted, prev: before.contacted },
    { label: "Emails sent", value: now.sent, prev: before.sent, sub: "all steps" },
    { label: "Reply rate", value: rate(now.replied, now.contacted), prev: rate(before.replied, before.contacted), isRate: true, sub: `${now.replied} replies` },
    {
      label: "Positive reply rate",
      value: rate(now.positive, now.contacted),
      prev: rate(before.positive, before.contacted),
      isRate: true,
      sub: `${now.positive} interested`,
    },
    { label: "Meetings booked", value: now.meetings, prev: before.meetings },
    {
      label: "Bounce rate",
      value: rate(now.bounced, now.bounceBase),
      prev: rate(before.bounced, before.bounceBase),
      isRate: true,
      goodWhenUp: false,
      sub: `${now.bounced} bounced`,
      note: now.bounceBase && now.bounced / now.bounceBase > 0.03 ? "Above 3%: check mailboxes" : undefined,
    },
  ];
  if (!compact) {
    tiles.push({ label: "Unsubscribes", value: now.unsubscribed, prev: before.unsubscribed, goodWhenUp: false });
  }
  return (
    <div className={`grid gap-3 ${compact ? "grid-cols-3" : "grid-cols-7"}`}>
      {tiles.map((t) => (
        <div key={t.label} className="card flex flex-col gap-0.5 p-3">
          <div className="text-xs text-muted">{t.label}</div>
          <div className="num text-2xl font-semibold text-ink">{t.isRate ? `${(t.value * 100).toFixed(1)}%` : t.value.toLocaleString("en-GB")}</div>
          <div className="text-xs">
            <Delta now={t.value} prev={t.prev} isRate={t.isRate} goodWhenUp={t.goodWhenUp} /> <span className="text-muted">vs previous period</span>
          </div>
          {t.sub && <div className="text-xs text-muted">{t.sub}</div>}
          {t.note && <div className="text-xs text-bad">⚠ {t.note}</div>}
        </div>
      ))}
    </div>
  );
}

/** The client-facing headline: outcomes only, no deliverability internals. */
export function ClientTiles({ now, before }: { now: Headline; before: Headline }) {
  const tiles: Tile[] = [
    { label: "People contacted", value: now.contacted, prev: before.contacted },
    { label: "Emails sent", value: now.sent, prev: before.sent },
    { label: "Replies", value: now.replied, prev: before.replied, sub: `${pct(now.replied, now.contacted)} of people contacted` },
    { label: "Interested", value: now.positive, prev: before.positive, sub: `${pct(now.positive, now.contacted)} of people contacted` },
    { label: "Meetings booked", value: now.meetings, prev: before.meetings },
  ];
  return (
    <div className="grid grid-cols-5 gap-3">
      {tiles.map((t) => (
        <div key={t.label} className="card flex flex-col gap-0.5 p-3">
          <div className="text-xs text-muted">{t.label}</div>
          <div className="num text-2xl font-semibold text-ink">{t.value.toLocaleString("en-GB")}</div>
          {t.sub && <div className="text-xs text-muted">{t.sub}</div>}
          <div className="text-xs">
            <Delta now={t.value} prev={t.prev} /> <span className="text-muted">vs previous period</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Contacted → replied → interested → meeting, as bars scaled to "contacted". */
export function FunnelBars({ h }: { h: Headline }) {
  const stages = [
    { label: "Leads contacted", n: h.contacted },
    { label: "Replied", n: h.replied },
    { label: "Interested", n: h.positive },
    { label: "Meeting booked", n: h.meetings },
  ];
  const max = Math.max(1, h.contacted);
  return (
    <div className="flex flex-col gap-2">
      {stages.map((s, i) => (
        <div key={s.label} className="grid grid-cols-[130px_1fr_110px] items-center gap-3 text-sm">
          <span className="text-muted">{s.label}</span>
          <div className="h-5 rounded bg-paper">
            <div
              className="h-5 rounded"
              style={{ width: `${Math.max(s.n ? 1.5 : 0, (s.n / max) * 100)}%`, background: BLUE }}
              title={`${s.label}: ${s.n}`}
            />
          </div>
          <span className="num text-right text-ink">
            {s.n.toLocaleString("en-GB")}
            {i > 0 && <span className="ml-1 text-xs text-muted">{pct(s.n, h.contacted)}</span>}
          </span>
        </div>
      ))}
      <p className="text-xs text-muted">Percentages are of leads contacted.</p>
    </div>
  );
}

/** Labelled horizontal bars for one measure (reply types, step reply rates). */
export function HBars({ rows, format }: { rows: { label: string; value: number; detail?: string }[]; format?: (v: number) => string }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[130px_1fr_150px] items-center gap-3 text-sm" title={`${r.label}: ${format ? format(r.value) : r.value}${r.detail ? ` (${r.detail})` : ""}`}>
          <span className="truncate text-muted">{r.label}</span>
          <div className="h-3.5 rounded bg-paper">
            <div className="h-3.5 rounded" style={{ width: `${r.value ? Math.max(1.5, (r.value / max) * 100) : 0}%`, background: BLUE }} />
          </div>
          <span className="num text-right text-ink">
            {format ? format(r.value) : r.value}
            {r.detail && <span className="ml-1 text-xs text-muted">{r.detail}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function StepPerformance({ steps }: { steps: StepRow[] }) {
  if (steps.length === 0) return <p className="text-sm text-muted">No step data yet; it appears after the first sync once emails have gone out.</p>;
  const byCampaign = new Map<string, StepRow[]>();
  for (const s of steps) byCampaign.set(s.campaign, [...(byCampaign.get(s.campaign) ?? []), s]);
  return (
    <div className="flex flex-col gap-4">
      {[...byCampaign.entries()].map(([name, rows]) => (
        <div key={name} className="flex flex-col gap-1.5">
          {byCampaign.size > 1 && <div className="text-xs font-medium text-ink">{name}</div>}
          <HBars
            rows={rows.map((r) => ({ label: `Step ${r.step}`, value: rate(r.replied, r.sent), detail: `${r.replied} of ${r.sent} sent` }))}
            format={(v) => `${(v * 100).toFixed(1)}%`}
          />
        </div>
      ))}
      <p className="text-xs text-muted">Reply rate for each email in the sequence, since the campaign started (Instantly doesn&apos;t split this by day).</p>
    </div>
  );
}

// Sequential single-hue ramp (light → dark) from the reference palette's blue.
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Replies by UK weekday × hour. Empty cells stay the surface colour so "none" reads as none. */
export function ReplyHeatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(0, ...grid.flat());
  if (max === 0) return <p className="text-sm text-muted">No replies in this period yet.</p>;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const color = (n: number) => (n === 0 ? "var(--paper)" : RAMP[Math.min(RAMP.length - 1, Math.floor((n / max) * (RAMP.length - 1)))]);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-[2px] text-[10px]" style={{ gridTemplateColumns: `36px repeat(24, minmax(0, 1fr))` }}>
        <span />
        {hours.map((h) => (
          <span key={h} className="text-center text-muted">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>
        ))}
        {grid.map((row, d) => (
          <div key={d} className="contents">
            <span className="self-center text-muted">{DAYS[d]}</span>
            {row.map((n, h) => (
              <span
                key={h}
                className="aspect-square rounded-[3px]"
                style={{ background: color(n) }}
                title={`${DAYS[d]} ${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59 · ${n} ${n === 1 ? "reply" : "replies"}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>Fewer</span>
        {RAMP.map((c) => <span key={c} className="h-2.5 w-5 rounded-sm" style={{ background: c }} />)}
        <span>More replies</span>
        <span className="ml-auto">UK time · out-of-office replies left out</span>
      </div>
    </div>
  );
}
