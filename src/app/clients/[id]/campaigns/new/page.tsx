import { all } from "@/lib/db";
import { saveCampaign } from "@/app/campaigns/actions";
import { DEFAULT_SCHEDULE, DEFAULT_STEPS } from "@/lib/campaigns";
import { CampaignForm } from "@/components/CampaignForm";

export default async function NewCampaignPage({ params }: PageProps<"/clients/[id]/campaigns/new">) {
  const id = Number((await params).id);
  const mailboxes = all<{ email: string; status: number }>("SELECT email, status FROM mailboxes WHERE client_id = ? ORDER BY email", id);
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
    />
  );
}
