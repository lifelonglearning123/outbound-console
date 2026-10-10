import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getCampaign } from "@/lib/campaigns";
import { batchInfo } from "@/lib/progress";
import { reviewQueue, approvalCounts } from "@/lib/approvals";
import { approveGroupAndSend, sendApproved } from "@/app/leads/actions";
import { ApprovalQueue } from "@/components/ApprovalQueue";
import { AutoRefresh } from "@/components/AutoRefresh";
import { SubmitButton } from "@/components/SubmitButton";
import { htmlToText, toHtml } from "@/lib/merge";

const n = (v: number) => v.toLocaleString("en-GB");

/**
 * Approve tab. A campaign that sends the client's own email to everyone is approved in batches: look at the
 * email once, approve a whole group. AI-written emails are read one contact at a time.
 */
export default async function CampaignApprovePage({ params, searchParams }: PageProps<"/clients/[id]/campaigns/[cid]/approve">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  const sp = await searchParams;
  const eachOne = sp.each === "1";
  const b = await batchInfo(c.id);
  const counts = await approvalCounts(clientId, c.id);
  const base = `/clients/${clientId}/campaigns/${c.id}`;
  const waiting = b.groups.verified + b.groups.catch_all;

  if (!b.fixed || eachOne) {
    const leads = await reviewQueue(clientId, 200, c.id);
    return (
      <div className="flex flex-col gap-3">
        {b.fixed && <Link href={`${base}/approve`} className="text-sm underline">← Back to approving in one go</Link>}
        <AutoRefresh active={counts.drafting > 0 && leads.length === 0} />
        <ApprovalQueue leads={leads} clientId={clientId} campaignId={c.id} approvedCount={counts.approved} draftingCount={counts.drafting} showClient={false} />
      </div>
    );
  }

  const sample = b.sample;
  const preview = sample ? (sample.format === "html" ? sample.body : toHtml(sample.body)) : "";
  const words = sample ? htmlToText(preview).trim().split(/\s+/).length : 0;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh active={counts.drafting > 0} />

      {b.approvedNotSent > 0 && (
        <div className="card flex items-center justify-between gap-4 border-wait/40 bg-wait-soft/40 p-4 text-sm">
          <span>{n(b.approvedNotSent)} contacts are approved but haven&apos;t been handed over for sending yet.</span>
          <form action={sendApproved.bind(null, c.id)}><SubmitButton className="btn-go" pendingLabel="Sending…">Send {n(b.approvedNotSent)} now</SubmitButton></form>
        </div>
      )}

      {waiting === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          {counts.drafting > 0
            ? `Preparing ${n(counts.drafting)} emails…`
            : b.checking > 0
              ? `${n(b.checking)} addresses are still being checked. Contacts appear here once they pass.`
              : <>Nothing ready to send. <Link href={`${base}/contacts`} className="underline">Add contacts</Link> to get started.</>}
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_380px] gap-6">
          <section className="card flex flex-col gap-3 p-5">
            <div>
              <h2 className="font-semibold">The email everyone gets</h2>
              <p className="text-xs text-muted">
                Shown as {sample?.email ?? "one contact"} will receive it; only the name and company change per person. <span className="num">{words}</span> words.{" "}
                <Link href={`${base}/email`} className="underline">Edit the email</Link>
              </p>
            </div>
            {sample?.subject && <div className="rounded-md border border-line bg-paper px-3 py-2 text-sm"><span className="text-muted">Subject: </span>{sample.subject}</div>}
            {/* Exactly what the contact will see; sandboxed so the email's own HTML can't touch the app. */}
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;margin:14px;color:#222}</style></head><body>${preview}</body></html>`}
              className="h-[560px] w-full rounded-md border border-line bg-white"
            />
          </section>

          <aside className="flex flex-col gap-4">
            <Group
              campaignId={c.id}
              group="verified"
              title="Ready to send"
              count={b.groups.verified}
              tone="text-go"
              note="Verified addresses with their email prepared. Safe to send to all of them."
              primary
            />
            <Group
              campaignId={c.id}
              group="catch_all"
              title="Unconfirmed, your call"
              count={b.groups.catch_all}
              tone="text-wait"
              note="Their company accepts every address, so some may bounce. Send a few at a time and watch the bounce figure on the Sending tab."
              batch
            />
            {b.checking > 0 && (
              <p className="text-xs text-muted">{n(b.checking)} more contacts are still being checked and will appear here once they pass.</p>
            )}
            {b.flagged > 0 && (
              <p className="text-xs text-muted">
                {n(b.flagged)} of these have a note, such as a missing first name. Approving a group sends them as they are.{" "}
                <Link href={`${base}/approve?each=1`} className="underline">Go through them one by one</Link> instead.
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Group({
  campaignId, group, title, count, tone, note, primary, batch,
}: {
  campaignId: number;
  group: "verified" | "catch_all";
  title: string;
  count: number;
  tone: string;
  note: string;
  primary?: boolean;
  batch?: boolean;
}) {
  if (count === 0) return null;
  const action = approveGroupAndSend.bind(null, campaignId, group);
  return (
    <div className="card flex flex-col gap-2 p-4">
      <div className={`font-medium ${tone}`}>{title} · <span className="num">{n(count)}</span></div>
      <p className="text-sm text-muted">{note}</p>
      {batch ? (
        <form action={action} className="flex items-center gap-2">
          <SubmitButton pendingLabel="Approving…">Approve and send the next</SubmitButton>
          <input name="limit" type="number" min={1} max={count} defaultValue={Math.min(30, count)} className="field w-20" aria-label="How many" />
        </form>
      ) : (
        <form action={action}>
          <SubmitButton className={primary ? "btn-go" : "btn"} pendingLabel="Approving…">Approve and send all {n(count)}</SubmitButton>
        </form>
      )}
    </div>
  );
}
