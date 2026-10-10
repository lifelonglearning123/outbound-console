import Link from "next/link";
import { plainReading, portalStatus, GHL_TAGS, OUTCOME_LABEL, PORTAL, type Outcome, type GroupLead, type VerificationReport } from "@/lib/verifyReport";
import { deleteVerificationGroup, summariseVerification, tagVerificationGroup } from "@/app/leads/actions";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { ago } from "@/lib/format";

const n = (v: number) => v.toLocaleString("en-GB");
const TONE: Record<Outcome, string> = { verified: "text-go", catch_all: "text-wait", invalid: "text-bad" };
const MEANING: Record<Outcome, string> = {
  verified: "The mailbox exists. Safe to approve and send.",
  catch_all:
    "The company's mail server accepts every address, so no checker can confirm this person still works there. Approve them in small daily batches after the verified group.",
  invalid: "The mailbox doesn't exist and would bounce. These contacts won't be emailed.",
};

/**
 * The results of an address check: what they mean, an AI read on request, and the three groups with their
 * Nexus Portal actions and folded email lists. Used on a campaign's Contacts tab.
 */
export function VerificationGroups({
  clientId,
  campaignId,
  report: r,
  lists,
}: {
  clientId: number;
  campaignId: number | null;
  report: VerificationReport;
  lists: Record<Outcome, GroupLead[]>;
}) {
  const exportBase = `/clients/${clientId}/verification/export?${campaignId ? `campaign=${campaignId}&` : ""}group=`;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="card flex flex-col gap-2 p-5">
          <h3 className="font-semibold">What this means</h3>
          <div className="flex flex-col gap-2 text-sm">{plainReading(r).map((p, i) => <p key={i}>{p}</p>)}</div>
        </div>
        <div className="card flex flex-col gap-2 p-5">
          <div>
            <h3 className="font-semibold">AI summary</h3>
            <p className="text-xs text-muted">{r.summary ? `Written ${ago(r.summary.at)}` : "A short read of the results and what to do first, written from the numbers here."}</p>
          </div>
          {r.summary ? (
            <div className="flex flex-col gap-2 text-sm">{r.summary.text.split(/\n{2,}/).map((p, i) => <p key={i}>{p.trim()}</p>)}</div>
          ) : (
            <p className="text-sm text-muted">Not written yet.</p>
          )}
          {r.summaryError && <p className="text-sm text-bad">{r.summaryError}</p>}
          <form action={summariseVerification.bind(null, clientId, campaignId)}>
            <SubmitButton className="btn self-start" pendingLabel="Writing…">{r.summary ? "Write again" : "Write the summary"}</SubmitButton>
          </form>
        </div>
      </div>

      <div className="card flex flex-col gap-3 p-5">
        <div>
          <h3 className="font-semibold">Tags in the {PORTAL}</h3>
          <p className="text-xs text-muted">
            {r.portal.connected
              ? `Each group gets one tag on its contact in the ${PORTAL}, so you can filter, build lists or run workflows on it there. Tagging never removes anything.`
              : `The ${PORTAL} isn't connected for this client, so contacts can't be tagged yet.`}
          </p>
        </div>
        {r.portal.error && <p className="text-sm text-bad">{r.portal.error}</p>}
        <div className="grid grid-cols-3 gap-4">
          {(["verified", "catch_all", "invalid"] as const).map((o) => (
            <GroupCard
              key={o}
              clientId={clientId}
              campaignId={campaignId}
              outcome={o}
              count={r.counts[o]}
              status={r.portal.groups[o]}
              connected={r.portal.connected}
              leads={lists[o]}
              exportHref={`${exportBase}${o}`}
              extra={o === "catch_all" && r.catchAllDomains.length > 0 ? `Most common companies: ${r.catchAllDomains.slice(0, 6).map((d) => `${d.domain} (${d.n})`).join(", ")}` : undefined}
            />
          ))}
        </div>
      </div>
      {r.credits && (
        <p className="text-xs text-muted">
          Instantly verification credits left: <span className="num">{Number(r.credits).toLocaleString("en-GB")}</span>
        </p>
      )}
    </div>
  );
}

function GroupCard({
  clientId, campaignId, outcome, count, status, connected, leads, exportHref, extra,
}: {
  clientId: number;
  campaignId: number | null;
  outcome: Outcome;
  count: number;
  status: { tagged: number; deleted: number; tagTodo: number; deletable: number };
  connected: boolean;
  leads: GroupLead[];
  exportHref: string;
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
            <form action={tagVerificationGroup.bind(null, clientId, outcome, campaignId)}>
              <SubmitButton className={outcome === "verified" ? "btn-go" : "btn"} pendingLabel="Starting…">Tag {n(status.tagTodo)} as &ldquo;{tag}&rdquo;</SubmitButton>
            </form>
          )}
          {canDelete && status.deletable > 0 && (
            <form action={deleteVerificationGroup.bind(null, clientId, outcome as "invalid" | "catch_all", campaignId)}>
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
            <Link href={exportHref} className="btn self-start text-xs">Export as CSV</Link>
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
                      <td className="px-2 py-1 text-muted">{portalStatus(l, outcome)}{l.in_instantly ? " · sending" : ""}</td>
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
