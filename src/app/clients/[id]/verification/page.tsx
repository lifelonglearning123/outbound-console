import { requireClientAccess } from "@/lib/auth";
import Link from "next/link";
import { after } from "next/server";
import { verificationReport, plainReading, runVerificationActions, GHL_TAGS } from "@/lib/verifyReport";
import { runVerifier } from "@/lib/verify";
import { removeVerifiedGroup, summariseVerification, tagVerificationInGhl } from "@/app/leads/actions";
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

export default async function VerificationPage({ params }: PageProps<"/clients/[id]/verification">) {
  const clientId = Number((await params).id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const r = await verificationReport(clientId);
  const busy = r.checking > 0 || r.ghl.queued > 0;
  if (r.checking > 0) after(runVerifier);
  if (r.ghl.queued > 0) after(runVerificationActions);
  const share = (v: number) => (r.checked ? `${Math.round((v / r.checked) * 100)}% of checked` : "");

  const tiles = [
    { label: "Verified", value: r.counts.verified, sub: share(r.counts.verified), tone: "text-go" },
    { label: "Catch-all", value: r.counts.catch_all, sub: share(r.counts.catch_all), tone: "text-wait" },
    { label: "Invalid", value: r.counts.invalid, sub: share(r.counts.invalid), tone: "text-bad" },
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
        <Section title="AI summary" note={r.summary ? `Written ${ago(r.summary.at)}` : "A short read of the results and the order to act in, written by the model from the numbers on this page."}>
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

      <Section title="What to do with each group" note={r.ghl.connected ? "Each action updates the contact in GHL, the source of truth, so the result is visible there too." : "GHL isn't connected for this client, so only the console is updated."}>
        {r.ghl.error && <p className="text-sm text-bad">{r.ghl.error}</p>}
        {r.ghl.queued > 0 && <p className="text-sm text-info">Updating {n(r.ghl.queued)} contacts in GHL…</p>}
        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col gap-2 rounded-md border border-line p-4">
            <div className="font-medium text-go">Verified · {n(r.counts.verified)}</div>
            <p className="text-sm text-muted">Safe to send. Tag them in GHL as &ldquo;{GHL_TAGS.verified}&rdquo; so the clean list can be reused for any future campaign.</p>
            <p className="text-xs text-muted">Tagged so far: <span className="num">{n(r.ghl.tagged.verified)}</span></p>
            {r.ghl.todo.verified > 0 && (
              <form action={tagVerificationInGhl.bind(null, clientId, "verified")}>
                <button className="btn-go">Tag {n(r.ghl.todo.verified)} in GHL</button>
              </form>
            )}
          </div>
          <div className="flex flex-col gap-2 rounded-md border border-line p-4">
            <div className="font-medium text-wait">Catch-all · {n(r.counts.catch_all)}</div>
            <p className="text-sm text-muted">
              Can&rsquo;t be confirmed. Their first email carries a reviewer flag, so &ldquo;approve all unflagged&rdquo; leaves them out; approve them in small daily batches after the verified group. Tag them &ldquo;{GHL_TAGS.catch_all}&rdquo; in GHL.
            </p>
            <p className="text-xs text-muted">Tagged so far: <span className="num">{n(r.ghl.tagged.catch_all)}</span></p>
            {r.ghl.todo.catch_all > 0 && (
              <form action={tagVerificationInGhl.bind(null, clientId, "catch_all")}>
                <button className="btn">Tag {n(r.ghl.todo.catch_all)} in GHL</button>
              </form>
            )}
            {r.catchAllDomains.length > 0 && (
              <div className="text-xs text-muted">
                Most common: {r.catchAllDomains.slice(0, 8).map((d) => `${d.domain} (${d.n})`).join(", ")}
              </div>
            )}
            {r.ghl.connected && r.ghl.catchAllRemovable > 0 && (
              <form action={removeVerifiedGroup.bind(null, clientId, "catch_all", true)}>
                <ConfirmButton
                  className="btn text-bad"
                  message={`Delete ${n(r.ghl.catchAllRemovable)} catch-all contacts from GHL and remove them from the console? This can't be undone.`}
                >
                  Remove {n(r.ghl.catchAllRemovable)} and delete from GHL
                </ConfirmButton>
              </form>
            )}
          </div>
          <div className="flex flex-col gap-2 rounded-md border border-line p-4">
            <div className="font-medium text-bad">Invalid · {n(r.counts.invalid)}</div>
            <p className="text-sm text-muted">Would bounce. They&rsquo;re already rejected here. Remove them from the console and mark the GHL contact &ldquo;{GHL_TAGS.invalid}&rdquo;, or delete the contact from GHL as well.</p>
            {r.ghl.todo.invalid > 0 ? (
              <div className="flex flex-col gap-2">
                <form action={removeVerifiedGroup.bind(null, clientId, "invalid", false)}>
                  <button className="btn">Remove {n(r.ghl.todo.invalid)} and tag in GHL</button>
                </form>
                {r.ghl.connected && (
                  <form action={removeVerifiedGroup.bind(null, clientId, "invalid", true)}>
                    <ConfirmButton
                      className="btn text-bad"
                      message={`Delete ${n(r.ghl.todo.invalid)} contacts from GHL as well as the console? This can't be undone.`}
                    >
                      Remove {n(r.ghl.todo.invalid)} and delete from GHL
                    </ConfirmButton>
                  </form>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted">{r.counts.invalid ? "Nothing left to remove." : ""}</p>
            )}
          </div>
        </div>
      </Section>

      {r.campaigns.length > 0 && (
        <Section title="By campaign">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Campaign</th>
                <th className="py-1 pr-3 font-medium">Verified</th>
                <th className="py-1 pr-3 font-medium">Catch-all</th>
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
