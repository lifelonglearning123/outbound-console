import { requireClientAccess } from "@/lib/auth";
import { saveCampaign } from "@/app/campaigns/actions";
import { DEFAULT_SCHEDULE, DEFAULT_STEPS, formMailboxes } from "@/lib/campaigns";
import { CampaignForm } from "@/components/CampaignForm";
import { requireClient } from "@/lib/clients";
import { listTags } from "@/lib/ghl";

export default async function NewCampaignPage({ params }: PageProps<"/clients/[id]/campaigns/new">) {
  const id = Number((await params).id);
  await requireClientAccess(id); // only admins and this client's own logins
  const mailboxes = await formMailboxes(id);
  // Tags from the client's GHL for the campaign's "GHL tag" suggestions (null = GHL not connected).
  const ghlClient = await requireClient(id);
  let ghlTags: string[] | null = null;
  if (ghlClient.ghl_location_id && ghlClient.ghl_token) {
    ghlTags = await listTags({ locationId: ghlClient.ghl_location_id, token: ghlClient.ghl_token }).catch(() => []);
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold">New campaign</h2>
        <p className="text-sm text-muted">Three short steps. You add contacts once it exists.</p>
      </div>
    <CampaignForm
      wizard
      action={saveCampaign.bind(null, id, null)}
      name=""
      steps={DEFAULT_STEPS}
      schedule={DEFAULT_SCHEDULE}
      dailyLimit={30}
      accounts={mailboxes.filter((m) => m.healthy).map((m) => m.email)}
      stopOnReply
      mailboxes={mailboxes}
      managed
      submitLabel="Create campaign"
      holdAfter={null}
      lockedLive={0}
      ghlTag={null}
      ghlTags={ghlTags}
    />
    </div>
  );
}
