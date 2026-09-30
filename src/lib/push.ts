import "server-only";
import { all, run, tx, logActivity } from "./db";
import { requireClient } from "./clients";
import { requireCampaign, subjectVar, bodyVar } from "./campaigns";
import { instantly, type LeadInput } from "./instantly";
import type { LeadRow } from "./leads";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Instantly bodies are HTML; keep the plain-text look with <br/> line breaks. */
export const toHtml = (text: string) => esc(text).replace(/\r?\n/g, "<br/>");

/**
 * Upload every approved lead of a campaign to Instantly, with its approved copy in custom variables.
 * Only leads whose every step is approved are in stage 'approved', so nothing unapproved can leave.
 */
export async function pushApproved(campaignId: number): Promise<{ pushed: number; skipped: number }> {
  const campaign = requireCampaign(campaignId);
  if (!campaign.instantly_campaign_id) throw new Error("Create the campaign in Instantly first");
  const client = requireClient(campaign.client_id);
  const api = instantly(client.instantly_api_key!);

  const leads = all<LeadRow>("SELECT * FROM leads WHERE campaign_id = ? AND stage = 'approved' ORDER BY id LIMIT 1000", campaignId);
  if (leads.length === 0) return { pushed: 0, skipped: 0 };

  const drafts = all<{ lead_id: number; step: number; subject: string; body: string; status: string; format: string }>(
    `SELECT lead_id, step, subject, body, status, format FROM drafts WHERE lead_id IN (${leads.map(() => "?").join(",")}) ORDER BY step`,
    ...leads.map((l) => l.id),
  );

  const ready: { lead: LeadRow; input: LeadInput }[] = [];
  for (const lead of leads) {
    const mine = drafts.filter((d) => d.lead_id === lead.id);
    // Belt and braces: re-check approval at the last moment.
    if (mine.length !== campaign.steps.length || mine.some((d) => d.status !== "approved")) {
      run("UPDATE leads SET stage = 'review' WHERE id = ?", lead.id);
      continue;
    }
    const vars: Record<string, string> = {};
    for (const d of mine) {
      if (d.step === 1) vars[subjectVar(1)] = d.subject;
      // Designed emails (html) go out exactly as approved; AI plain text keeps its line breaks.
      vars[bodyVar(d.step)] = d.format === "html" ? d.body : toHtml(d.body);
    }
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
  tx(() => {
    ready.forEach((r, i) => {
      const id = created.get(i);
      if (id) {
        run("UPDATE leads SET stage = 'pushed', instantly_lead_id = ?, instantly_status = 1, pushed_at = ?, stage_message = NULL WHERE id = ?", id, now, r.lead.id);
        pushed++;
      } else {
        run(
          "UPDATE leads SET stage = 'error', stage_message = ? WHERE id = ?",
          "Instantly didn't add this lead (already in the campaign, on the blocklist, or invalid email)",
          r.lead.id,
        );
        skipped++;
      }
    });
  });
  logActivity(
    client.id,
    "push",
    `Sent ${pushed} approved leads to "${campaign.name}"` +
      (skipped ? ` (${skipped} skipped by Instantly: ${res.duplicated_leads} duplicates, ${res.in_blocklist} blocklisted, ${res.invalid_email_count} invalid)` : ""),
  );
  return { pushed, skipped };
}
