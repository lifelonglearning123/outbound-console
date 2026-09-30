import { requireClientAccess } from "@/lib/auth";
import { all } from "@/lib/db";
import { saveCampaign } from "@/app/campaigns/actions";
import { DEFAULT_SCHEDULE, DEFAULT_STEPS } from "@/lib/campaigns";
import { CampaignForm } from "@/components/CampaignForm";
import { requireClient } from "@/lib/clients";
import { listTags } from "@/lib/ghl";

export default async function NewCampaignPage({ params }: PageProps<"/clients/[id]/campaigns/new">) {
  const id = Number((await params).id);
  await requireClientAccess(id); // only admins and this client's own logins
  const mailboxes = await all<{ email: string; status: number }>("SELECT email, status FROM mailboxes WHERE client_id = ? ORDER BY email", id);
  // Tags from the client's GHL for the campaign's "GHL tag" suggestions (null = GHL not connected).
  const ghlClient = await requireClient(id);
  let ghlTags: string[] | null = null;
  if (ghlClient.ghl_location_id && ghlClient.ghl_token) {
    ghlTags = await listTags({ locationId: ghlClient.ghl_location_id, token: ghlClient.ghl_token }).catch(() => []);
  }
  return (
    <CampaignForm
      action={saveCampaign.bind(null, id, null)}
      name=""
      steps={DEFAULT_STEPS}
      schedule={DEFAULT_SCHEDULE}
      dailyLimit={30}
      accounts={mailboxes.filter((m) => m.status === 1).map((m) => m.email)}
      stopOnReply
      mailboxes={mailboxes.map((m) => ({ email: m.email, healthy: m.status === 1 }))}
      managed
      submitLabel="Create campaign in Instantly (as draft)"
      holdAfter={null}
      lockedLive={0}
      ghlTag={null}
      ghlTags={ghlTags}
    />
  );
}
