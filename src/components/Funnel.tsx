import type { FunnelData } from "@/lib/stats";
import { pct } from "@/lib/format";

/** Horizontal funnel: each stage's bar is scaled to the widest stage, with step conversion underneath. */
export function Funnel({ data }: { data: FunnelData }) {
  const stages = [
    { label: "Approved", value: data.approved, hint: "leads you signed off" },
    { label: "Sent", value: data.sent, hint: "emails, all steps" },
    { label: "Opened", value: data.opened, hint: "unique opens" },
    { label: "Replied", value: data.replied, hint: "unique replies" },
    { label: "Interested", value: data.interested, hint: "tagged interested" },
    { label: "In Nexus Portal", value: data.inGhl, hint: "sent to the client's CRM" },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));

  return (
    <div className="card grid grid-cols-[1fr_220px] gap-6 p-5">
      <div className="grid grid-cols-6 gap-3">
        {stages.map((s, i) => (
          <div key={s.label} className="flex flex-col gap-1.5">
            <div className="text-xs uppercase tracking-wide text-muted">{s.label}</div>
            <div className="num text-2xl font-semibold">{s.value.toLocaleString("en-GB")}</div>
            <div className="h-1.5 rounded-full bg-paper">
              <div className="h-1.5 rounded-full bg-go" style={{ width: `${(s.value / max) * 100}%` }} />
            </div>
            <div className="text-xs text-muted">
              {i <= 1 ? s.hint : <><span className="num">{pct(s.value, stages[i - 1].value)}</span> of {stages[i - 1].label.toLowerCase()}</>}
            </div>
          </div>
        ))}
      </div>
      <Sparkline daily={data.daily} bounced={data.bounced} sent={data.mailboxSent} />
    </div>
  );
}

function Sparkline({ daily, bounced, sent }: { daily: FunnelData["daily"]; bounced: number; sent: number }) {
  const w = 220;
  const h = 64;
  const max = Math.max(1, ...daily.map((d) => d.sent));
  const x = (i: number) => (daily.length <= 1 ? w : (i / (daily.length - 1)) * w);
  const y = (v: number) => h - (v / max) * (h - 4) - 2;
  const line = (key: "sent" | "replied") => daily.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");

  return (
    <div className="flex flex-col gap-1.5 border-l border-line pl-5">
      <div className="flex justify-between text-xs text-muted">
        <span>Sent per day</span>
        <span>
          Bounce <span className={`num ${sent && bounced / sent > 0.03 ? "text-bad" : ""}`}>{pct(bounced, sent)}</span>
        </span>
      </div>
      {daily.length === 0 ? (
        <div className="flex h-16 items-center text-xs text-muted">No sends yet</div>
      ) : (
        <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label="Emails sent per day">
          <path d={line("sent")} fill="none" stroke="var(--go)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <path d={line("replied")} fill="none" stroke="var(--wait)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          {daily.length === 1 && <circle cx={w - 3} cy={y(daily[0].sent)} r="3" fill="var(--go)" />}
        </svg>
      )}
      <div className="flex gap-3 text-xs text-muted">
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-go align-middle" />sent</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-wait align-middle" />replies</span>
      </div>
    </div>
  );
}
