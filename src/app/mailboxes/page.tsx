import { all, getSetting } from "@/lib/db";
import { healthRules } from "@/lib/sync";
import { ACCOUNT_STATUS, WARMUP_STATUS } from "@/lib/instantly";
import { dateTime, pct } from "@/lib/format";
import { saveHealthRules, setMailboxRunning } from "./actions";

type Box = {
  client_id: number; client: string; email: string; status: number | null; warmup_status: number | null;
  warmup_score: number | null; daily_limit: number | null; sent_today: number | null; sent_7d: number | null;
  bounced_7d: number | null; auto_paused_at: string | null; auto_paused_reason: string | null;
};

export default function MailboxesPage() {
  const rules = healthRules();
  const auto = getSetting("health_auto_pause", "1") === "1";
  const boxes = all<Box>(
    "SELECT m.*, c.name client FROM mailboxes m JOIN clients c ON c.id = m.client_id WHERE c.archived = 0 ORDER BY c.name, m.email",
  );

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Mailboxes</h1>
        <p className="text-sm text-muted">Every sending account across clients. The sync pauses any mailbox that breaks the rules below.</p>
      </header>

      <form action={saveHealthRules} className="card flex flex-wrap items-end gap-4 p-4 text-sm">
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" name="auto" defaultChecked={auto} /> Auto-pause unhealthy mailboxes
        </label>
        <div>
          <label className="label" htmlFor="bounce">Max bounce rate (7 days)</label>
          <div className="flex items-center gap-1"><input id="bounce" name="bounce" type="number" step="0.5" defaultValue={rules.bouncePct} className="field w-20" />%</div>
        </div>
        <div>
          <label className="label" htmlFor="min_sent">Only after</label>
          <div className="flex items-center gap-1"><input id="min_sent" name="min_sent" type="number" defaultValue={rules.minSent} className="field w-20" /> sends</div>
        </div>
        <div>
          <label className="label" htmlFor="warmup">Min warmup health</label>
          <input id="warmup" name="warmup" type="number" defaultValue={rules.minWarmupScore} className="field w-20" />
        </div>
        <button className="btn">Save rules</button>
        <p className="w-full text-xs text-muted">Auto-pause never resumes a mailbox by itself; you decide when it&apos;s safe.</p>
      </form>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Mailbox</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Warmup</th>
              <th className="px-3 py-2 text-right font-medium">Today</th>
              <th className="px-3 py-2 text-right font-medium">Sent 7d</th>
              <th className="px-3 py-2 font-medium">Bounce 7d</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {boxes.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-muted">No mailboxes yet. Add a client and check its Instantly key.</td></tr>}
            {boxes.map((b) => {
              const sent = b.sent_7d ?? 0;
              const bounced = b.bounced_7d ?? 0;
              const rate = sent ? (bounced / sent) * 100 : 0;
              const bad = sent >= rules.minSent && rate > rules.bouncePct;
              const warn = !bad && rate > rules.bouncePct * 0.66 && sent > 0;
              const scoreBad = b.warmup_score !== null && b.warmup_score < rules.minWarmupScore;
              return (
                <tr key={`${b.client_id}-${b.email}`} className="border-t border-line">
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs">{b.email}</div>
                    <div className="text-xs text-muted">{b.client}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={b.status === 1 ? "text-go" : "text-bad"}>{ACCOUNT_STATUS[b.status ?? 0] ?? b.status}</span>
                    {b.auto_paused_at && (
                      <div className="text-xs text-bad" title={b.auto_paused_reason ?? ""}>Auto-paused {dateTime(b.auto_paused_at)}: {b.auto_paused_reason}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-xs">{WARMUP_STATUS[b.warmup_status ?? 0] ?? "–"}</div>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 rounded-full bg-paper">
                        <div className={`h-1.5 rounded-full ${scoreBad ? "bg-bad" : "bg-go"}`} style={{ width: `${Math.min(100, b.warmup_score ?? 0)}%` }} />
                      </div>
                      <span className="num text-xs">{b.warmup_score ?? "–"}</span>
                    </div>
                  </td>
                  <td className="num px-3 py-2 text-right">{b.sent_today ?? 0}<span className="text-muted">/{b.daily_limit ?? "–"}</span></td>
                  <td className="num px-3 py-2 text-right">{sent}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 rounded-full bg-paper">
                        <div
                          className={`h-1.5 rounded-full ${bad ? "bg-bad" : warn ? "bg-wait" : "bg-go"}`}
                          style={{ width: `${Math.min(100, (rate / (rules.bouncePct * 2)) * 100)}%` }}
                        />
                      </div>
                      <span className={`num text-xs ${bad ? "text-bad" : ""}`}>{pct(bounced, sent)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {b.status === 1 ? (
                      <form action={setMailboxRunning.bind(null, b.client_id, b.email, false)}><button className="btn text-xs">Pause</button></form>
                    ) : b.status === 2 ? (
                      <form action={setMailboxRunning.bind(null, b.client_id, b.email, true)}><button className="btn text-xs">Resume</button></form>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
