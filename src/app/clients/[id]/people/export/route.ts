import type { NextRequest } from "next/server";
import { requireClientAccess } from "@/lib/auth";
import { requireClient } from "@/lib/clients";
import { getCampaign } from "@/lib/campaigns";
import { csvResponse, fileSlug } from "@/lib/csv";
import { INTEREST_LABELS } from "@/lib/triage";
import { GATEWAY_LABEL, PROVIDER_LABEL } from "@/lib/mailhost";
import {
  allPeople, breakdown, checkOption, DIMENSIONS, personState, portalTagLabel, readFilters, readSort, seniorityLabel, sourceLabel,
} from "@/lib/people";

const rate = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "");
const when = (v: string | null) => (v ? v.slice(0, 16).replace("T", " ") : "");
const yes = (v: unknown) => (v ? "Yes" : "");

/**
 * The people a list shows, as CSV: /clients/2/people/export?campaign=18&status=replied (any list filters), or a
 * breakdown table with ?by=host. Without a campaign it covers all of the client's campaigns.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/clients/[id]/people/export">) {
  const clientId = Number((await ctx.params).id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const client = await requireClient(clientId);
  const sp = req.nextUrl.searchParams;
  const campaignId = Number(sp.get("campaign")) || null;
  const campaign = campaignId ? await getCampaign(campaignId) : null;
  if (campaignId && campaign?.client_id !== clientId) return new Response("Campaign not found", { status: 404 });
  const scope = { clientId, campaignId };
  const filters = readFilters(sp);
  const name = fileSlug([client.name, campaign?.name].filter(Boolean).join(" "));
  const date = new Date().toISOString().slice(0, 10);

  const by = DIMENSIONS.find((d) => d.key === sp.get("by"));
  if (by) {
    const rows = await breakdown(scope, by.key, filters);
    return csvResponse(
      `${name}-by-${by.key}-${date}.csv`,
      [by.label, "Contacts", "Emailed", "Opened", "Open rate", "Replied", "Reply rate", "Interested", "Interested rate", "Meetings", "Bounced", "Bounce rate", "Unsubscribed"],
      rows.map((r) => [
        r.label, r.contacts, r.emailed, r.opened, rate(r.opened, r.emailed), r.replied, rate(r.replied, r.emailed), r.interested,
        rate(r.interested, r.emailed), r.meetings, r.bounced, rate(r.bounced, r.emailed), r.unsubscribed,
      ]),
    );
  }

  const people = await allPeople(scope, filters, readSort(sp));
  const fields = people.map((p) => {
    try {
      return JSON.parse(p.fields || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const extra = [...new Set(fields.flatMap((f) => Object.keys(f)))].sort();
  return csvResponse(
    `${name}-people-${date}.csv`,
    [
      "Email", "First name", "Last name", "Job title", "Seniority", "Company", "Campaign", "Status", "Reply", "Replied at", "Interested",
      "Meeting booked", "Opened", "Last opened", "Bounced", "Unsubscribed", "Emails sent", "First emailed", "Last emailed", "Sent from",
      "Address check", "Nexus Portal check tag", "Email host", "Mail filter", "Came from", "Added", "Nexus Portal contact ID",
      ...extra.map((k) => k[0].toUpperCase() + k.slice(1)),
    ],
    people.map((p, i) => [
      p.email, p.first_name, p.last_name, p.title, seniorityLabel(p.seniority), p.company, p.campaign, personState(p).label,
      p.reply_tag ? INTEREST_LABELS[p.reply_tag] ?? p.reply_tag : "", when(p.replied_at), yes(p.interested), when(p.meeting_at),
      yes(p.emailed && p.last_open_at), when(p.last_open_at), yes(p.bounced), yes(p.unsubscribed), p.emailed ? p.steps_sent || 1 : 0,
      when(p.first_sent), when(p.last_sent), p.sender, checkOption(p.check_key)?.label ?? p.check_key, portalTagLabel(p.ptag),
      p.provider ? PROVIDER_LABEL[p.provider] : "", p.gateway ? GATEWAY_LABEL[p.gateway] : "", sourceLabel(p.source), when(p.created_at),
      p.ghl_contact_id, ...extra.map((k) => fields[i][k] ?? ""),
    ]),
  );
}
