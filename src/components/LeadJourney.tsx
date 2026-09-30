import { all } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { INTEREST_STATUS, LEAD_STATUS } from "@/lib/instantly";

type JourneyRow = {
  id: number;
  email: string;
  first_name: string | null;
  company: string | null;
  instantly_status: number | null;
  interest_status: number | null;
  pushed_at: string | null;
  sent_steps: string | null;   // comma list of steps sent
  last_out: string | null;
  replied_at: string | null;
};

/** One row per lead: a dot per sequence step (sent / next / waiting) plus reply and status. */
export function LeadJourney({ campaignId, stepCount, live, delays }: { campaignId: number; stepCount: number; live: number; delays: number[] }) {
  const rows = all<JourneyRow>(
    `SELECT l.id, l.email, l.first_name, l.company, l.instantly_status, l.interest_status, l.pushed_at,
            (SELECT GROUP_CONCAT(DISTINCT e.step) FROM emails e WHERE e.lead_id = l.id AND e.direction = 'out') sent_steps,
            (SELECT MAX(e.sent_at) FROM emails e WHERE e.lead_id = l.id AND e.direction = 'out') last_out,
            (SELECT MIN(e.sent_at) FROM emails e WHERE e.lead_id = l.id AND e.direction = 'in') replied_at
     FROM leads l WHERE l.campaign_id = ? AND (l.stage = 'pushed' OR l.stage LIKE 'extend_%')
     ORDER BY replied_at IS NULL, last_out DESC NULLS LAST, l.pushed_at DESC
     LIMIT 500`,
    campaignId,
  );

  if (rows.length === 0) {
    return <div className="card p-4 text-sm text-muted">No leads in Instantly for this campaign yet. Approve some in the approval queue.</div>;
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Lead</th>
            <th className="px-3 py-2 font-medium">Sequence</th>
            <th className="px-3 py-2 font-medium">Next</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sent = new Set((r.sent_steps ?? "").split(",").filter(Boolean).map(Number));
            // "Completed" in Instantly only means finished when there's no hold still to come.
            const stopped = r.instantly_status !== null && [-1, -2, -3].includes(r.instantly_status);
            const done = r.replied_at || stopped || (r.instantly_status === 3 && live >= stepCount);
            const nextStep = done ? null : Array.from({ length: live }, (_, i) => i + 1).find((s) => !sent.has(s)) ?? null;
            const onHold = !done && nextStep === null && live < stepCount && !r.replied_at;
            let nextAt = "";
            if (nextStep && nextStep > 1 && r.last_out) {
              const due = new Date(new Date(r.last_out).getTime() + (delays[nextStep - 2] ?? 0) * 86400_000);
              nextAt = `due ~${dateTime(due.toISOString())}`;
            } else if (nextStep === 1) {
              nextAt = "queued for first send";
            }
            return (
              <tr key={r.id} className="border-t border-line">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.first_name ?? r.email}</div>
                  <div className="text-xs text-muted">{r.company ?? r.email}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    {Array.from({ length: stepCount }, (_, i) => i + 1).map((s) => (
                      <span
                        key={s}
                        title={`Step ${s}: ${sent.has(s) ? "sent" : s === nextStep ? "next" : s > live ? "on hold" : "waiting"}`}
                        className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
                          sent.has(s)
                            ? "bg-go text-white"
                            : s === nextStep
                              ? "border-2 border-go text-go"
                              : s > live
                                ? "border border-dashed border-wait text-wait"
                                : "border border-line text-muted"
                        }`}
                      >
                        {s}
                      </span>
                    ))}
                    {r.replied_at && <span className="ml-1 rounded bg-wait-soft px-1.5 text-xs text-wait">replied</span>}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-muted">{onHold ? <span className="text-wait">On hold after step {live}</span> : nextStep ? `Step ${nextStep} ${nextAt}` : r.replied_at ? `Replied ${dateTime(r.replied_at)}` : "–"}</td>
                <td className="px-3 py-2 text-xs">
                  {r.interest_status !== null
                    ? INTEREST_STATUS[r.interest_status] ?? r.interest_status
                    : onHold
                      ? "Waiting for next emails"
                      : LEAD_STATUS[r.instantly_status ?? 1] ?? ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
