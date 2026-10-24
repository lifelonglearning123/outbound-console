import Link from "next/link";
import type { MailboxHealth, DomainCheck } from "@/lib/mailboxHealth";
import type { HealthRules } from "@/lib/healthLogic";
import { ago, pct } from "@/lib/format";
import {
  bringBackMailboxes, checkDnsNow, easeIn, restNow, returnNow, setMailboxRunning, stopEasingNow, warmupOn,
} from "@/app/mailboxes/actions";
import { SubmitButton } from "./SubmitButton";
import { ConfirmButton } from "./ConfirmButton";
import { WarmupBars } from "./WarmupBars";

const TONE: Record<string, string> = { go: "text-go", wait: "text-wait", bad: "text-bad", info: "text-info", muted: "text-muted" };
const PILL: Record<string, string> = {
  go: "bg-go-soft text-go", wait: "bg-wait-soft text-wait", bad: "bg-bad-soft text-bad", info: "bg-info-soft text-info", muted: "bg-paper text-muted",
};
const n = (v: number) => v.toLocaleString("en-GB");

/** The id a mailbox's row has, so the Activity list and alerts can link straight to it. */
export const mailboxAnchor = (email: string) => `mb-${email.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** A client's (or every client's) mailboxes, grouped by sending domain, each with its state, warmup, sends and actions. */
export function MailboxBoard({
  boxes, rules, checks = [], showClient = false,
}: {
  boxes: MailboxHealth[];
  rules: HealthRules;
  checks?: DomainCheck[];
  showClient?: boolean;
}) {
  if (boxes.length === 0) {
    return <div className="card p-6 text-sm text-muted">No mailboxes yet. Check the client&apos;s Instantly key in Settings to pull them in.</div>;
  }
  const groups: { key: string; clientId: number; client: string; domain: string; boxes: MailboxHealth[] }[] = [];
  for (const b of boxes) {
    const key = `${b.clientId}:${b.domain}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.boxes.push(b);
    else groups.push({ key, clientId: b.clientId, client: b.client, domain: b.domain, boxes: [b] });
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <DomainCard
          key={g.key}
          clientId={g.clientId}
          client={g.client}
          domain={g.domain}
          boxes={g.boxes}
          rules={rules}
          check={checks.find((c) => c.domain === g.domain)}
          showClient={showClient}
        />
      ))}
    </div>
  );
}

function DomainCard({
  clientId, client, domain, boxes, rules, check, showClient,
}: {
  clientId: number; client: string; domain: string; boxes: MailboxHealth[]; rules: HealthRules; check?: DomainCheck; showClient: boolean;
}) {
  const count = (k: string) => boxes.filter((b) => b.state.key === k).length;
  const parts = [
    count("sending") && `${count("sending")} sending`,
    count("easing") && `${count("easing")} easing in`,
    count("resting") && `${count("resting")} resting`,
    count("paused") && `${count("paused")} paused`,
    count("error") && `${count("error")} not connected`,
    count("maintenance") && `${count("maintenance")} in maintenance`,
  ].filter(Boolean);
  const sent = boxes.reduce((a, b) => a + b.window.sent, 0);
  const bounced = boxes.reduce((a, b) => a + b.window.bounced, 0);
  const wSent = boxes.reduce((a, b) => a + b.warmup.sent7, 0);
  const wInbox = boxes.reduce((a, b) => a + b.warmup.inbox7, 0);
  const records = check ? ([["MX", check.mx], ["SPF", check.spf], ["DKIM", check.dkim], ["DMARC", check.dmarc]] as const) : [];

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-paper px-4 py-3">
        <div className="min-w-0">
          <h3 className="font-semibold">
            {domain}
            {showClient && <span className="ml-2 text-sm font-normal text-muted">{client}</span>}
          </h3>
          <p className="text-xs text-muted">
            {parts.join(", ")}. Campaign bounces, last {rules.windowDays} days: <span className="num">{n(bounced)}</span> of{" "}
            <span className="num">{n(sent)}</span> ({pct(bounced, sent)}). Warmup reaching the inbox this week: {pct(wInbox, wSent)}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {check ? (
            <span className="flex flex-wrap items-center gap-2" title={`Checked by Instantly ${ago(check.checked_at)}`}>
              {records.map(([label, ok]) => (
                <span key={label} className={ok ? "text-go" : ok === false ? "font-semibold text-bad" : "text-muted"}>
                  {ok ? "✓" : ok === false ? "✗" : "?"} {label}
                </span>
              ))}
              <span className="text-muted">· checked {ago(check.checked_at)}</span>
            </span>
          ) : (
            <span className="text-muted">DNS not checked yet</span>
          )}
          <form action={checkDnsNow.bind(null, clientId)}>
            <SubmitButton className="btn text-xs" pendingLabel="Checking…">Check DNS</SubmitButton>
          </form>
        </div>
      </header>
      {check && check.all_pass === false && (
        <p className="border-b border-line bg-bad-soft px-4 py-2 text-sm text-bad">
          Some of this domain&apos;s DNS records are missing or wrong. Mail from it is likely to be refused or sent to spam until
          they&apos;re fixed where the domain is registered.
        </p>
      )}
      <ul>
        {boxes.map((m) => <MailboxRow key={m.email} m={m} rules={rules} />)}
      </ul>
    </section>
  );
}

