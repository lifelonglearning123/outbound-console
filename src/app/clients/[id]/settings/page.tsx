import { requireAdmin } from "@/lib/auth";
import { notFound } from "next/navigation";
import { getClient } from "@/lib/clients";
import { ClientForm } from "@/components/ClientForm";
import { SubmitButton } from "@/components/SubmitButton";
import { saveGap } from "@/app/campaigns/actions";
import { gapDays } from "@/lib/gap";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const client = await getClient(Number((await params).id));
  return { title: client ? `Settings · ${client.name}` : "Settings" };
}

export default async function ClientSettingsPage({ params }: PageProps<"/clients/[id]/settings">) {
  await requireAdmin(); // settings hold the API keys
  const client = await getClient(Number((await params).id));
  if (!client) notFound();
  const gap = await gapDays(client.id);
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="font-semibold">Settings</h2>
        <p className="text-sm text-muted">Connections and defaults for this client.</p>
      </header>
      <ClientForm client={client} />
      <form action={saveGap.bind(null, client.id)} className="card flex max-w-3xl flex-col gap-3 p-5">
        <div>
          <h3 className="font-semibold">Gap between campaigns</h3>
          <p className="text-sm text-muted">
            The least time between two of this client&apos;s campaigns emailing the same person. Someone who was emailed by one campaign waits
            out the gap before another one can email them, then goes by itself. Set 0 to turn it off.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div>
            <label className="label" htmlFor="gap-days">Days</label>
            <input id="gap-days" name="days" type="number" min={0} max={365} defaultValue={gap} className="field w-24" />
          </div>
          <SubmitButton className="btn" pendingLabel="Saving…">Save</SubmitButton>
        </div>
      </form>
    </div>
  );
}
