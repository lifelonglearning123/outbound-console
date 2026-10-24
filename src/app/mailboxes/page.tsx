import { clientScope, requireUser } from "@/lib/auth";
import { domainChecks, healthRules, mailboxHealth } from "@/lib/mailboxHealth";
import { INSTANTLY_RULE } from "@/lib/healthLogic";
import { MailboxBoard } from "@/components/MailboxBoard";
import { saveHealthRules } from "./actions";

export const metadata = { title: "Mailboxes" };

/** Every sending mailbox across clients, and (for admins) the health rules the sync applies to them. */
export default async function MailboxesPage() {
  const u = await requireUser();
  const rules = await healthRules();
  const boxes = await mailboxHealth(null, { rules, scopeSql: clientScope(u, "m.client_id") });
  const checks = await domainChecks([...new Set(boxes.map((b) => b.domain))]);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Mailboxes</h1>
        <p className="text-sm text-muted">
          Every sending mailbox across clients. A mailbox that breaks the rules below rests: it comes out of its campaigns while its
          warmup keeps running, then goes back by itself once it&apos;s healthy. The console never pauses a mailbox, because that
          stops its warmup too.
        </p>
      </header>

      {u.role === "admin" && (
        <form action={saveHealthRules} className="card flex flex-col gap-4 p-5 text-sm">
          <h2 className="font-semibold">Health rules</h2>

          <Rule
            title="Rest a mailbox when too many of its emails bounce"
            instantly={`Instantly pauses a whole campaign once it has sent ${INSTANTLY_RULE.minSent} emails with over ${INSTANTLY_RULE.bouncePct}% bouncing. The console uses the same line per mailbox, so it is never stricter.`}
          >
            <span>Over</span>
            <input name="bounce" type="number" step="0.25" min="0.5" defaultValue={rules.bouncePct} className="field w-20" aria-label="Bounce rate limit, percent" />
            <span>% bounced, once it has sent</span>
            <input name="min_sent" type="number" min="1" defaultValue={rules.minSent} className="field w-20" aria-label="Minimum emails sent" />
            <span>emails in the last</span>
            <input name="window" type="number" min="1" defaultValue={rules.windowDays} className="field w-16" aria-label="Days counted" />
            <span>days.</span>
          </Rule>

          <Rule
            title="Rest a mailbox whose warmup lands in spam"
            instantly="Instantly shows a warmup health score (the share of warmup emails reaching the inbox) but doesn't act on it. A score of 0 with no warmup running means no data, so it never counts."
          >
            <span>Warmup health under</span>
            <input name="warmup" type="number" min="0" max="100" defaultValue={rules.minWarmupScore} className="field w-20" aria-label="Minimum warmup health" />
            <span>while warmup is running. Set 0 to switch this off.</span>
          </Rule>

          <Rule
            title="Put a resting mailbox back"
            instantly="Instantly never puts anything back by itself: a campaign it paused stays paused until you press play (it then won't pause it again for 7 days)."
          >
            <span>After it has looked healthy for</span>
            <input name="return_days" type="number" min="1" defaultValue={rules.returnDays} className="field w-16" aria-label="Days healthy before returning" />
            <span>days (warmup health at the minimum or better).</span>
          </Rule>

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2"><input type="checkbox" name="auto_rest" defaultChecked={rules.autoRest} /> Rest mailboxes automatically</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="auto_return" defaultChecked={rules.autoReturn} /> Put them back automatically</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="ease_in" defaultChecked={rules.easeIn} /> Ease them in when they return (5 a day, up to their usual limit over two weeks)
            </label>
          </div>
          <div>
            <button className="btn-go">Save rules</button>
          </div>
        </form>
      )}

      <MailboxBoard boxes={boxes} rules={rules} checks={checks} showClient />
    </div>
  );
}

function Rule({ title, instantly, children }: { title: string; instantly: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-6">
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">{children}</div>
      </div>
      <p className="text-xs text-muted"><span className="font-medium text-ink">Instantly&apos;s own rule: </span>{instantly}</p>
    </div>
  );
}
