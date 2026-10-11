import "server-only";
import { all, run, get, tx, logActivity } from "./db";
import type { Outcome } from "./checkTags";
import { NO_IMPORT, type ImportResult } from "./importResult";

export type { ImportResult };

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
  /** The check result the contact's Nexus Portal tags already record (see checkTags.ts); used for portal imports only. */
  check?: Outcome | null;
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

type Earlier = {
  id: number;
  campaign_id: number | null;
  stage: string;
  verification: string | null;
  verified_at: string | null;
  ghl_contact_id: string | null;
  ghl_verification_tag: string | null;
  instantly_status: number | null;
  last_reply_at: string | null;
};

/** Replied, bounced, unsubscribed or invalid: never emailed again from any campaign. */
const doNotContact = (e: Earlier) => !!e.last_reply_at || e.instantly_status === -1 || e.instantly_status === -2 || e.verification === "invalid";

/** Still being prepared, waiting for approval, or in a sequence Instantly hasn't finished (completed = 3, skipped = -3). */
const busy = (e: Earlier) =>
  ["drafting", "review", "approved", "extending"].includes(e.stage) ||
  ((e.stage === "pushed" || e.stage.startsWith("extend_")) && e.instantly_status !== 3 && e.instantly_status !== -3);

/**
 * Add leads to a campaign. A contact can be in several of a client's campaigns, once each:
 *   - already in this campaign: its fields are refreshed while it's still 'new', otherwise it's left alone;
 *   - replied, bounced, unsubscribed or invalid anywhere before: skipped;
 *   - still being prepared or emailed in another campaign: skipped for now, so nobody gets two sequences at once;
 *   - sitting unprepared ('new') in another campaign: moved here;
 *   - otherwise a new lead, which keeps the address check from its latest earlier campaign.
 * A lead with no earlier result starts queued for an address check (verify.ts), unless it comes from the portal
 * already tagged with a result. A passed result sends it straight to 'drafting' (the caller runs the writer); an
 * invalid one sets it aside, as the checker would have done.
 */
export async function importLeads(
  clientId: number,
  campaignId: number,
  source: "csv" | "ghl" | "manual",
  sourceRef: string,
  leads: LeadFields[],
  log = true,
): Promise<ImportResult> {
  const r: ImportResult = { ...NO_IMPORT };
  const now = new Date().toISOString();
  await tx(async () => {
    for (const l of leads) {
      const email = l.email?.trim().toLowerCase();
      if (!email || !EMAIL_RE.test(email)) {
        r.skippedInvalid++;
        continue;
      }
      const earlier = await all<Earlier>(
        `SELECT id, campaign_id, stage, verification, verified_at, ghl_contact_id, ghl_verification_tag, instantly_status, last_reply_at
         FROM leads WHERE client_id = ? AND email = ? ORDER BY id DESC`,
        clientId, email,
      );
      let existing: Earlier | undefined = earlier.find((e) => e.campaign_id === campaignId);
      if (existing && existing.stage !== "new") {
        r.skippedExisting++;
        continue;
      }
      const others = earlier.filter((e) => e !== existing);
      if (others.length) {
        const replied = await get("SELECT 1 FROM emails WHERE client_id = ? AND lead_email = ? AND direction = 'in' LIMIT 1", clientId, email);
        if (replied || others.some(doNotContact)) {
          r.skippedDoNotContact++;
          continue;
        }
        if (others.some(busy)) {
          r.skippedBusy++;
          continue;
        }
        existing ??= others.find((e) => e.stage === "new"); // never prepared elsewhere: bring it over
      }
      const prior = others.find((e) => e.verification === "verified" || e.verification === "catch_all");
      const values = {
        clientId, campaignId, email, source, sourceRef,
        first_name: l.first_name?.trim() || null,
        last_name: l.last_name?.trim() || null,
        company: l.company?.trim() || null,
        title: l.title?.trim() || null,
        phone: l.phone?.trim() || null,
        website: l.website?.trim() || null,
        fields: JSON.stringify(l.fields ?? {}),
        ghl: l.ghl_contact_id ?? others.find((e) => e.ghl_contact_id)?.ghl_contact_id ?? null,
      };
      let id: number;
      if (!existing && prior) {
        // Checked in an earlier campaign: keep that result and prepare the email straight away.
        await run(
          `INSERT INTO leads (client_id, campaign_id, email, first_name, last_name, company, title, phone, website, fields,
             source, source_ref, ghl_contact_id, verification, verified_at, ghl_verification_tag, stage)
           VALUES (@clientId, @campaignId, @email, @first_name, @last_name, @company, @title, @phone, @website, @fields,
             @source, @sourceRef, @ghl, @verification, @verified_at, @tag, 'drafting')`,
          {
            ...values, verification: prior.verification, verified_at: prior.verified_at,
            tag: prior.ghl_verification_tag === "done" ? "done" : null,
          },
        );
        r.added++;
        r.reused++;
        continue;
      } else if (!existing) {
        id = (await get<{ id: number }>(
          `INSERT INTO leads (client_id, campaign_id, email, first_name, last_name, company, title, phone, website, fields,
             source, source_ref, ghl_contact_id, verification)
           VALUES (@clientId, @campaignId, @email, @first_name, @last_name, @company, @title, @phone, @website, @fields,
             @source, @sourceRef, @ghl, 'queued')
           RETURNING id`,
          values,
        ))!.id;
        r.added++;
      } else {
        id = existing.id;
        await run(
          `UPDATE leads SET campaign_id = @campaignId, first_name = @first_name, last_name = @last_name, company = @company,
             title = @title, phone = @phone, website = @website, fields = @fields, ghl_contact_id = COALESCE(@ghl, ghl_contact_id),
             verification = COALESCE(verification, 'queued')
           WHERE id = @id`,
          { ...values, id },
        );
        r.updated++;
      }
      if (source === "ghl" && l.check && values.ghl) {
        // Only a contact still waiting for its check; one that's mid-check or already checked keeps its own result.
        r.reused += (await run(
          `UPDATE leads SET verification = @check, verified_at = @now, ghl_verification_tag = 'done',
             stage = CASE WHEN @check = 'invalid' THEN 'rejected' ELSE 'drafting' END,
             stage_message = CASE WHEN @check = 'invalid' THEN 'Invalid email address (already tagged in the Nexus Portal)' ELSE NULL END
           WHERE id = @id AND stage = 'new' AND verification = 'queued'`,
          { id, check: l.check, now },
        )).changes;
      }
    }
  });
  if (log) await logImport(clientId, source, sourceRef, r);
  return r;
}

/** The activity line for one import (an import sent in chunks logs once, with the totals, at the end). */
export async function logImport(clientId: number, source: string, sourceRef: string, r: ImportResult) {
  await logActivity(
    clientId,
    "import",
    `Imported ${r.added} new leads from ${source.toUpperCase()} (${sourceRef})` +
      (r.reused ? `, ${r.reused} already checked before (not checked again)` : "") +
      (r.skippedExisting ? `, ${r.skippedExisting} already in this campaign` : "") +
      (r.skippedBusy ? `, ${r.skippedBusy} still in another campaign's sequence` : "") +
      (r.skippedDoNotContact ? `, ${r.skippedDoNotContact} replied, bounced, unsubscribed or invalid before` : "") +
      (r.skippedInvalid ? `, ${r.skippedInvalid} invalid emails` : ""),
  );
}
