import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import { all } from "@/lib/db";
import { getCampaign, liveSteps, pushedLeadCount } from "@/lib/campaigns";
import { saveCampaign } from "@/app/campaigns/actions";
import { CampaignForm } from "@/components/CampaignForm";
import { requireClient } from "@/lib/clients";
import { listTags } from "@/lib/ghl";

/** Email tab: the sequence, who it comes from, and when it goes. */
export default async function CampaignEmailPage({ params }: PageProps<"/clients/[id]/campaigns/[cid]/email">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();

  const mailboxes = await all<{ email: string; status: number }>("SELECT email, status FROM mailboxes WHERE client_id = ? ORDER BY email", clientId);
  const client = await requireClient(clientId);
  let ghlTags: string[] | null = null;
  if (client.ghl_location_id && client.ghl_token) {
    ghlTags = await listTags({ locationId: client.ghl_location_id, token: client.ghl_token }).catch(() => []);
  }
  const pushed = await pushedLeadCount(c.id);

  return (
    <div className="flex flex-col gap-4">
      {pushed > 0 && c.managed === 1 && (
        <p className="text-sm text-muted">
          {pushed.toLocaleString("en-GB")} contacts have already been sent this email. Changes here only affect emails prepared after the change.
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
        mailboxes={mailboxes.map((m) => ({ email: m.email, healthy: m.status === 1 }))}
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
