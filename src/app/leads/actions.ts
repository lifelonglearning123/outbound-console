"use server";

import { clientOfCampaign, clientOfDraft, clientOfLead, requireAdmin, requireClientAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { all, get, run, tx, logActivity } from "@/lib/db";
import { requireClient } from "@/lib/clients";
import { requireCampaign } from "@/lib/campaigns";
import { importLeads, logImport, type LeadFields, type ImportResult } from "@/lib/leads";
import { addImports } from "@/lib/importResult";
import { contactsWithTagPage, listTags } from "@/lib/ghl";
import { runWriter, rewriteStep } from "@/lib/writer";
import { pushApproved, pullBackHeld } from "@/lib/push";
import { NO_PUSH, addPushes } from "@/lib/pushResult";
import { describeFilters, readFilters, removableIds } from "@/lib/people";
import { detectMailDomains, GATEWAY_LABEL, type Gateway } from "@/lib/mailhost";
import { jobTitleField, linkPendingLeads, portalLead } from "@/lib/ghlsync";
import { queueVerification, runVerifier, PASSED } from "@/lib/verify";
import { queueTagging, queueDeletion, runVerificationActions, writeVerificationSummary, GHL_TAGS, OUTCOME_LABEL, PORTAL, type Outcome } from "@/lib/verifyReport";
import { approveAndSend, type BatchGroup } from "@/lib/progress";

/** Add one lead typed in by hand, optionally sending it straight to the AI writer. */
export async function addManualLead(
  clientId: number,
  campaignId: number,
  lead: LeadFields,
  writeNow: boolean,
): Promise<ImportResult & { error?: string }> {
  await requireClientAccess(clientId);
  if ((await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  const c = await requireCampaign(campaignId);
  const r = await importLeads(clientId, campaignId, "manual", "typed in", [lead]);
  after(async () => linkPendingLeads(await requireClient(clientId))); // Nexus Portal is the source of truth: add the contact there
  // The address check runs first; a contact that passes has its email prepared by the checker (writeNow is implied).
  void writeNow;
  if (r.reused) {
    after(runWriter); // checked in an earlier campaign: prepare the email now
  } else if (r.added || r.updated) {
    await logActivity(clientId, "verify", `Checking ${lead.email}'s address for "${c.name}"`);
    after(runVerifier);
  }
  revalidatePath("/", "layout");
  return r;
}

/**
 * Add one chunk of a CSV or Nexus Portal import. The importer sends a large import in chunks so it can show progress;
 * `totals` (the whole import's result) comes with the last chunk and is what the activity log records.
 */
export async function importLeadChunk(
  clientId: number,
  campaignId: number,
  source: "csv" | "ghl",
  sourceRef: string,
  leads: LeadFields[],
  totals: ImportResult | null = null,
): Promise<ImportResult> {
  await requireClientAccess(clientId);
  if ((await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  await requireCampaign(campaignId);
  const r = await importLeads(clientId, campaignId, source, sourceRef, leads, false);
  if (totals) {
    await logImport(clientId, source, sourceRef, addImports(totals, r));
    if (source === "csv") after(async () => linkPendingLeads(await requireClient(clientId))); // Nexus Portal is the source of truth: add the contacts there
  }
  if (r.added) after(detectMailDomains); // who handles each new company's email (Mimecast and the like)
  if (r.added + r.updated > r.reused) after(runVerifier); // every new contact is checked before anything else
  if (r.reused) after(runWriter); // already checked in the portal: prepare their emails now
  if (totals) revalidatePath("/", "layout");
  return r;
}

export async function ghlTags(clientId: number): Promise<{ tags: string[]; error?: string }> {
  await requireClientAccess(clientId);
  const c = await requireClient(clientId);
  if (!c.ghl_location_id || !c.ghl_token) return { tags: [], error: "Add Nexus Portal location ID and token in Settings first." };
  try {
    return { tags: await listTags({ locationId: c.ghl_location_id, token: c.ghl_token }) };
  } catch (e) {
    return { tags: [], error: (e as Error).message };
  }
}

/** One page of the Nexus Portal contacts carrying `tag`, as leads, with the total so the importer can show progress. */
export async function ghlContactsPage(clientId: number, tag: string, page: number): Promise<{ leads: LeadFields[]; total: number; error?: string }> {
  await requireClientAccess(clientId);
  const c = await requireClient(clientId);
  if (!c.ghl_location_id || !c.ghl_token) return { leads: [], total: 0, error: "Nexus Portal not set up" };
  try {
    const { contacts, total } = await contactsWithTagPage({ locationId: c.ghl_location_id, token: c.ghl_token }, tag, page);
    const titleField = await jobTitleField(c);
    return { leads: contacts.map((ct) => portalLead(ct, titleField)), total };
  } catch (e) {
    return { leads: [], total: 0, error: (e as Error).message };
  }
}

/** Check every unchecked, not-yet-pushed lead of a campaign against Instantly's email verification. Runs after the response. */
export async function verifyLeads(campaignId: number) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  const c = await requireCampaign(campaignId);
  const n = await queueVerification(campaignId);
  if (n) {
    await logActivity(c.client_id, "verify", `Checking ${n} email addresses in "${c.name}"`);
    after(runVerifier);
  }
  revalidatePath("/", "layout");
}

/** Tag every contact in one verification group in the Nexus Portal. Runs after the response. */
export async function tagVerificationGroup(clientId: number, outcome: Outcome, campaignId: number | null = null) {
  await requireClientAccess(clientId);
  if (campaignId && (await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  const n = await queueTagging(clientId, outcome, campaignId);
  if (n) {
    await logActivity(clientId, "verify", `Tagging ${n} contacts "${GHL_TAGS[outcome]}" in the ${PORTAL}`);
    after(runVerificationActions);
  }
  revalidatePath("/", "layout");
}

/** Delete every unable-to-verify or invalid contact from the Nexus Portal (not ones already in Instantly). Runs after the response. */
export async function deleteVerificationGroup(clientId: number, outcome: "invalid" | "catch_all", campaignId: number | null = null) {
  await requireClientAccess(clientId);
  if (campaignId && (await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  const n = await queueDeletion(clientId, outcome, campaignId);
  if (n) {
    await logActivity(clientId, "verify", `Deleting ${n} ${OUTCOME_LABEL[outcome].toLowerCase()} contacts from the ${PORTAL}`);
    after(runVerificationActions);
  }
  revalidatePath("/", "layout");
}

export async function summariseVerification(clientId: number, campaignId: number | null = null) {
  await requireClientAccess(clientId);
  if (campaignId && (await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  await writeVerificationSummary(clientId, campaignId);
  revalidatePath("/", "layout");
}

/** One-click approval for a fixed-email campaign: approve a whole group of waiting contacts and start sending to them. */
export async function approveGroupAndSend(campaignId: number, group: BatchGroup, form: FormData) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  const limit = Number(form.get("limit")) || null;
  await approveAndSend(campaignId, group, limit);
  after(runWriter); // leads missing newly released steps were sent back to the writer
  revalidatePath("/", "layout");
}

/** Queue AI writing for all 'new' (and optionally 'error') leads in a campaign. Runs after the response. */
export async function writeEmails(campaignId: number, includeErrors = false) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  const c = await requireCampaign(campaignId);
  const n = (await run(
    `UPDATE leads SET stage = 'drafting', stage_message = NULL WHERE campaign_id = ? AND ${PASSED}
       AND (stage = 'new' ${includeErrors ? "OR (stage = 'error' AND pushed_at IS NULL AND instantly_lead_id IS NULL)" : ""})`,
    campaignId,
  )).changes;
  await logActivity(c.client_id, "write", `Preparing emails for ${n} contacts in "${c.name}"`);
  after(runWriter);
  revalidatePath("/", "layout");
}

export async function removeLeads(ids: number[]) {
  for (const id of ids) await requireClientAccess(await clientOfLead(id));
  if (!ids.length) return;
  // Marked, not deleted, so the record that they were in this campaign is kept.
  await run(
    `UPDATE leads SET stage = 'removed', stage_message = 'Removed by hand' WHERE stage <> 'pushed' AND id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  revalidatePath("/", "layout");
}

// ---------- Approval ----------

/** Steps a lead's current decision covers: all of them, or only the post-hold ones for a lead already in Instantly. */
async function decisionScope(leadId: number): Promise<{ extending: boolean; fromStep: number }> {
  const l = await get<{ stage: string; hold_after: number | null }>(
    "SELECT l.stage, c.hold_after FROM leads l JOIN campaigns c ON c.id = l.campaign_id WHERE l.id = ?",
    leadId,
  );
  const extending = !!l?.stage.startsWith("extend_");
  return { extending, fromStep: extending ? (l?.hold_after ?? 0) + 1 : 1 };
}

async function refreshLeadStage(leadId: number) {
  const { extending, fromStep } = await decisionScope(leadId);
  const s = (await get<{ total: number; approved: number; rejected: number }>(
    "SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status = 'approved') approved, COUNT(*) FILTER (WHERE status = 'rejected') rejected FROM drafts WHERE lead_id = ? AND step >= ?",
    leadId, fromStep,
  ))!;
  const decided = s.rejected > 0 ? "rejected" : s.total > 0 && s.approved === s.total ? "approved" : "review";
  if (extending) {
    await run("UPDATE leads SET stage = ? WHERE id = ? AND stage LIKE 'extend_%'", `extend_${decided}`, leadId);
  } else {
    await run("UPDATE leads SET stage = ? WHERE id = ? AND stage IN ('review','approved','rejected')", decided, leadId);
  }
}

export async function saveDraft(draftId: number, subject: string, body: string) {
  await requireClientAccess(await clientOfDraft(draftId));
  const d = await get<{ lead_id: number; subject: string; body: string }>("SELECT lead_id, subject, body FROM drafts WHERE id = ?", draftId);
  if (!d) throw new Error("Draft not found");
  const edited = d.subject !== subject || d.body !== body ? 1 : 0;
  await run("UPDATE drafts SET subject = ?, body = ?, edited = MAX(edited, ?) WHERE id = ?", subject, body, edited, draftId);
}

/** Approve every step of a lead (after saving any edits the reviewer made). */
export async function approveLead(leadId: number, edits: { id: number; subject: string; body: string }[] = []) {
  await requireClientAccess(await clientOfLead(leadId));
  if (!(await get(`SELECT 1 FROM leads WHERE id = ? AND ${PASSED}`, leadId))) throw new Error("This contact's address hasn't been checked yet, so it can't be approved.");
  await tx(async () => {
    for (const e of edits) {
      const d = await get<{ subject: string; body: string }>("SELECT subject, body FROM drafts WHERE id = ? AND lead_id = ?", e.id, leadId);
      if (!d) continue;
      if (d.subject !== e.subject || d.body !== e.body) {
        await run("UPDATE drafts SET subject = ?, body = ?, edited = 1 WHERE id = ?", e.subject, e.body, e.id);
      }
    }
    await run("UPDATE drafts SET status = 'approved', reviewed_at = datetime('now') WHERE lead_id = ? AND step >= ?", leadId, (await decisionScope(leadId)).fromStep);
    await refreshLeadStage(leadId);
  });
  revalidatePath("/", "layout");
}

export async function rejectLead(leadId: number) {
  await requireClientAccess(await clientOfLead(leadId));
  // For a lead already in Instantly this only rejects its new emails; it's removed from the campaign on release.
  await run("UPDATE drafts SET status = 'rejected', reviewed_at = datetime('now') WHERE lead_id = ? AND step >= ?", leadId, (await decisionScope(leadId)).fromStep);
  await refreshLeadStage(leadId);
  revalidatePath("/", "layout");
}

export async function rewriteDraft(draftId: number, guidance: string) {
  await requireClientAccess(await clientOfDraft(draftId));
  await rewriteStep(draftId, guidance);
  revalidatePath("/", "layout");
}

export async function redraftLead(leadId: number) {
  await requireClientAccess(await clientOfLead(leadId));
  const { extending, fromStep } = await decisionScope(leadId);
  await run("DELETE FROM drafts WHERE lead_id = ? AND step >= ?", leadId, fromStep);
  await run("UPDATE leads SET stage = ? WHERE id = ?", extending ? "extending" : "drafting", leadId);
  after(runWriter);
  revalidatePath("/", "layout");
}

export async function pushCampaign(campaignId: number) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  const r = await pushApproved(campaignId);
  after(runWriter); // leads missing newly released steps were sent back to the writer
  revalidatePath("/", "layout");
  return r;
}

/** Contacts that can still be taken out of a campaign: not handed to the sender, not already removed. */
const REMOVABLE = "pushed_at IS NULL AND instantly_lead_id IS NULL AND stage <> 'removed'";

/** Remove the ticked contacts from a campaign (marked removed, never deleted, so their history stays). */
export async function removeSelected(campaignId: number, form: FormData) {
  const c = await requireCampaign(campaignId);
  await requireClientAccess(c.client_id);
  const ids = form.getAll("ids").map(Number).filter(Number.isInteger);
  if (ids.length === 0) return;
  const n = (await run(
    `UPDATE leads SET stage = 'removed', stage_message = 'Removed from the campaign by hand'
     WHERE campaign_id = ? AND ${REMOVABLE} AND id = ANY(?)`,
    campaignId, ids,
  )).changes;
  if (n) await logActivity(c.client_id, "import", `Removed ${n} contacts from "${c.name}" by hand`);
  revalidatePath("/", "layout");
}

/** Remove every not-yet-sent contact the contacts list's current filters match (e.g. all invalid ones) from a campaign. */
export async function removeMatching(campaignId: number, query: string) {
  const c = await requireCampaign(campaignId);
  await requireClientAccess(c.client_id);
  const filters = readFilters(new URLSearchParams(query));
  if (Object.keys(filters).length === 0) throw new Error("Pick a filter first, so only the contacts you mean are removed.");
  const ids = await removableIds({ clientId: c.client_id, campaignId }, filters);
  if (ids.length === 0) return;
  const which = describeFilters(filters);
  const n = (await run(
    `UPDATE leads SET stage = 'removed', stage_message = ? WHERE campaign_id = ? AND ${REMOVABLE} AND id = ANY(?)`,
    `Removed from the campaign (${which})`, campaignId, ids,
  )).changes;
  if (n) await logActivity(c.client_id, "import", `Removed ${n} contacts from "${c.name}" (${which})`);
  revalidatePath("/", "layout");
}

/** Take contacts behind the campaign's held mail filters back out of Instantly before they're emailed; they stay approved and held. */
export async function takeBackHeld(campaignId: number) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  await pullBackHeld(campaignId);
  revalidatePath("/", "layout");
}

/** Pause or resume sending to one mail filter (Mimecast and the like) for a campaign. */
export async function setGatewayHold(campaignId: number, gateway: Gateway, hold: boolean) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  if (!(gateway in GATEWAY_LABEL)) throw new Error("Unknown mail filter");
  const c = await requireCampaign(campaignId);
  const next = hold ? [...new Set([...c.hold_gateways, gateway])] : c.hold_gateways.filter((g) => g !== gateway);
  await run("UPDATE campaigns SET hold_gateways = ? WHERE id = ?", JSON.stringify(next), campaignId);
  await logActivity(c.client_id, "push", `${hold ? "Paused" : "Resumed"} sending to contacts behind ${GATEWAY_LABEL[gateway]} in "${c.name}"`);
  if (!hold && c.instantly_campaign_id) {
    // Resumed: held contacts are still 'approved', so hand them to the sender after the response.
    after(() => pushApproved(campaignId));
  }
  revalidatePath("/", "layout");
}

/** Push approved leads for every campaign that has some. Used by the approvals page button. */
export async function pushAllApproved(clientId: number | null) {
  if (clientId) await requireClientAccess(clientId);
  else await requireAdmin();
  const rows = await all<{ campaign_id: number }>(
    `SELECT DISTINCT l.campaign_id FROM leads l JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.stage = 'approved' AND c.instantly_campaign_id IS NOT NULL ${clientId ? "AND l.client_id = ?" : ""}`,
    ...(clientId ? [clientId] : []),
  );
  let total = NO_PUSH;
  const errors: string[] = [];
  for (const r of rows) {
    try {
      total = addPushes(total, await pushApproved(r.campaign_id));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  after(runWriter); // leads missing newly released steps were sent back to the writer
  revalidatePath("/", "layout");
  return { ...total, errors };
}

/**
 * Approve every lead waiting for review that has no reviewer flags (e.g. no missing merge fields).
 * Meant for campaigns sending your own email, where every lead gets the same text.
 */
export async function approveAllUnflagged(clientId: number | null, campaignId: number | null = null): Promise<number> {
  if (clientId) await requireClientAccess(clientId);
  else await requireAdmin();
  if (campaignId && clientId && (await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  const ids = (await all<{ id: number }>(
    `SELECT l.id FROM leads l JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.stage IN ('review', 'extend_review') ${clientId ? "AND l.client_id = ?" : ""} ${campaignId ? "AND l.campaign_id = ?" : ""}
       AND l.${PASSED}
       AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.lead_id = l.id AND d.flags IS NOT NULL
                       AND (l.stage = 'review' OR d.step > COALESCE(c.hold_after, 0)))`,
    ...(clientId ? [clientId] : []), ...(campaignId ? [campaignId] : []),
  )).map((r) => r.id);
  await tx(async () => {
    for (const id of ids) {
      await run("UPDATE drafts SET status = 'approved', reviewed_at = datetime('now') WHERE lead_id = ? AND step >= ?", id, (await decisionScope(id)).fromStep);
      await refreshLeadStage(id);
    }
  });
  if (ids.length) await logActivity(clientId, "approve", `Approved ${ids.length} contacts in one go (none had notes)`);
  revalidatePath("/", "layout");
  return ids.length;
}
