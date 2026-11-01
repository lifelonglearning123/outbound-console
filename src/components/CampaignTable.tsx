import Link from "next/link";
import { pauseCampaign, resumeCampaign } from "@/app/campaigns/actions";
import { ago } from "@/lib/format";
import { CAMPAIGN_STATUS_LABEL } from "@/lib/stages";
import { startLabel } from "@/lib/startTime";
import { DEFAULT_TIMEZONE } from "@/lib/timezones";

export type CampaignRow = {
  id: number;
  client_id: number;
  name: string;
  status: string;
  instantly_campaign_id: string | null;
  daily_limit: number;
  managed: number;
  not_sending: string | null;
  last_synced_at: string | null;
  start_at: string | null;
  start_problem: string | null;
  schedule: string;
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-go-soft text-go",
  paused: "bg-wait-soft text-wait",
  draft: "bg-paper text-muted",
  scheduled: "bg-info-soft text-info",
  completed: "bg-info-soft text-info",
  error: "bg-bad-soft text-bad",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? ""}`}>{CAMPAIGN_STATUS_LABEL[status] ?? status}</span>;
}

function startsAt(c: CampaignRow): string {
  let timezone = DEFAULT_TIMEZONE;
  try {
    timezone = JSON.parse(c.schedule).timezone ?? timezone;
  } catch {}
  return startLabel(new Date(c.start_at!), timezone);
}

export function CampaignTable({ clientId, campaigns }: { clientId: number; campaigns: CampaignRow[] }) {
  if (campaigns.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-2 p-10 text-center">
        <div className="font-semibold">No campaigns yet</div>
        <p className="max-w-sm text-sm text-muted">A campaign is one email sequence sent to a list of contacts. Create one, add contacts, approve the email, start sending.</p>
        <Link href={`/clients/${clientId}/campaigns/new`} className="btn-go mt-1">Create your first campaign</Link>
      </div>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Campaign</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Daily cap</th>
            <th className="px-3 py-2 font-medium">Updated</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} className="border-t border-line">
              <td className="px-3 py-2">
                <Link href={`/clients/${clientId}/campaigns/${c.id}${c.status === "draft" ? "/contacts" : ""}`} className="font-medium hover:underline">{c.name}</Link>
                {!c.managed && <span className="ml-2 text-xs text-muted" title="Set up outside the console, so its email isn't approved here">external</span>}
                {c.status === "active" && c.not_sending && <div className="text-xs text-wait">{c.not_sending}</div>}
                {c.status === "draft" && c.start_at && <div className="text-xs text-info">Starts {startsAt(c)}</div>}
                {c.status === "draft" && c.start_problem && <div className="text-xs text-bad">Didn&apos;t start as scheduled</div>}
              </td>
              <td className="px-3 py-2"><StatusPill status={c.status === "draft" && c.start_at ? "scheduled" : c.status} /></td>
              <td className="num px-3 py-2 text-right">{c.daily_limit}</td>
              <td className="px-3 py-2 text-xs text-muted">{ago(c.last_synced_at)}</td>
              <td className="px-3 py-2 text-right">
                {c.instantly_campaign_id && (c.status === "active" ? (
                  <form action={pauseCampaign.bind(null, c.id)}><button className="btn">Pause sending</button></form>
                ) : c.status === "draft" && c.start_at ? null : c.status === "paused" || c.status === "draft" ? (
                  <form action={resumeCampaign.bind(null, c.id)}><button className="btn-go">{c.status === "draft" ? "Start sending" : "Resume sending"}</button></form>
                ) : null)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
