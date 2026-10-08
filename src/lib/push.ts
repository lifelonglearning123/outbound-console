import "server-only";
import { all, run, tx, logActivity } from "./db";
import { requireClient } from "./clients";
import { requireCampaign, subjectVar, bodyVar, liveSteps } from "./campaigns";
import { instantly, type LeadInput } from "./instantly";
import type { LeadRow } from "./leads";

import { toHtml } from "./merge";
import { ghlCreds, linkLead } from "./ghlsync";

export { toHtml };

/**
 * Upload every approved lead of a campaign to Instantly, with its approved copy in custom variables.
 * Only leads whose every step is approved are in stage 'approved', so nothing unapproved can leave.
 */
export async function pushApproved(campaignId: number): Promise<{ pushed: number; skipped: number }> {
  const campaign = await requireCampaign(campaignId);
  if (!campaign.instantly_campaign_id) throw new Error("Create the campaign in Instantly first");
  const client = await requireClient(campaign.client_id);
  const api = instantly(client.instantly_api_key!);

  const leads = await all<LeadRow>("SELECT * FROM leads WHERE campaign_id = ? AND stage = 'approved' ORDER BY id LIMIT 1000", campaignId);
  if (leads.length === 0) return { pushed: 0, skipped: 0 };

  const drafts = await all<{ lead_id: number; step: number; subject: string; body: string; status: string; format: string }>(
    `SELECT lead_id, step, subject, body, status, format FROM drafts WHERE lead_id IN (${leads.map(() => "?").join(",")}) ORDER BY step`,
    ...leads.map((l) => l.id),
  );

  const ready: { lead: LeadRow; input: LeadInput }[] = [];
  const hasGhl = !!ghlCreds(client);
  for (const lead of leads) {
    // GHL is the source of truth: a lead must exist as a GHL contact before anything is sent to it.
    if (hasGhl && !lead.ghl_contact_id) {
      try {
        lead.ghl_contact_id = await linkLead(client, lead);
      } catch (e) {
        await run("UPDATE leads SET stage_message = ? WHERE id = ?", `Not sent: couldn't add to Nexus Portal (${(e as Error).message})`, lead.id);
        continue;
      }
    }
    const live = liveSteps(campaign);
    const mine = drafts.filter((d) => d.lead_id === lead.id && d.step <= live);
    // A hold was released while this lead waited: write the steps it's missing, then it comes back for review.
    if (mine.length < live) {
      await run("UPDATE leads SET stage = 'drafting' WHERE id = ?", lead.id);
      continue;
    }
    // Belt and braces: re-check approval at the last moment.
    if (mine.some((d) => d.status !== "approved")) {
      await run("UPDATE leads SET stage = 'review' WHERE id = ?", lead.id);
      continue;
    }
    const vars = copyVars(mine);
    ready.push({
      lead,
      input: {
        email: lead.email,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company_name: lead.company,
        job_title: lead.title,
        phone: lead.phone,
        website: lead.website,
        custom_variables: vars,
      },
    });
  }
  if (ready.length === 0) return { pushed: 0, skipped: 0 };

  const res = await api.addLeads(campaign.instantly_campaign_id, ready.map((r) => r.input));
  const created = new Map((res.created_leads ?? []).map((c) => [c.index, c.id]));
  const now = new Date().toISOString();
  let pushed = 0;
  let skipped = 0;
  await tx(async () => {
    for (const [i, r] of ready.entries()) {
      const id = created.get(i);
      if (id) {
        await run("UPDATE leads SET stage = 'pushed', instantly_lead_id = ?, instantly_status = 1, pushed_at = ?, stage_message = NULL WHERE id = ?", id, now, r.lead.id);
        pushed++;
      } else {
        await run(
          "UPDATE leads SET stage = 'error', stage_message = ? WHERE id = ?",
          "Instantly didn't add this lead (already in the campaign, on the blocklist, or invalid email)",
          r.lead.id,
        );
        skipped++;
      }
    }
  });
  await logActivity(
    client.id,
    "push",
    `Sent ${pushed} approved leads to "${campaign.name}"` +
      (skipped ? ` (${skipped} skipped by Instantly: ${res.duplicated_leads} duplicates, ${res.in_blocklist} blocklisted, ${res.invalid_email_count} invalid)` : ""),
  );
  return { pushed, skipped };
}

/**
 * Instantly turns every newline in a body into <br>. In designed HTML the newlines are only layout
 * whitespace (a space when rendered), but as <br>s between table rows browsers hoist them above the
 * table, leaving a big empty band at the top. Newlines become spaces, so the email looks exactly as designed.
 */
export const flattenHtml = (html: string) => html.replace(/\s*\r?\n\s*/g, " ").trim();

type DraftCopy = { step: number; subject: string; body: string; format: string };

/** The custom variables that carry a lead's approved copy into Instantly's placeholder steps. */
export function copyVars(drafts: DraftCopy[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const d of drafts) {
    if (d.step === 1) vars[subjectVar(1)] = d.subject;
    // Designed emails (html) go out as approved; AI plain text keeps its line breaks.
    vars[bodyVar(d.step)] = d.format === "html" ? flattenHtml(d.body) : toHtml(d.body);
  }
  return vars;
}

