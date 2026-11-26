import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { campaignStepProblems, formMailboxes, getCampaign, isNexus, NEXUS_NOTICE } from "@/lib/campaigns";
import { getClient } from "@/lib/clients";
import { approvedBreakdown } from "@/lib/push";
import { campaignProgress } from "@/lib/progress";
import { sendingLine } from "@/lib/sendingLine";
import { dontWait, pauseAndRelease, pauseCampaign, restore, resumeCampaign, sendAnyway } from "@/app/campaigns/actions";
import { PauseButton } from "@/components/PauseButton";
import { unsentCount } from "@/lib/takeOut";
import { ConfirmButton } from "@/components/ConfirmButton";
import { NextStep, StatusPill } from "@/components/CampaignTable";
import { ScheduleBanner, ScheduleButton } from "@/components/ScheduleStart";
import { Tabs } from "@/components/Tabs";
import { TabNext, type NextItem } from "@/components/TabNext";
import { get } from "@/lib/db";

import { Working } from "@/components/Working";
import { SubmitButton } from "@/components/SubmitButton";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PORTAL } from "@/lib/verifyReport";

const n = (v: number) => v.toLocaleString("en-GB");

export async function generateMetadata({ params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  const [c, client] = [await getCampaign(Number(cid)), await getClient(Number(id))];
  return { title: c && client ? `${c.name} · ${client.name}` : client?.name ?? "Campaign" };
}

/** Every campaign page: name, sending controls and the tabs pinned at the top, then three boxes: contacts, emailed, replies. */
export default async function CampaignLayout({ children, params }: LayoutProps<"/clients/[id]/campaigns/[cid]">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  const p = await campaignProgress(c.id);
  const split = await approvedBreakdown(c.id);
  const stuck = split.approved - split.sendable;
  const base = `/clients/${clientId}/campaigns/${c.id}`;
  // Run from Nexus: Nexus writes and approves, so there is no copy or approval to open here.
  const nexus = isNexus(c);
  // Started, but every mailbox it sends from is resting: it starts by itself when one is back, unless someone sends anyway.
  const waiting = !!c.waiting_mailbox_at && c.status !== "active" && !c.archived_at;
  const restingBoxes = waiting ? (await formMailboxes(clientId)).filter((m) => m.resting && c.accounts.includes(m.email)) : [];
  const sendLine = c.status === "active" ? await sendingLine(c) : null;
  const unsent = c.status === "active" ? await unsentCount(c.id) : 0;

  // People, not emails: emailed so far, and handed over but not emailed yet. Interested replies for the third box.
  const people = (await get<{ emailed: number; queued: number }>(
    `SELECT COUNT(*) FILTER (WHERE emailed) emailed, COUNT(*) FILTER (WHERE handed AND NOT emailed AND COALESCE(instantly_status, 1) = 1) queued
     FROM (SELECT l.instantly_status,
             (l.pushed_at IS NOT NULL OR l.instantly_lead_id IS NOT NULL) handed,
             (l.last_sent_at IS NOT NULL OR COALESCE(l.instantly_status, 0) IN (3, -1)
               OR EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.direction = 'out')) emailed
           FROM leads l WHERE l.campaign_id = ? AND l.stage <> 'removed') x`,
    c.id,
  ))!;
  const interested = Number((await get<{ n: number }>(
    "SELECT COUNT(DISTINCT lead_email) n FROM emails WHERE campaign_id = ? AND direction = 'in' AND interest = 'interested'", c.id,
  ))?.n ?? 0);
  const toApprove = p.ready + p.unconfirmed;
  const emailIncomplete = c.managed === 1 && !nexus && (c.steps.length === 0 || campaignStepProblems(c.steps).length > 0);

  // Three boxes, each opening where its number can be acted on.
  const boxes = [
    {
      label: "Contacts", value: p.contacts, href: `${base}/contacts`,
      sub: !p.contacts ? "none added yet" : p.checking ? `${n(p.checking)} being checked` : p.invalid ? `${n(p.invalid)} invalid, set aside` : p.checked >= p.contacts ? "all checked" : "",
    },
    {
      label: "Emailed", value: Number(people.emailed), href: base,
      sub: Number(people.queued) ? `${n(Number(people.queued))} queued` : stuck > 0 ? `${n(stuck)} held or waiting` : "",
    },
    { label: "Replies", value: p.replies, href: `/clients/${clientId}/replies`, sub: interested ? `${n(interested)} interested` : "" },
  ];

  // One "Next" button for the step after this one, never pointing at the tab you're on. The first that applies wins.
  // The header's own button (not started yet) already says "Approve contacts" or "Add contacts": not said twice.
  const headerStep = c.status === "draft" && c.managed === 1 && !nexus && !c.start_at && !c.archived_at && !waiting && split.approved + p.sending === 0;
  const next: NextItem[] = [
    emailIncomplete && { label: "Next: finish the email", href: `${base}/email`, on: ["/contacts", "/approve", ""] },
    !nexus && p.contacts === 0 && !headerStep && { label: "Next: add contacts", href: `${base}/contacts`, on: ["/email", "/approve", ""] },
    !nexus && toApprove > 0 && !headerStep && { label: `Next: approve ${n(toApprove)}`, href: `${base}/approve`, on: ["/contacts", "/email", ""] },
  ].filter(Boolean) as NextItem[];

  return (
    <div className="flex flex-col gap-5">
      {/* Pinned while scrolling so the tabs and main action are always in reach. On a phone only the tabs are pinned
          (below the top bar): the whole header would take a quarter of the screen. */}
      <div className="flex flex-col gap-3 max-md:contents md:sticky md:top-0 md:z-20 md:-mt-2 md:bg-paper md:pt-2">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/clients/${clientId}/campaigns`} className="text-sm text-muted hover:underline">Campaigns</Link>
            <span className="text-muted">/</span>
            <h2 className="text-xl font-semibold">{c.name}</h2>
            <StatusPill status={c.archived_at ? "archived" : waiting ? "waiting" : c.start_at && c.status === "draft" ? "scheduled" : c.status} />
            {!c.managed && <span className="text-xs text-muted">set up outside the console, so its email is managed there</span>}
            {nexus && <span className="text-xs text-muted">run from Nexus</span>}
          </div>
          {sendLine?.line && <p className={`text-sm ${sendLine.line.tone}`}>{sendLine.line.text}</p>}
        </div>
        {c.archived_at ? (
          <form action={restore.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Restoring…">Restore</SubmitButton></form>
        ) : waiting ? null : c.instantly_campaign_id && (c.status === "active" ? (
          <PauseButton unsent={unsent} keep={pauseCampaign.bind(null, c.id)} release={pauseAndRelease.bind(null, c.id)} />
        ) : c.status === "draft" && c.start_at ? null : c.status === "draft" && c.managed === 1 && !nexus ? (
          <div className="flex items-start gap-2">
            <ScheduleButton c={c} />
            <NextStep href={base} id={c.id} contacts={p.contacts} ready={split.approved + p.sending} toApprove={p.ready + p.unconfirmed} />
          </div>
        ) : c.status === "paused" || c.status === "draft" ? (
          <form action={resumeCampaign.bind(null, c.id)}><SubmitButton className="btn-go" pendingLabel="Starting… a big list takes a few minutes">{c.status === "draft" ? "Start sending" : "Resume sending"}</SubmitButton></form>
        ) : null)}
      </header>
      <div className="sticky top-12 z-20 bg-paper md:static md:z-auto md:bg-transparent">
      <Tabs
        base={base}
        right={<TabNext base={base} items={next} />}
        tabs={
          nexus
            ? [
                { href: "/contacts", label: "Contacts" },
                { href: "", label: "Sending" },
              ]
            : [
                { href: "/contacts", label: "Contacts" },
                { href: "/email", label: c.managed ? "Email" : "Settings", note: c.managed ? (emailIncomplete ? "to finish" : "✓") : undefined },
                { href: "/approve", label: "Approvals", count: toApprove },
                { href: "", label: "Sending" },
              ]
        }
      />
      </div>
      </div>

      {nexus && <p className="card p-3 text-sm text-muted">{NEXUS_NOTICE}</p>}
      {sendLine?.notice && (
        <div
          className={`card flex flex-wrap items-center justify-between gap-3 p-3 text-sm ${
            sendLine.notice.tone === "bad" ? "border-bad/40 bg-bad-soft/40" : sendLine.notice.tone === "wait" ? "border-wait/40 bg-wait-soft/40" : "border-info/30 bg-info-soft/40"
          }`}
        >
          <span>{sendLine.notice.text}</span>
          {sendLine.notice.mailboxes && <Link href={`/clients/${clientId}/mailboxes`} className="text-xs underline">Mailboxes</Link>}
          {sendLine.notice.email && <Link href={`${base}/email`} className="text-xs underline">Email tab</Link>}
          {!sendLine.notice.mailboxes && !sendLine.notice.email && sendLine.notice.tone === "info" && (
            <Link href={`${base}/contacts`} className="text-xs underline">Add contacts</Link>
          )}
        </div>
      )}
      {waiting && (
        <div className="card flex flex-wrap items-center justify-between gap-3 border-wait/40 bg-wait-soft/40 p-4 text-sm">
          <div className="max-w-2xl">
            <div className="font-medium">Waiting for a mailbox</div>
            <p className="text-muted">
              {restingBoxes.length
                ? `${restingBoxes.map((m) => `${m.email} is ${m.note}`).join("; ")}, and this campaign sends from nothing else.`
                : "Every mailbox this campaign sends from is resting."}{" "}
              Nothing goes out meanwhile. It starts by itself when a mailbox is back, or as soon as you tick another one on the{" "}
              <Link href={`${base}/email`} className="underline">Email tab</Link>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <form action={dontWait.bind(null, c.id)}><SubmitButton className="btn-quiet" pendingLabel="Stopping…">Don&apos;t start it</SubmitButton></form>
            <form action={sendAnyway.bind(null, c.id)}>
              <ConfirmButton
                className="btn"
                message={`Send from ${restingBoxes.map((m) => m.email).join(", ") || "the resting mailboxes"} now, without waiting? ${restingBoxes[0]?.reason ? `${restingBoxes[0].reason} ` : ""}Emails sent from a resting mailbox are more likely to land in spam.`}
              >
                Send anyway
              </ConfirmButton>
            </form>
          </div>
        </div>
      )}
      {c.status === "draft" && !waiting && <ScheduleBanner c={c} approved={split.approved} needApproving={p.ready + p.unconfirmed} handedOver={p.sending} />}

      <AutoRefresh active={p.preparing + p.checking + p.updatingPortal > 0} />
      <Working
        items={[
          p.preparing > 0 && `Preparing ${n(p.preparing)} emails`,
          p.checking > 0 && `Checking ${n(p.checking)} addresses`,
          p.updatingPortal > 0 && `Updating ${n(p.updatingPortal)} contacts in the ${PORTAL}`,
        ]}
      />

      <div className="grid grid-cols-3 gap-3">
        {boxes.map((k) => (
          <Link key={k.label} href={k.href} className="card min-w-0 p-3 transition-colors hover:border-ink">
            <div className="text-xs text-muted">{k.label}</div>
            <div className="num text-xl font-semibold">{n(k.value)}</div>
            <div className="truncate text-xs text-muted">{k.sub || " "}</div>
          </Link>
        ))}
      </div>

      <div>{children}</div>
    </div>
  );
}
