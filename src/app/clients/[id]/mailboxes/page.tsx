import Link from "next/link";
import { requireClientAccess } from "@/lib/auth";
import { getClient, requireClient } from "@/lib/clients";
import { domainChecks, healthRules, mailboxActions, mailboxHealth } from "@/lib/mailboxHealth";
import { bounceStory, checkEvidence, filterEvidence, hostBySender, problemDomains } from "@/lib/deliverability";
import { clientAttention } from "@/lib/attention";
import { GATEWAY_LABEL } from "@/lib/mailhost";
import { hostLabel } from "@/lib/people";
import { INSTANTLY_RULE, DAY_MS, isoDay } from "@/lib/healthLogic";
import { dateTime, nowMs, pct } from "@/lib/format";
import { MailboxBoard } from "@/components/MailboxBoard";
import { AttentionList } from "@/components/AttentionList";
import { UndoWhy } from "@/components/UndoWhy";
import { SubmitButton } from "@/components/SubmitButton";
import { addProblemCompany, clearProblemCompany } from "@/app/mailboxes/actions";

const n = (v: number) => v.toLocaleString("en-GB");
const TONE: Record<string, string> = { go: "text-go", wait: "text-wait", bad: "text-bad", info: "text-info", muted: "text-muted" };

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Mailboxes · ${client.name}` : "Mailboxes" };
}

/**
 * Everything about getting the client's email delivered, in one place: its sending mailboxes (health, warmup, what the
 * console is doing with each) and the recipient side (why emails bounced, mail filters, companies that keep bouncing).
 */
export default async function ClientMailboxesPage({ params }: PageProps<"/clients/[id]/mailboxes">) {
  const clientId = Number((await params).id);
  const user = await requireClientAccess(clientId);
  const client = await requireClient(clientId);
  const rules = await healthRules();
  const boxes = await mailboxHealth(clientId, { rules });
  const checks = await domainChecks([...new Set(boxes.map((b) => b.domain))]);
  const todos = (await clientAttention(client, user.role === "admin", boxes)).filter((a) => a.action || a.href?.includes("/mailboxes"));
  const now = nowMs();
  const range = { from: isoDay(now - 29 * DAY_MS), to: isoDay(now) };
  const scope = { clientId, campaignId: null };
  const story = await bounceStory(scope, range);
  const filters = await filterEvidence(clientId);
  const problems = await problemDomains(clientId);
  const grid = await hostBySender(scope);
  const checksEvidence = await checkEvidence(clientId);
  const actions = await mailboxActions(clientId, isoDay(now - 13 * DAY_MS));
  const stats = `/clients/${clientId}/stats`;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h2 className="font-semibold">Mailboxes</h2>
        <p className="text-sm text-muted">
          The console never pauses a mailbox by itself, because a paused mailbox stops warming up. When one breaks the rules it
          rests: it comes out of campaigns, keeps warming up, and goes back once it&apos;s healthy, easing in over two weeks.
          {user.role === "admin" && <> The rules are on the <Link href="/mailboxes" className="underline">all-clients Mailboxes page</Link>.</>}
        </p>
      </header>

      {todos.length > 0 && <AttentionList clientId={clientId} items={todos} />}

      <MailboxBoard boxes={boxes} rules={rules} checks={checks} />

      {/* Recipient side */}
      <section id="bounces" className="flex scroll-mt-16 flex-col gap-2">
        <h2 className="font-semibold">Why emails bounced, last 30 days</h2>
        {story.bounced === 0 ? (
          <p className="text-sm text-muted">
            No bounces among the <span className="num">{n(story.emailed)}</span> people first emailed in the last 30 days.
          </p>
        ) : (
          <div className="card flex flex-col gap-2 p-4 text-sm">
            <p>
              <span className="num font-semibold">{n(story.bounced)}</span> of the <span className="num">{n(story.emailed)}</span> people
              emailed bounced ({pct(story.bounced, story.emailed)}).
            </p>
            <ul className="list-disc pl-5">
              {story.lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <Link href={`${stats}?status=bounced&from=${range.from}&to=${range.to}#people`} className="underline">See who bounced</Link>
              <Link href={`${stats}?range=30d&by=host`} className="underline">Every email host, side by side</Link>
            </p>
          </div>
        )}
      </section>

      {filters.length > 0 && (
        <section className="flex flex-col gap-2">
          <header>
            <h2 className="font-semibold">Mail filters, across all campaigns</h2>
            <p className="text-sm text-muted">
              Some companies screen email with a security filter that refuses senders it doesn&apos;t trust yet; Instantly counts that
              as a bounce. Hold or test a filter per campaign on its Contacts tab.
            </p>
          </header>
          <div className="card">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Filter</th>
                  <th className="px-3 py-2 text-right font-medium">Contacts</th>
                  <th className="px-3 py-2 text-right font-medium">Emailed</th>
                  <th className="px-3 py-2 text-right font-medium">Bounced</th>
                  <th className="px-3 py-2 text-right font-medium">Replied</th>
                  <th className="px-3 py-2 font-medium">Advice</th>
                </tr>
              </thead>
              <tbody>
                {filters.map((f) => (
                  <tr key={f.gateway} className="border-t border-line">
                    <td className="px-3 py-2 font-medium">{GATEWAY_LABEL[f.gateway] ?? f.gateway}</td>
                    <td className="num px-3 py-2 text-right">{n(f.contacts)}</td>
                    <td className="num px-3 py-2 text-right">{n(f.emailed)}</td>
                    <td className={`num px-3 py-2 text-right ${f.bounced ? "text-bad" : ""}`}>{n(f.bounced)}</td>
                    <td className="num px-3 py-2 text-right">{n(f.replied)}</td>
                    <td className={`px-3 py-2 text-xs ${TONE[f.advice.tone]}`}>
                      {f.advice.text}
                      {f.held > 0 && <span className="text-muted"> {n(f.held)} approved and waiting.</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section id="problem-companies" className="flex scroll-mt-16 flex-col gap-2">
        <header>
          <h2 className="font-semibold">Problem companies</h2>
          <p className="text-sm text-muted">
            Once two addresses at the same company bounce, its other contacts are held in every campaign: its mail server is refusing
            this client. Free mail services like Gmail never count. Take a company off the list to send to it again.
          </p>
        </header>
        {problems.length > 0 && (
          <div className="card">
            <table className="w-full text-sm">
              <tbody>
                {problems.map((p) => (
                  <tr key={p.domain} className="border-t border-line first:border-t-0">
                    <td className="px-3 py-2 font-medium">{p.domain}</td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {p.reason}. {p.auto ? "Added automatically" : "Added by hand"} {dateTime(p.created_at)}.
                      {Number(p.waiting) > 0 && <> {n(Number(p.waiting))} approved and held.</>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <form action={clearProblemCompany.bind(null, clientId, p.domain)}>
                        <SubmitButton className="btn text-xs" pendingLabel="Updating…">Send to them again</SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form action={addProblemCompany.bind(null, clientId)} className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="pd-domain">Add a company</label>
            <input id="pd-domain" name="domain" className="field w-56" placeholder="example.com" required />
          </div>
          <div className="min-w-0 flex-1">
            <label className="label" htmlFor="pd-reason">Why (optional)</label>
            <input id="pd-reason" name="reason" className="field" placeholder="e.g. asked us to stop" />
          </div>
          <SubmitButton pendingLabel="Adding…">Stop sending to it</SubmitButton>
        </form>
      </section>

      {grid.senders.length > 0 && (
        <section className="flex flex-col gap-2">
          <header>
            <h2 className="font-semibold">Their email host, by your sending domain</h2>
            <p className="text-sm text-muted">
              Bounce and reply rates of the people each sending domain has emailed. If Microsoft companies bounce much more than Google
              ones from the same domain, Instantly&apos;s ESP matching (on a campaign&apos;s Email tab) can pair like with like, when
              you have mailboxes of both kinds.
            </p>
          </header>
          <div className="card">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Their host</th>
                  {grid.senders.map((s) => <th key={s} className="px-3 py-2 text-right font-medium normal-case">{s.slice(1)}</th>)}
                </tr>
              </thead>
              <tbody>
                {grid.hosts.map((h) => (
                  <tr key={h} className="border-t border-line">
                    <td className="px-3 py-2">{hostLabel(h)}</td>
                    {grid.senders.map((s) => {
                      const c = grid.cell(h, s);
                      if (!c) return <td key={s} className="px-3 py-2 text-right text-muted">–</td>;
                      const bad = c.emailed >= 20 && c.bounced / c.emailed > INSTANTLY_RULE.bouncePct / 100;
                      return (
                        <td key={s} className="px-3 py-2 text-right text-xs" title={`${c.emailed} emailed, ${c.bounced} bounced, ${c.replied} replied`}>
                          <span className={bad ? "font-semibold text-bad" : ""}>{pct(c.bounced, c.emailed)} bounced</span>
                          <span className="text-muted"> · {pct(c.replied, c.emailed)} replied · <span className="num">{n(c.emailed)}</span></span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <header>
          <h2 className="font-semibold">Unconfirmed addresses</h2>
          <p className="text-sm text-muted">
            Addresses Instantly couldn&apos;t confirm (the company accepts everything) against verified ones. The Approve tab suggests a
            batch size for unconfirmed contacts from these numbers.
          </p>
        </header>
        <div className="card">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Week emailed</th>
                <th className="px-3 py-2 text-right font-medium">Verified: bounced</th>
                <th className="px-3 py-2 text-right font-medium">Unconfirmed: bounced</th>
              </tr>
            </thead>
            <tbody>
              {checksEvidence.weeks.map((w) => (
                <tr key={w.week} className="border-t border-line">
                  <td className="px-3 py-2">{new Date(`${w.week}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                  <td className="num px-3 py-2 text-right">{n(w.verifiedBounced)} of {n(w.verifiedEmailed)} <span className="text-xs text-muted">{pct(w.verifiedBounced, w.verifiedEmailed)}</span></td>
                  <td className="num px-3 py-2 text-right">{n(w.unconfirmedBounced)} of {n(w.unconfirmedEmailed)} <span className="text-xs text-muted">{pct(w.unconfirmedBounced, w.unconfirmedEmailed)}</span></td>
                </tr>
              ))}
              <tr className="border-t border-line bg-paper font-medium">
                <td className="px-3 py-2">All time</td>
                <td className="num px-3 py-2 text-right">
                  {n(checksEvidence.verified.bounced)} of {n(checksEvidence.verified.emailed)}{" "}
                  <span className="text-xs text-muted">{pct(checksEvidence.verified.bounced, checksEvidence.verified.emailed)}</span>
                </td>
                <td className="num px-3 py-2 text-right">
                  {n(checksEvidence.unconfirmed.bounced)} of {n(checksEvidence.unconfirmed.emailed)}{" "}
                  <span className="text-xs text-muted">{pct(checksEvidence.unconfirmed.bounced, checksEvidence.unconfirmed.emailed)}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">What the console did, last 14 days</h2>
        {actions.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <div className="card">
            <ul>
              {actions.map((a) => (
                <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 border-t border-line px-3 py-2 text-sm first:border-t-0">
                  <span className="min-w-0 flex-1">
                    <span className="mr-2 text-xs text-muted">{dateTime(a.at)}</span>
                    {a.message}
                  </span>
                  <UndoWhy a={{ ...a, client_id: clientId }} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
