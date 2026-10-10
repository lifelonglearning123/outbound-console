"use server";

import { clientOfCampaign, clientOfDraft, clientOfLead, requireAdmin, requireClientAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { all, get, run, tx, logActivity } from "@/lib/db";
import { requireClient } from "@/lib/clients";
import { requireCampaign } from "@/lib/campaigns";
import { importLeads, type LeadFields, type ImportResult } from "@/lib/leads";
import { contactsWithTag, listTags } from "@/lib/ghl";
import { runWriter, rewriteStep } from "@/lib/writer";
import { pushApproved } from "@/lib/push";
import { linkPendingLeads } from "@/lib/ghlsync";
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
  if (r.added || r.updated) {
    await logActivity(clientId, "verify", `Checking ${lead.email}'s address for "${c.name}"`);
    after(runVerifier);
  }
  revalidatePath("/", "layout");
  return r;
}

export async function importCsvLeads(clientId: number, campaignId: number, fileName: string, leads: LeadFields[]): Promise<ImportResult> {
  await requireClientAccess(clientId);
  if ((await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  await requireCampaign(campaignId);
  const r = await importLeads(clientId, campaignId, "csv", fileName, leads);
  after(async () => linkPendingLeads(await requireClient(clientId))); // Nexus Portal is the source of truth: add the contacts there
  if (r.added || r.updated) after(runVerifier); // every new contact is checked before anything else
  revalidatePath("/", "layout");
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

export async function importGhlLeads(clientId: number, campaignId: number, tag: string): Promise<ImportResult & { error?: string }> {
  await requireClientAccess(clientId);
  if ((await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  const c = await requireClient(clientId);
  await requireCampaign(campaignId);
  if (!c.ghl_location_id || !c.ghl_token) return { added: 0, updated: 0, skippedInvalid: 0, skippedExisting: 0, error: "Nexus Portal not set up" };
  try {
    const contacts = await contactsWithTag({ locationId: c.ghl_location_id, token: c.ghl_token }, tag);
    const leads: LeadFields[] = contacts.map((ct) => ({
      email: ct.email ?? "",
      first_name: ct.firstNameRaw ?? ct.firstName ?? null,
      last_name: ct.lastNameRaw ?? ct.lastName ?? null,
      company: ct.companyName ?? null,
      phone: ct.phone ?? null,
      website: ct.website ?? null,
      ghl_contact_id: ct.id,
      fields: Object.fromEntries(
        Object.entries(ct).filter(
          ([k, v]) => typeof v === "string" && v && ["city", "state", "country", "source", "address1"].includes(k),
        ) as [string, string][],
      ),
    }));
    const r = await importLeads(clientId, campaignId, "ghl", `tag: ${tag}`, leads);
    if (r.added || r.updated) after(runVerifier); // every new contact is checked before anything else
    revalidatePath("/", "layout");
    return r;
  } catch (e) {
    return { added: 0, updated: 0, skippedInvalid: 0, skippedExisting: 0, error: (e as Error).message };
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
  await run(`DELETE FROM leads WHERE stage NOT IN ('pushed') AND id IN (${ids.map(() => "?").join(",")})`, ...ids);
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

/** Form-action version of pushCampaign for the campaign's Approve tab. */
export async function sendApproved(campaignId: number) {
  await pushCampaign(campaignId);
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
  let pushed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const r of rows) {
    try {
      const res = await pushApproved(r.campaign_id);
      pushed += res.pushed;
      skipped += res.skipped;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  after(runWriter); // leads missing newly released steps were sent back to the writer
  revalidatePath("/", "layout");
  return { pushed, skipped, errors };
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
