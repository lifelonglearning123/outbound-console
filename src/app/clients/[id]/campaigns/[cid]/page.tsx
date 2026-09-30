import { notFound } from "next/navigation";
import { all, get } from "@/lib/db";
import { campaignStepProblems, getCampaign, liveSteps, pushedLeadCount } from "@/lib/campaigns";
import { AutoRefresh } from "@/components/AutoRefresh";
import { holdStatus } from "@/lib/hold";
import { HoldPanel } from "@/components/HoldPanel";
import { saveCampaign, pauseCampaign, resumeCampaign } from "@/app/campaigns/actions";
import { CampaignForm } from "@/components/CampaignForm";
import { requireClient } from "@/lib/clients";
import { listTags } from "@/lib/ghl";
import { LeadJourney } from "@/components/LeadJourney";
import { StatusPill } from "@/components/CampaignTable";
import { ago, pct } from "@/lib/format";

export default async function CampaignPage({ params }: PageProps<"/clients/[id]/campaigns/[cid]">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  const c = getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();

  const mailboxes = all<{ email: string; status: number }>("SELECT email, status FROM mailboxes WHERE client_id = ? ORDER BY email", clientId);
  // Tags from the client's GHL for the campaign's "GHL tag" suggestions (null = GHL not connected).
  const ghlClient = requireClient(clientId);
  let ghlTags: string[] | null = null;
  if (ghlClient.ghl_location_id && ghlClient.ghl_token) {
    ghlTags = await listTags({ locationId: ghlClient.ghl_location_id, token: ghlClient.ghl_token }).catch(() => []);
  }
  const t = get<{ sent: number; opened: number; replied: number; opportunities: number }>(
    `SELECT COALESCE(SUM(sent),0) sent, COALESCE(SUM(opened),0) opened, COALESCE(SUM(replied),0) replied, COALESCE(SUM(opportunities),0) opportunities
     FROM daily_stats WHERE campaign_id = ?`,
    c.id,
  )!;
  const pipeline = get<{ review: number; approved: number; pushed: number }>(
    `SELECT SUM(stage = 'review') review, SUM(stage = 'approved') approved, SUM(stage = 'pushed' OR stage LIKE 'extend_%') pushed FROM leads WHERE campaign_id = ?`,
    c.id,
  )!;
  const live = liveSteps(c);
  const hasHold = c.managed === 1 && (c.hold_after !== null || c.release_to !== null);
  const hold = hasHold ? holdStatus(c.id) : null;
  // For each "release up to step N" choice, what still needs finishing in the held steps.
  const stepProblems = Object.fromEntries(
    c.steps.map((_, i) => [i + 1, campaignStepProblems(c.steps.slice(0, i + 1))]),
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">{c.name}</h2>
            <StatusPill status={c.status} />
            {!c.managed && <span className="text-xs text-muted">created in Instantly — copy is managed there</span>}
          </div>
          <p className="text-sm text-muted">
            {c.status === "active" && c.not_sending ? <span className="text-wait">{c.not_sending} · </span> : null}
            synced {ago(c.last_synced_at)}
          </p>
        </div>
        {c.instantly_campaign_id && (c.status === "active" ? (
          <form action={pauseCampaign.bind(null, c.id)}><button className="btn">Pause sending</button></form>
        ) : c.status === "paused" || c.status === "draft" ? (
          <form action={resumeCampaign.bind(null, c.id)}><button className="btn-go">{c.status === "draft" ? "Launch" : "Resume sending"}</button></form>
        ) : null)}
      </header>

      <div className="grid grid-cols-7 gap-3">
        {[
          { l: "In review", v: pipeline.review ?? 0, tone: "text-wait" },
          { l: "Approved, not pushed", v: pipeline.approved ?? 0 },
          { l: "In Instantly", v: pipeline.pushed ?? 0 },
          { l: "Sent", v: t.sent },
          { l: "Opened", v: t.opened, sub: pct(t.opened, t.sent) },
          { l: "Replied", v: t.replied, sub: pct(t.replied, t.sent) },
          { l: "Opportunities", v: t.opportunities },
        ].map((k) => (
          <div key={k.l} className="card p-3">
            <div className="text-xs text-muted">{k.l}</div>
            <div className={`num text-xl font-semibold ${k.tone ?? ""}`}>{k.v.toLocaleString("en-GB")}</div>
            {k.sub && <div className="num text-xs text-muted">{k.sub}</div>}
          </div>
        ))}
      </div>

      <AutoRefresh active={!!hold?.writing} />
      {hold && <HoldPanel campaignId={c.id} clientId={clientId} status={hold} stepProblems={stepProblems} />}

      {c.managed ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Lead journey</h3>
          <LeadJourney campaignId={c.id} stepCount={c.steps.length} live={live} delays={c.steps.map((s) => s.delay_days)} />
        </section>
      ) : null}

      <details className="group">
        <summary className="cursor-pointer text-sm font-semibold">Edit {c.managed ? "sequence, schedule and limits" : "schedule and limits"}</summary>
        <div className="mt-3">
          <CampaignForm
            action={saveCampaign.bind(null, clientId, c.id)}
            name={c.name}
            steps={c.steps}
            schedule={c.schedule}
            dailyLimit={c.daily_limit}
            accounts={c.accounts}
            stopOnReply={c.stop_on_reply === 1}
            mailboxes={mailboxes.map((m) => ({ email: m.email, healthy: m.status === 1 }))}
            managed={c.managed === 1}
            submitLabel="Save and update Instantly"
            holdAfter={c.hold_after}
            lockedLive={pushedLeadCount(c.id) ? liveSteps(c) : 0}
            ghlTag={c.ghl_tag}
            ghlTags={ghlTags}
          />
        </div>
      </details>
    </div>
  );
}