function MailboxRow({ m, rules }: { m: MailboxHealth; rules: HealthRules }) {
  const rate = m.window.sent ? (m.window.bounced / m.window.sent) * 100 : 0;
  const bounceTone = m.bounceProblem ? "font-semibold text-bad" : rate > rules.bouncePct ? "text-wait" : "";
  const why = `/clients/${m.clientId}/stats?status=bounced&sender=${encodeURIComponent(m.email)}#people`;
  const act = (action: (form: FormData) => void, label: string, pending: string, cls = "btn text-xs") => (
    <form action={action}>
      <SubmitButton className={cls} pendingLabel={pending}>{label}</SubmitButton>
    </form>
  );

  return (
    <li id={mailboxAnchor(m.email)} className="flex scroll-mt-16 flex-col gap-3 border-t border-line px-4 py-3 first:border-t-0 lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto] lg:items-start lg:gap-5">
      <div className="min-w-0">
        <div className="break-all font-mono text-xs">{m.email}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${PILL[m.state.tone]}`}>{m.state.label}</span>
          <span className={`text-xs ${TONE[m.readiness.tone]}`}>{m.readiness.label}</span>
        </div>
        {m.detail && <p className="mt-1 text-xs text-muted">{m.detail}</p>}
        {m.suggestion && <p className="mt-1 text-xs text-info">Suggested: {m.suggestion.text}</p>}
        {m.campaigns.length > 0 && (
          <p className="mt-1 text-xs text-muted">
            In{" "}
            {m.campaigns.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ", "}
                <Link href={`/clients/${m.clientId}/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
                {c.resting && " (resting out of it)"}
                {c.status === "paused" && " (paused)"}
              </span>
            ))}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted">Warmup, 14 days</div>
        <WarmupBars days={m.trend} />
        <div className="text-xs">
          {m.warmup.active ? (
            <>
              <span className="num">{pct(m.warmup.inbox7, m.warmup.sent7)}</span> to the inbox this week
              {m.warmup.spam7 > 0 && <span className="text-bad"> · {n(m.warmup.spam7)} to spam</span>}
            </>
          ) : (
            <span className="text-muted">No warmup emails this week</span>
          )}
          <span className="text-muted">
            {" "}· health {m.warmup.active ? m.score ?? "–" : "no data"}
            {m.warmupAgeDays !== null && ` · warmup started ${n(m.warmupAgeDays)} days ago`}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <div>
          <span className="text-muted">Campaign emails today: </span>
          <span className="num">{n(m.sentToday)}</span>
          <span className="text-muted">/{m.dailyLimit ?? "–"}</span>
        </div>
        <div className={bounceTone}>
          <span className="text-muted">Bounced, {rules.windowDays} days: </span>
          <span className="num">{n(m.window.bounced)}</span> of <span className="num">{n(m.window.sent)}</span> ({pct(m.window.bounced, m.window.sent)})
          {m.window.bounced > 0 && (
            <>
              {" "}
              <Link href={why} className="underline">Why?</Link>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 lg:justify-end">
        {m.state.key === "sending" && (
          <>
            {m.suggestion?.ease && act(easeIn.bind(null, m.clientId, m.email), "Ease in", "Starting…")}
            {act(restNow.bind(null, m.clientId, m.email), "Rest", "Resting…")}
          </>
        )}
        {m.state.key === "easing" && (
          <>
            {act(stopEasingNow.bind(null, m.clientId, m.email), `Full ${m.ramp?.target ?? ""} a day now`, "Updating…")}
            {act(restNow.bind(null, m.clientId, m.email), "Rest", "Resting…")}
          </>
        )}
        {m.state.key === "resting" && act(returnNow.bind(null, m.clientId, m.email), "Put back now", "Putting back…")}
        {m.state.key === "paused" && (
          <>
            {act(bringBackMailboxes.bind(null, m.clientId, [m.email]), "Bring back", "Bringing back…", "btn-go text-xs")}
            {!m.stuck && (
              <form action={setMailboxRunning.bind(null, m.clientId, m.email, true)}>
                <ConfirmButton
                  className="btn text-xs"
                  message={`Resume ${m.email} in Instantly? It goes straight back into its campaigns. "Bring back" instead keeps it out of campaigns until its warmup has rebuilt.`}
                >
                  Resume
                </ConfirmButton>
              </form>
            )}
          </>
        )}
        {m.warmupStatus === 0 && m.state.key !== "error" && act(warmupOn.bind(null, m.clientId, m.email), "Turn warmup on", "Turning on…")}
        {m.state.key === "error" && (
          <a href="https://app.instantly.ai/app/accounts" target="_blank" rel="noreferrer" className="btn text-xs">Fix in Instantly</a>
        )}
        {(m.state.key === "sending" || m.state.key === "easing" || m.state.key === "resting") && (
          <form action={setMailboxRunning.bind(null, m.clientId, m.email, false)}>
            <ConfirmButton
              className="btn text-xs"
              message={`Pause ${m.email} in Instantly? It stops sending and also stops warming up, so its warmup score will fall. "Rest" keeps warmup running instead.`}
            >
              Pause
            </ConfirmButton>
          </form>
        )}
      </div>
    </li>
  );
}
