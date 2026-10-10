import { requireClientAccess } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getCampaign } from "@/lib/campaigns";
import { campaignProgress } from "@/lib/progress";
import { pauseCampaign, resumeCampaign } from "@/app/campaigns/actions";
import { StatusPill } from "@/components/CampaignTable";
import { Tabs } from "@/components/Tabs";
import { ago } from "@/lib/format";
import { Working } from "@/components/Working";
import { SubmitButton } from "@/components/SubmitButton";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PORTAL } from "@/lib/verifyReport";

const n = (v: number) => v.toLocaleString("en-GB");

/** Every campaign page: name and sending controls, the progress strip, and the four steps as tabs. */
export default async function CampaignLayout({ children, params }: LayoutProps<"/clients/[id]/campaigns/[cid]">) {
  const { id, cid } = await params;
  const clientId = Number(id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const c = await getCampaign(Number(cid));
  if (!c || c.client_id !== clientId) notFound();
  const p = await campaignProgress(c.id);
  const base = `/clients/${clientId}/campaigns/${c.id}`;

  // Each tile opens the place where that number can be acted on.
  const strip = [
    { label: "Contacts", value: p.contacts, sub: p.checking ? `${n(p.checking)} being checked` : p.contacts ? "all checked" : "none added yet", tone: "", href: `${base}/contacts` },
    { label: "Verified", value: p.verified, sub: p.verified ? "tag in the portal →" : "address confirmed", tone: "text-go", href: `${base}/contacts#check-verified` },
    { label: "Unable to verify", value: p.catchAll, sub: p.catchAll ? "tag or delete →" : "catch-all company", tone: "text-wait", href: `${base}/contacts#check-catch_all` },
    { label: "Invalid", value: p.invalid, sub: p.invalid ? "tag or delete →" : "set aside", tone: "text-bad", href: `${base}/contacts#check-invalid` },
    { label: "Ready to send", value: p.ready, sub: p.unconfirmed ? `+ ${n(p.unconfirmed)} unconfirmed` : p.preparing ? `preparing ${n(p.preparing)}` : "", tone: p.ready ? "text-go" : "", href: `${base}/approve` },
    { label: "Sending", value: p.sending, sub: p.sent ? `${n(p.sent)} emails sent` : p.approved - p.sending > 0 ? `${n(p.approved - p.sending)} approved, not handed over` : "", tone: "", href: base },
    { label: "Replies", value: p.replies, sub: "", tone: "", href: `/inbox?client=${clientId}` },
  ];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link href={`/clients/${clientId}/campaigns`} className="text-sm text-muted hover:underline">Campaigns</Link>
            <span className="text-muted">/</span>
            <h2 className="text-xl font-semibold">{c.name}</h2>
            <StatusPill status={c.status} />
            {!c.managed && <span className="text-xs text-muted">set up outside the console, so its email is managed there</span>}
          </div>
          <p className="text-sm text-muted">
            {c.status === "active" && c.not_sending ? <span className="text-wait">{c.not_sending} · </span> : null}
            updated {ago(c.last_synced_at)}
          </p>
        </div>
        {c.instantly_campaign_id && (c.status === "active" ? (
          <form action={pauseCampaign.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Pausing…">Pause sending</SubmitButton></form>
        ) : c.status === "paused" || c.status === "draft" ? (
          <form action={resumeCampaign.bind(null, c.id)}><SubmitButton className="btn-go" pendingLabel="Starting…">{c.status === "draft" ? "Start sending" : "Resume sending"}</SubmitButton></form>
        ) : null)}
      </header>

      <AutoRefresh active={p.preparing + p.checking + p.updatingPortal > 0} />
      <Working
        items={[
          p.preparing > 0 && `Preparing ${n(p.preparing)} emails`,
          p.checking > 0 && `Checking ${n(p.checking)} addresses`,
          p.updatingPortal > 0 && `Updating ${n(p.updatingPortal)} contacts in the ${PORTAL}`,
        ]}
      />

      <div className="grid grid-cols-7 gap-3">
        {strip.map((k) => (
          <Link key={k.label} href={k.href} className="card p-3 transition-colors hover:border-ink">
            <div className="text-xs text-muted">{k.label}</div>
            <div className={`num text-xl font-semibold ${k.tone}`}>{n(k.value)}</div>
            <div className="text-xs text-muted">{k.sub || " "}</div>
          </Link>
        ))}
      </div>

      <Tabs
        base={base}
        tabs={[
          { href: "/contacts", label: "Contacts" },
          { href: "/email", label: c.managed ? "Email" : "Settings" },
          { href: "/approve", label: "Approve", count: p.ready },
          { href: "", label: "Sending" },
        ]}
      />
      <div>{children}</div>
    </div>
  );
}
