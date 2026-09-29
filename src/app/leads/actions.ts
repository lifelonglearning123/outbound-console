"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { all, get, run, tx, logActivity } from "@/lib/db";
import { requireClient } from "@/lib/clients";
import { requireCampaign } from "@/lib/campaigns";
import { importLeads, type LeadFields, type ImportResult } from "@/lib/leads";
import { contactsWithTag, listTags } from "@/lib/ghl";
import { runWriter, rewriteStep } from "@/lib/writer";
import { pushApproved } from "@/lib/push";

export async function importCsvLeads(clientId: number, campaignId: number, fileName: string, leads: LeadFields[]): Promise<ImportResult> {
  requireCampaign(campaignId);
  const r = importLeads(clientId, campaignId, "csv", fileName, leads);
  revalidatePath("/", "layout");
  return r;
}

export async function ghlTags(clientId: number): Promise<{ tags: string[]; error?: string }> {
  const c = requireClient(clientId);
  if (!c.ghl_location_id || !c.ghl_token) return { tags: [], error: "Add GHL location ID and token in Settings first." };
  try {
    return { tags: await listTags({ locationId: c.ghl_location_id, token: c.ghl_token }) };
  } catch (e) {
    return { tags: [], error: (e as Error).message };
  }
}

export async function importGhlLeads(clientId: number, campaignId: number, tag: string): Promise<ImportResult & { error?: string }> {
  const c = requireClient(clientId);
  requireCampaign(campaignId);
  if (!c.ghl_location_id || !c.ghl_token) return { added: 0, updated: 0, skippedInvalid: 0, skippedExisting: 0, error: "GHL not set up" };
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
    const r = importLeads(clientId, campaignId, "ghl", `tag: ${tag}`, leads);
    revalidatePath("/", "layout");
    return r;
  } catch (e) {
    return { added: 0, updated: 0, skippedInvalid: 0, skippedExisting: 0, error: (e as Error).message };
  }
}

/** Queue AI writing for all 'new' (and optionally 'error') leads in a campaign. Runs after the response. */
export async function writeEmails(campaignId: number, includeErrors = false) {
  const c = requireCampaign(campaignId);
  const n = run(
    `UPDATE leads SET stage = 'drafting', stage_message = NULL WHERE campaign_id = ? AND (stage = 'new' ${includeErrors ? "OR (stage = 'error' AND pushed_at IS NULL AND instantly_lead_id IS NULL)" : ""})`,
    campaignId,
  ).changes;
  logActivity(c.client_id, "write", `Writing emails for ${n} leads in "${c.name}"`);
  after(runWriter);
  revalidatePath("/", "layout");
}

export async function removeLeads(ids: number[]) {
  if (!ids.length) return;
  run(`DELETE FROM leads WHERE stage NOT IN ('pushed') AND id IN (${ids.map(() => "?").join(",")})`, ...ids);
  revalidatePath("/", "layout");
}

// ---------- Approval ----------

function refreshLeadStage(leadId: number) {
  const s = get<{ total: number; approved: number; rejected: number }>(
    "SELECT COUNT(*) total, SUM(status = 'approved') approved, SUM(status = 'rejected') rejected FROM drafts WHERE lead_id = ?",
    leadId,
  )!;
  const stage = s.rejected > 0 ? "rejected" : s.total > 0 && s.approved === s.total ? "approved" : "review";
  run("UPDATE leads SET stage = ? WHERE id = ? AND stage IN ('review','approved','rejected')", stage, leadId);
}

export async function saveDraft(draftId: number, subject: string, body: string) {
  const d = get<{ lead_id: number; subject: string; body: string }>("SELECT lead_id, subject, body FROM drafts WHERE id = ?", draftId);
  if (!d) throw new Error("Draft not found");
  const edited = d.subject !== subject || d.body !== body ? 1 : 0;
  run("UPDATE drafts SET subject = ?, body = ?, edited = MAX(edited, ?) WHERE id = ?", subject, body, edited, draftId);
}

/** Approve every step of a lead (after saving any edits the reviewer made). */
export async function approveLead(leadId: number, edits: { id: number; subject: string; body: string }[] = []) {
  tx(() => {
    for (const e of edits) {
      const d = get<{ subject: string; body: string }>("SELECT subject, body FROM drafts WHERE id = ? AND lead_id = ?", e.id, leadId);
      if (!d) continue;
      if (d.subject !== e.subject || d.body !== e.body) {
        run("UPDATE drafts SET subject = ?, body = ?, edited = 1 WHERE id = ?", e.subject, e.body, e.id);
      }
    }
    run("UPDATE drafts SET status = 'approved', reviewed_at = datetime('now') WHERE lead_id = ?", leadId);
    refreshLeadStage(leadId);
  });
  revalidatePath("/", "layout");
}

export async function rejectLead(leadId: number) {
  run("UPDATE drafts SET status = 'rejected', reviewed_at = datetime('now') WHERE lead_id = ?", leadId);
  refreshLeadStage(leadId);
  revalidatePath("/", "layout");
}

export async function rewriteDraft(draftId: number, guidance: string) {
  await rewriteStep(draftId, guidance);
  revalidatePath("/", "layout");
}

export async function redraftLead(leadId: number) {
  run("DELETE FROM drafts WHERE lead_id = ?", leadId);
  run("UPDATE leads SET stage = 'drafting' WHERE id = ?", leadId);
  after(runWriter);
  revalidatePath("/", "layout");
}

export async function pushCampaign(campaignId: number) {
  const r = await pushApproved(campaignId);
  revalidatePath("/", "layout");
  return r;
}

/** Push approved leads for every campaign that has some. Used by the approvals page button. */
export async function pushAllApproved(clientId: number | null) {
  const rows = all<{ campaign_id: number }>(
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
  revalidatePath("/", "layout");
  return { pushed, skipped, errors };
}
