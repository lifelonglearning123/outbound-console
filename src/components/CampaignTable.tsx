import Link from "next/link";
import { pauseCampaign, resumeCampaign } from "@/app/campaigns/actions";
import { ago } from "@/lib/format";

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
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-go-soft text-go",
  paused: "bg-wait-soft text-wait",
  draft: "bg-paper text-muted",
  completed: "bg-info-soft text-info",
  error: "bg-bad-soft text-bad",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[status] ?? ""}`}>{status}</span>;
}

export function CampaignTable({ clientId, campaigns }: { clientId: number; campaigns: CampaignRow[] }) {
  if (campaigns.length === 0) {
    return <div className="card p-4 text-sm text-muted">No campaigns yet.</div>;
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Campaign</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Daily cap</th>
            <th className="px-3 py-2 font-medium">Synced</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} className="border-t border-line">
              <td className="px-3 py-2">
                <Link href={`/clients/${clientId}/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                {!c.managed && <span className="ml-2 text-xs text-muted" title="Created directly in Instantly, so its copy isn't approved here">external</span>}
                {c.status === "active" && c.not_sending && <div className="text-xs text-wait">{c.not_sending}</div>}
              </td>
              <td className="px-3 py-2"><StatusPill status={c.status} /></td>
              <td className="num px-3 py-2 text-right">{c.daily_limit}</td>
              <td className="px-3 py-2 text-xs text-muted">{ago(c.last_synced_at)}</td>
              <td className="px-3 py-2 text-right">
                {c.instantly_campaign_id && (c.status === "active" ? (
                  <form action={pauseCampaign.bind(null, c.id)}><button className="btn">Pause</button></form>
                ) : c.status === "paused" || c.status === "draft" ? (
                  <form action={resumeCampaign.bind(null, c.id)}><button className="btn-go">{c.status === "draft" ? "Launch" : "Resume"}</button></form>
                ) : null)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
