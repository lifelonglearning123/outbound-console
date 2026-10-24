import type { WarmupDay } from "@/lib/healthLogic";

const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * Fourteen days of warmup as tiny bars: height is warmup emails sent that day, green the share that reached the
 * inbox, red the share that went to spam. A flat grey tick is a day with no warmup at all.
 */
export function WarmupBars({ days }: { days: WarmupDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.sent));
  const sent = days.reduce((a, d) => a + d.sent, 0);
  const inbox = days.reduce((a, d) => a + d.inbox, 0);
  const spam = days.reduce((a, d) => a + d.spam, 0);
  const label = sent
    ? `Warmup, last 14 days: ${inbox} of ${sent} warmup emails reached the inbox, ${spam} went to spam`
    : "No warmup emails sent in the last 14 days";
  return (
    <div className="flex h-6 items-end gap-px" role="img" aria-label={label}>
      {days.map((d) => {
        const h = d.sent ? Math.max(4, Math.round((d.sent / max) * 24)) : 2;
        const spamH = d.sent ? Math.round((d.spam / d.sent) * h) : 0;
        const inboxH = d.sent ? Math.round((d.inbox / d.sent) * h) : 0;
        const otherH = Math.max(0, h - spamH - inboxH);
        return (
          <div key={d.date} className="flex w-1.5 flex-col justify-end" title={`${fmt(d.date)}: ${d.sent} warmup emails, ${d.inbox} inbox, ${d.spam} spam`}>
            {d.sent ? (
              <>
                {spamH > 0 && <div className="bg-bad" style={{ height: spamH }} />}
                {otherH > 0 && <div className="bg-line" style={{ height: otherH }} />}
                {inboxH > 0 && <div className="bg-go" style={{ height: inboxH }} />}
              </>
            ) : (
              <div className="bg-line" style={{ height: 2 }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
