import { requireClientAccess } from "@/lib/auth";
import Link from "next/link";
import { after } from "next/server";
import {
  verificationReport, plainReading, runVerificationActions, groupLeads, portalStatus,
  GHL_TAGS, OUTCOME_LABEL, PORTAL, type Outcome, type GroupLead,
} from "@/lib/verifyReport";
import { runVerifier } from "@/lib/verify";
import { deleteVerificationGroup, summariseVerification, tagVerificationGroup } from "@/app/leads/actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ago } from "@/lib/format";

function Section({ title, note, children, className = "" }: { title: string; note?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card flex flex-col gap-3 p-5 ${className}`}>
      <div>
        <h2 className="font-semibold">{title}</h2>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

const n = (v: number) => v.toLocaleString("en-GB");
const TONE: Record<Outcome, string> = { verified: "text-go", catch_all: "text-wait", invalid: "text-bad" };
const MEANING: Record<Outcome, string> = {
  verified: "The mailbox exists. Safe to approve and send.",
  catch_all:
    "The company's mail server accepts every address, so no checker can confirm this person still works there. Their first email carries a reviewer flag, so “approve all unflagged” leaves them out; approve them in small daily batches after the verified group.",
  invalid: "The mailbox doesn't exist and would bounce. These leads are already rejected and won't be emailed.",
};

export default async function VerificationPage({ params }: PageProps<"/clients/[id]/verification">) {
  const clientId = Number((await params).id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const r = await verificationReport(clientId);
  const busy = r.checking > 0 || r.portal.queued > 0;
  if (r.checking > 0) after(runVerifier);
  if (r.portal.queued > 0) after(runVerificationActions);
  const share = (v: number) => (r.checked ? `${Math.round((v / r.checked) * 100)}% of checked` : "");
  const lists = {
    verified: await groupLeads(clientId, "verified"),
    catch_all: await groupLeads(clientId, "catch_all"),
    invalid: await groupLeads(clientId, "invalid"),
  };

  const tiles = [
    { label: "Verified", value: r.counts.verified, sub: share(r.counts.verified), tone: TONE.verified },
    { label: "Unable to verify", value: r.counts.catch_all, sub: share(r.counts.catch_all), tone: TONE.catch_all },
    { label: "Invalid", value: r.counts.invalid, sub: share(r.counts.invalid), tone: TONE.invalid },
    { label: "Not checked", value: r.unchecked, sub: r.pushedUnchecked ? `+ ${n(r.pushedUnchecked)} already in Instantly` : "", tone: "text-muted" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={busy} />

      <div className="grid grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="card p-4">
            <div className="text-xs uppercase tracking-wide text-muted">{t.label}</div>
            <div className={`num text-2xl font-semibold ${t.tone}`}>{n(t.value)}</div>
            <div className="text-xs text-muted">{t.sub || " "}</div>
          </div>
        ))}
      </div>

      {r.checking > 0 && <p className="text-sm text-info">Still checking {n(r.checking)} addresses… this page updates on its own.</p>}
      {!r.checked && !r.checking && (
        <p className="text-sm text-muted">
          Nothing checked yet. Go to <Link href={`/clients/${clientId}/leads`} className="underline">Leads</Link> and click &ldquo;Check email addresses&rdquo; first.
        </p>
      )}

      <div className="grid grid-cols-2 gap-6">
        <Section title="What this means">
          <div className="flex flex-col gap-2 text-sm">
            {plainReading(r).map((p, i) => <p key={i}>{p}</p>)}
          </div>
        </Section>
        <Section title="AI summary" note={r.summary ? `Written ${ago(r.summary.at)}` : "A short read of the results and the order to act in, written by the AI from the numbers on this page."}>
          {r.summary ? (
            <div className="flex flex-col gap-2 text-sm">{r.summary.text.split(/\n{2,}/).map((p, i) => <p key={i}>{p.trim()}</p>)}</div>
          ) : (
            <p className="text-sm text-muted">Not written yet.</p>
          )}
          {r.summaryError && <p className="text-sm text-bad">{r.summaryError}</p>}
          {r.checked > 0 && (
            <form action={summariseVerification.bind(null, clientId)}>
              <button className="btn">{r.summary ? "Write again" : "Write the summary"}</button>
            </form>
          )}
        </Section>
      </div>

      <Section
        title={`Tags in the ${PORTAL}`}
        note={
          r.portal.connected
            ? `Each group gets one tag on its contact in the ${PORTAL}, so you can filter, build lists or run workflows on it there. Tagging never removes anything.`
            : `The ${PORTAL} isn't connected for this client, so contacts can't be tagged yet.`
        }
      >
        {r.portal.error && <p className="text-sm text-bad">{r.portal.error}</p>}
        {r.portal.queued > 0 && <p className="text-sm text-info">Updating {n(r.portal.queued)} contacts in the {PORTAL}… this page updates on its own.</p>}
        <div className="grid grid-cols-3 gap-4">
          {(["verified", "catch_all", "invalid"] as const).map((o) => (
            <GroupCard
              key={o}
              clientId={clientId}
              outcome={o}
              count={r.counts[o]}
              status={r.portal.groups[o]}
              connected={r.portal.connected}
              leads={lists[o]}
              extra={o === "catch_all" && r.catchAllDomains.length > 0 ? `Most common companies: ${r.catchAllDomains.slice(0, 6).map((d) => `${d.domain} (${d.n})`).join(", ")}` : undefined}
            />
          ))}
        </div>
      </Section>

      {r.campaigns.length > 0 && (
        <Section title="By campaign">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Campaign</th>
                <th className="py-1 pr-3 font-medium">Verified</th>
                <th className="py-1 pr-3 font-medium">Unable to verify</th>
                <th className="py-1 pr-3 font-medium">Invalid</th>
                <th className="py-1 pr-3 font-medium">Not checked</th>
              </tr>
            </thead>
            <tbody>
              {r.campaigns.map((c) => (
                <tr key={c.id} className="border-t border-line">
                  <td className="py-1.5 pr-3"><Link href={`/clients/${clientId}/campaigns/${c.id}`} className="underline">{c.name}</Link></td>
                  <td className="num py-1.5 pr-3 text-go">{n(c.verified)}</td>
                  <td className="num py-1.5 pr-3 text-wait">{n(c.catch_all)}</td>
                  <td className="num py-1.5 pr-3 text-bad">{n(c.invalid)}</td>
                  <td className="num py-1.5 pr-3 text-muted">{n(c.unchecked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {r.credits && <p className="text-xs text-muted">Instantly verification credits left: <span className="num">{Number(r.credits).toLocaleString("en-GB")}</span></p>}
    </div>
  );
}

function GroupCard({
  clientId, outcome, count, status, connected, leads, extra,
}: {
  clientId: number;
  outcome: Outcome;
  count: number;
  status: { tagged: number; deleted: number; tagTodo: number; deletable: number };
  connected: boolean;
  leads: GroupLead[];
  extra?: string;
}) {
  const tag = GHL_TAGS[outcome];
  const canDelete = outcome !== "verified";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-4">
      <div>
        <div className={`font-medium ${TONE[outcome]}`}>{OUTCOME_LABEL[outcome]} · <span className="num">{n(count)}</span></div>
        <div className="mt-1 inline-flex items-center gap-1.5 rounded border border-line bg-paper px-2 py-0.5 text-xs">
          <span className="text-muted">{PORTAL} tag</span>
          <span className="font-medium">{tag}</span>
        </div>
      </div>
      <p className="text-sm text-muted">{MEANING[outcome]}</p>
      {extra && <p className="text-xs text-muted">{extra}</p>}

      <p className="text-xs text-muted">
        Tagged <span className="num">{n(status.tagged)}</span>
        {canDelete && <> · deleted from the {PORTAL} <span className="num">{n(status.deleted)}</span></>}
      </p>

      {connected && (status.tagTodo > 0 || (canDelete && status.deletable > 0)) && (
        <div className="flex flex-col gap-2">
          {status.tagTodo > 0 && (
            <form action={tagVerificationGroup.bind(null, clientId, outcome)}>
              <button className={outcome === "verified" ? "btn-go" : "btn"}>Tag {n(status.tagTodo)} as &ldquo;{tag}&rdquo;</button>
            </form>
          )}
          {canDelete && status.deletable > 0 && (
            <form action={deleteVerificationGroup.bind(null, clientId, outcome)}>
              <ConfirmButton
                className="btn text-bad"
                message={`Delete ${n(status.deletable)} ${OUTCOME_LABEL[outcome].toLowerCase()} contacts from the ${PORTAL}? This can't be undone. They stay listed here for your records.`}
              >
                Delete {n(status.deletable)} from the {PORTAL}
              </ConfirmButton>
            </form>
          )}
        </div>
      )}

      {leads.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Show the {n(leads.length)} emails</summary>
          <div className="mt-2 flex flex-col gap-2">
            <a href={`/clients/${clientId}/verification/export?group=${outcome}`} className="btn self-start text-xs">Export as CSV</a>
            <div className="max-h-80 overflow-y-auto rounded border border-line">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-paper text-left text-muted">
                  <tr>
                    <th className="px-2 py-1 font-medium">Email</th>
                    <th className="px-2 py-1 font-medium">{PORTAL}</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr key={l.email} className="border-t border-line">
                      <td className="px-2 py-1">
                        <div className="break-all">{l.email}</div>
                        {(l.company || l.first_name) && (
                          <div className="text-muted">{[[l.first_name, l.last_name].filter(Boolean).join(" "), l.company].filter(Boolean).join(" · ")}</div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-muted">{portalStatus(l, outcome)}{l.in_instantly ? " · in Instantly" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
