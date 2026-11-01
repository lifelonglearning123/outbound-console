import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import { formMailboxes, getCampaign, isNexus, liveSteps, NEXUS_NOTICE, pushedLeadCount } from "@/lib/campaigns";
import { saveCampaign } from "@/app/campaigns/actions";
import { CampaignForm } from "@/components/CampaignForm";
import { requireClient } from "@/lib/clients";
import { get } from "@/lib/db";
import { listTags } from "@/lib/ghl";

/** Email tab: the sequence, who it comes from, and when it goes. */
export default async function CampaignEmailPage({ params }: PageProps<"/clients/[id]/campaigns/[cid]/email">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  // Nexus writes this campaign's emails and keeps its steps; nothing to edit here.
  if (isNexus(c)) return <p className="text-sm text-muted">{NEXUS_NOTICE}</p>;

  const mailboxes = await formMailboxes(clientId);
  const client = await requireClient(clientId);
  let ghlTags: string[] | null = null;
  if (client.ghl_location_id && client.ghl_token) {
    ghlTags = await listTags({ locationId: client.ghl_location_id, token: client.ghl_token }).catch(() => []);
  }
  const pushed = await pushedLeadCount(c.id);
  const prepared = (await get<{ n: number }>(
    "SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND pushed_at IS NULL AND instantly_lead_id IS NULL AND stage IN ('review', 'approved')",
    c.id,
  ))?.n ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {pushed > 0 && c.managed === 1 && (
        <p className="text-sm text-muted">
          {pushed.toLocaleString("en-GB")} contacts are already with the sender and keep the emails they have. Changes here apply to everyone not yet sent.
        </p>
      )}
      {prepared > 0 && c.managed === 1 && (
        <p className="text-sm text-muted">
          {prepared.toLocaleString("en-GB")} contacts have their emails prepared. If you change an email and save, it&apos;s prepared again for them and needs approving again, including any edits made to it one by one.
        </p>
      )}
      <CampaignForm
        action={saveCampaign.bind(null, clientId, c.id)}
        name={c.name}
        steps={c.steps}
        schedule={c.schedule}
        dailyLimit={c.daily_limit}
        accounts={c.accounts}
        stopOnReply={c.stop_on_reply === 1}
        mailboxes={mailboxes}
        matchEsp={c.match_esp === 1}
        managed={c.managed === 1}
        submitLabel="Save changes"
        holdAfter={c.hold_after}
        lockedLive={pushed ? liveSteps(c) : 0}
        ghlTag={c.ghl_tag}
        ghlTags={ghlTags}
      />
    </div>
  );
}
