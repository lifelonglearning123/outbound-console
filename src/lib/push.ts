import "server-only";
import { all, get, run, tx, logActivity } from "./db";
import { requireClient } from "./clients";
import { requireCampaign, subjectVar, bodyVar, liveSteps } from "./campaigns";
import { instantly, type LeadInput } from "./instantly";
import { DO_NOT_CONTACT, IN_SEQUENCE, type LeadRow } from "./leads";
import { BEHIND_HELD, detectMailDomains, GATEWAY_LABEL } from "./mailhost";

import { stripCodeFence, toHtml } from "./merge";
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

  const holding = campaign.hold_gateways;
  if (holding.length) {
    // Know each company's mail server before deciding; contacts behind a held filter stay approved but aren't sent.
    await detectMailDomains();
    const held = await run(
      `UPDATE leads l SET stage_message = ? WHERE l.campaign_id = ? AND l.stage = 'approved' AND ${BEHIND_HELD("l")}`,
      "Held back: this campaign isn't sending to their company's email filter (see Mail filters on the Contacts page). Sent when that filter is resumed.",
      campaignId, holding,
    );
    if (held.changes) {
      await logActivity(client.id, "push", `Held back ${held.changes} contacts behind ${holding.map((g) => GATEWAY_LABEL[g]).join(", ")} in "${campaign.name}"`);
    }
  }
  const leads = await all<LeadRow>(
    `SELECT * FROM leads l WHERE campaign_id = ? AND stage = 'approved' ${holding.length ? `AND NOT ${BEHIND_HELD("l")}` : ""}
     ORDER BY id LIMIT 1000`,
    ...(holding.length ? [campaignId, holding] : [campaignId]),
  );
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
    // The same contact in other campaigns: never after a reply, bounce or unsubscribe, and never two sequences at once.
    const other = await get<{ name: string; dnc: boolean }>(
      `SELECT c.name, ${DO_NOT_CONTACT("o")} dnc FROM leads o JOIN campaigns c ON c.id = o.campaign_id
       WHERE o.client_id = ? AND o.email = ? AND o.id <> ? AND (${DO_NOT_CONTACT("o")} OR ${IN_SEQUENCE("o")})
       ORDER BY 2 DESC LIMIT 1`,
      lead.client_id, lead.email, lead.id,
    );
    if (other?.dnc) {
      await tx(async () => {
        await run("UPDATE leads SET stage = 'rejected', stage_message = ? WHERE id = ?", `Not sent: replied, bounced or unsubscribed in "${other.name}"`, lead.id);
        await run("UPDATE drafts SET status = 'rejected', reviewed_at = datetime('now') WHERE lead_id = ? AND status IN ('pending', 'approved')", lead.id);
      });
      continue;
    }
    if (other) {
      // Stays approved; the next send picks it up once the other sequence is over.
      await run("UPDATE leads SET stage_message = ? WHERE id = ?", `Waiting: still being emailed by "${other.name}". Sent once that sequence ends.`, lead.id);
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

/** SQL with one `?` (a text[] of gateways): leads already in Instantly, behind one of them, not emailed yet (as far as the last sync knows). */
const HELD_NOT_YET_EMAILED = `l.stage = 'pushed' AND l.instantly_lead_id IS NOT NULL AND l.last_sent_at IS NULL
  AND COALESCE(l.instantly_status, 1) = 1 AND ${BEHIND_HELD("l")}`;

/** How many of a campaign's loaded-but-unemailed leads sit behind its held filters (0 when nothing is held). */
export async function heldNotYetEmailed(campaignId: number): Promise<number> {
  const campaign = await requireCampaign(campaignId);
  if (campaign.hold_gateways.length === 0) return 0;
  return (await all<{ n: number }>(
    `SELECT COUNT(*) n FROM leads l WHERE l.campaign_id = ? AND ${HELD_NOT_YET_EMAILED}`,
    campaignId, campaign.hold_gateways,
  ))[0]?.n ?? 0;
}

/**
 * Take contacts behind the campaign's held filters back out of Instantly before it emails them: each is checked with
 * Instantly first (anyone it has already emailed stays), removed there, and goes back to approved and held.
 */
export async function pullBackHeld(campaignId: number): Promise<{ pulled: number; alreadyEmailed: number }> {
  const campaign = await requireCampaign(campaignId);
  const client = await requireClient(campaign.client_id);
  if (campaign.hold_gateways.length === 0) return { pulled: 0, alreadyEmailed: 0 };
  const api = instantly(client.instantly_api_key!);
  const leads = await all<{ id: number; instantly_lead_id: string }>(
    `SELECT l.id, l.instantly_lead_id FROM leads l WHERE l.campaign_id = ? AND ${HELD_NOT_YET_EMAILED} ORDER BY l.id`,
    campaignId, campaign.hold_gateways,
  );
  let pulled = 0;
  let alreadyEmailed = 0;
  for (let i = 0; i < leads.length; i += 5) {
    await Promise.all(leads.slice(i, i + 5).map(async (l) => {
      const live = await api.getLead(l.instantly_lead_id);
      if (live.timestamp_last_contact || live.status !== 1) {
        alreadyEmailed++;
        return;
      }
      await api.deleteLead(l.instantly_lead_id);
      await run(
        `UPDATE leads SET stage = 'approved', pushed_at = NULL, instantly_lead_id = NULL, instantly_status = NULL, stage_message = ?
         WHERE id = ? AND stage = 'pushed'`,
        "Held back: this campaign isn't sending to their company's email filter (see Mail filters on the Contacts page). Taken back out of Instantly before it was sent.",
        l.id,
      );
      pulled++;
    }));
  }
  await logActivity(
    client.id,
    "push",
    `Took ${pulled} contacts behind ${campaign.hold_gateways.map((g) => GATEWAY_LABEL[g]).join(", ")} back out of "${campaign.name}" before they were emailed` +
      (alreadyEmailed ? ` (${alreadyEmailed} had already been emailed, so they stay)` : ""),
  );
  return { pulled, alreadyEmailed };
}

/**
 * Instantly turns every newline in a body into <br>. In designed HTML the newlines are only layout
 * whitespace (a space when rendered), but as <br>s between table rows browsers hoist them above the
 * table, leaving a big empty band at the top. Newlines become spaces, so the email looks exactly as designed.
 */
export const flattenHtml = (html: string) => stripCodeFence(html).replace(/<!doctype[^>]*>/gi, "").replace(/\s*\r?\n\s*/g, " ").trim();

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

