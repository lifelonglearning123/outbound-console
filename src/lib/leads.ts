import "server-only";
import { run, get, tx, logActivity } from "./db";

export type LeadFields = {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  website?: string | null;
  fields?: Record<string, string>;
  ghl_contact_id?: string | null;
};

export type LeadRow = {
  id: number;
  client_id: number;
  campaign_id: number | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  website: string | null;
  fields: string;
  source: string;
  source_ref: string | null;
  ghl_contact_id: string | null;
  stage: string;
  stage_message: string | null;
  instantly_lead_id: string | null;
  instantly_status: number | null;
  interest_status: number | null;
  pushed_at: string | null;
  verification: string | null; // see schema.ts
  verified_at: string | null;
  ghl_verification_tag: string | null;
  created_at: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ImportResult = { added: number; updated: number; skippedInvalid: number; skippedExisting: number };

/**
 * Insert leads for a client and attach them to a campaign. A lead already in the client
 * (same email) is left alone if it has moved past 'new'; otherwise its fields are refreshed.
 * Every new lead starts queued for an address check (verify.ts); nothing is prepared or approved before the result.
 */
export async function importLeads(
  clientId: number,
  campaignId: number,
  source: "csv" | "ghl" | "manual",
  sourceRef: string,
  leads: LeadFields[],
): Promise<ImportResult> {
  const r: ImportResult = { added: 0, updated: 0, skippedInvalid: 0, skippedExisting: 0 };
  await tx(async () => {
    for (const l of leads) {
      const email = l.email?.trim().toLowerCase();
      if (!email || !EMAIL_RE.test(email)) {
        r.skippedInvalid++;
        continue;
      }
      const existing = await get<{ id: number; stage: string }>("SELECT id, stage FROM leads WHERE client_id = ? AND email = ?", clientId, email);
      const values = {
        clientId, campaignId, email, source, sourceRef,
        first_name: l.first_name?.trim() || null,
        last_name: l.last_name?.trim() || null,
        company: l.company?.trim() || null,
        title: l.title?.trim() || null,
        phone: l.phone?.trim() || null,
        website: l.website?.trim() || null,
        fields: JSON.stringify(l.fields ?? {}),
        ghl: l.ghl_contact_id ?? null,
      };
      if (!existing) {
        await run(
          `INSERT INTO leads (client_id, campaign_id, email, first_name, last_name, company, title, phone, website, fields,
             source, source_ref, ghl_contact_id, verification)
           VALUES (@clientId, @campaignId, @email, @first_name, @last_name, @company, @title, @phone, @website, @fields,
             @source, @sourceRef, @ghl, 'queued')`,
          values,
        );
        r.added++;
      } else if (existing.stage === "new") {
        await run(
          `UPDATE leads SET campaign_id = @campaignId, first_name = @first_name, last_name = @last_name, company = @company,
             title = @title, phone = @phone, website = @website, fields = @fields, ghl_contact_id = COALESCE(@ghl, ghl_contact_id),
             verification = COALESCE(verification, 'queued')
           WHERE id = @id`,
          { ...values, id: existing.id },
        );
        r.updated++;
      } else {
        r.skippedExisting++;
      }
    }
  });
  await logActivity(
    clientId,
    "import",
    `Imported ${r.added} new leads from ${source.toUpperCase()} (${sourceRef})` +
      (r.skippedExisting ? `, ${r.skippedExisting} already in progress` : "") +
      (r.skippedInvalid ? `, ${r.skippedInvalid} invalid emails` : ""),
  );
  return r;
}
