import Link from "next/link";
import { archive, deleteEmpty, pauseCampaign, restore, resumeCampaign } from "@/app/campaigns/actions";
import { ago } from "@/lib/format";
import { CAMPAIGN_STATUS_LABEL } from "@/lib/stages";
import { startLabel } from "@/lib/startTime";
import { DEFAULT_TIMEZONE } from "@/lib/timezones";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";

export type CampaignRow = {
  id: number;
  client_id: number;
  name: string;
  status: string;
  source: string;
  instantly_campaign_id: string | null;
  daily_limit: number;
  managed: number;
  not_sending: string | null;
  last_synced_at: string | null;
  start_at: string | null;
  start_problem: string | null;
  archived_at: string | null;
  schedule: string;
  /** Everyone in it, approved or already with the sender, and waiting to be approved. */
  contacts: number;
  ready: number;
  to_approve: number;
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-go-soft text-go",
  paused: "bg-wait-soft text-wait",
  draft: "bg-line/60 text-muted",
  scheduled: "bg-info-soft text-info",
  completed: "bg-line/60 text-muted",
  archived: "bg-line/60 text-muted",
  error: "bg-bad-soft text-bad",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? ""}`}>{CAMPAIGN_STATUS_LABEL[status] ?? status}</span>;
}

/**
 * The next thing to do with a campaign that hasn't started, as one button. Start sending only appears once there's
 * someone to send to; until then it points at what's missing.
 */
export function NextStep({ href, id, contacts, ready, toApprove, quiet }: { href: string; id: number; contacts: number; ready: number; toApprove: number; quiet?: boolean }) {
  const main = quiet ? "btn" : "btn-go"; // in a list, the page's one main button stays the only green one
  if (ready > 0) {
    return <form action={resumeCampaign.bind(null, id)}><SubmitButton className={main} pendingLabel="Starting…">Start sending</SubmitButton></form>;
  }
  if (toApprove > 0) return <Link href={`${href}/approve`} className={main}>Approve contacts</Link>;
  if (contacts > 0) return <Link href={`${href}/contacts`} className="btn">View contacts</Link>;
  return <Link href={`${href}/contacts`} className={main}>Add contacts</Link>;
}

function startsAt(c: CampaignRow): string {
  let timezone = DEFAULT_TIMEZONE;
  try {
    timezone = JSON.parse(c.schedule).timezone ?? timezone;
  } catch {}
  return startLabel(new Date(c.start_at!), timezone);
}

export function CampaignTable({ clientId, campaigns }: { clientId: number; campaigns: CampaignRow[] }) {
  const shown = campaigns.filter((c) => !c.archived_at);
  const archived = campaigns.filter((c) => c.archived_at);
  const base = `/clients/${clientId}/campaigns`;
  return (
    <div className="flex flex-col gap-3">
      {shown.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-10 text-center">
          <div className="font-semibold">No campaigns yet</div>
          <p className="max-w-sm text-sm text-muted">A campaign is one email sequence sent to a list of contacts. Create one, add contacts, approve the email, start sending.</p>
          <Link href={`${base}/new`} className="btn-go mt-1">Create your first campaign</Link>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Campaign</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Daily limit</th>
                <th className="px-4 py-2.5 font-medium">Updated</th>
                <th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const href = `${base}/${c.id}`;
                const scheduled = c.status === "draft" && !!c.start_at;
                const ours = c.managed === 1 && c.source !== "nexus";
                const empty = ours && c.status === "draft" && Number(c.contacts) === 0 && !scheduled;
                const canArchive = ours && !empty && !scheduled && (c.status === "draft" || c.status === "completed");
                return (
                  <tr key={c.id} className="border-t border-line">
                    <td className="px-4 py-3">
                      <Link href={`${href}${c.status === "draft" ? "/contacts" : ""}`} className="font-medium hover:underline">{c.name}</Link>
                      {!c.managed && <span className="ml-2 text-xs text-muted" title="Set up outside the console, so its email isn't approved here">external</span>}
                      {c.status === "active" && c.not_sending && <div className="text-xs text-wait">{c.not_sending}</div>}
                      {scheduled && <div className="text-xs text-info">Starts {startsAt(c)}</div>}
                      {c.status === "draft" && c.start_problem && <div className="text-xs text-bad">Didn&apos;t start as scheduled</div>}
                    </td>
                    <td className="px-4 py-3"><StatusPill status={scheduled ? "scheduled" : c.status} /></td>
                    <td className="num px-4 py-3 text-right">{c.daily_limit}</td>
                    <td className="px-4 py-3 text-xs text-muted">{ago(c.last_synced_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
                        {empty && (
                          <form action={deleteEmpty.bind(null, c.id)}>
                            <ConfirmButton className="btn-quiet" message={`Delete "${c.name}"? It has no contacts and has never sent, so nothing is lost. This can't be undone.`}>Delete</ConfirmButton>
                          </form>
                        )}
                        {canArchive && (
                          <form action={archive.bind(null, c.id)}><SubmitButton className="btn-quiet" pendingLabel="Archiving…">Archive</SubmitButton></form>
                        )}
                        {c.instantly_campaign_id && (c.status === "active" ? (
                          <form action={pauseCampaign.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Pausing…">Pause sending</SubmitButton></form>
                        ) : c.status === "paused" ? (
                          <form action={resumeCampaign.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Resuming…">Resume sending</SubmitButton></form>
                        ) : c.status === "draft" && !scheduled ? (
                          ours ? (
                            <NextStep href={href} id={c.id} contacts={Number(c.contacts)} ready={Number(c.ready)} toApprove={Number(c.to_approve)} quiet />
                          ) : (
                            <form action={resumeCampaign.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Starting…">Start sending</SubmitButton></form>
                          )
                        ) : null)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {archived.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">Archived ({archived.length})</summary>
          <ul className="card mt-2 divide-y divide-line">
            {archived.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <Link href={`${base}/${c.id}`} className="hover:underline">{c.name}</Link>
                <form action={restore.bind(null, c.id)}><SubmitButton className="btn-quiet" pendingLabel="Restoring…">Restore</SubmitButton></form>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
