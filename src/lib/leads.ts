import "server-only";
import { all, run, tx, logActivity } from "./db";
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

// A contact can be in several of a client's campaigns, once in each. These two rules, written against a lead
// aliased `a`, keep that safe: the import uses the first, the send (push.ts) uses both.

/**
 * Never emailed again from any campaign: replied (an out-of-office doesn't count), bounced, unsubscribed, or invalid.
 * Instantly lead status: -1 bounced, -2 unsubscribed.
 */
export const DO_NOT_CONTACT = (a: string) =>
  `(${a}.instantly_status IN (-1, -2) OR ${a}.verification = 'invalid' OR EXISTS (
     SELECT 1 FROM emails e WHERE e.client_id = ${a}.client_id AND e.lead_email = ${a}.email AND e.direction = 'in'
       AND e.interest IS DISTINCT FROM 'ooo'))`;

/** Handed to Instantly and its sequence not over yet (3 = completed, -3 = skipped), so another campaign must wait. */
export const IN_SEQUENCE = (a: string) =>
  `((${a}.pushed_at IS NOT NULL OR ${a}.instantly_lead_id IS NOT NULL) AND COALESCE(${a}.instantly_status, 1) NOT IN (3, -3))`;

export type OtherCampaign = { campaign: string; outcome: string; tone: string };

/** For each of these contacts, the client's other campaigns they're in and how each went, oldest first. */
export async function otherCampaigns(clientId: number, campaignId: number, emails: string[]): Promise<Map<string, OtherCampaign[]>> {
  const out = new Map<string, OtherCampaign[]>();
  if (emails.length === 0) return out;
  const rows = await all<{ email: string; campaign: string; stage: string; verification: string | null; instantly_status: number | null; replied: boolean }>(
    `SELECT o.email, c.name campaign, o.stage, o.verification, o.instantly_status,
       EXISTS (SELECT 1 FROM emails e WHERE e.client_id = o.client_id AND e.lead_email = o.email AND e.direction = 'in'
         AND e.campaign_id = o.campaign_id AND e.interest IS DISTINCT FROM 'ooo') replied
     FROM leads o JOIN campaigns c ON c.id = o.campaign_id
     WHERE o.client_id = ? AND o.campaign_id <> ? AND o.email = ANY(?) ORDER BY o.id`,
    clientId, campaignId, emails,
  );
  for (const r of rows) {
    const sent = r.stage === "pushed" || r.stage.startsWith("extend");
    const [outcome, tone] =
      r.replied ? ["replied", "text-go"]
      : r.instantly_status === -1 ? ["bounced", "text-bad"]
      : r.instantly_status === -2 ? ["unsubscribed", "text-bad"]
      : r.verification === "invalid" ? ["invalid address", "text-bad"]
      : sent && r.instantly_status === 3 ? ["sequence finished, no reply", "text-muted"]
      : sent ? ["being emailed", "text-info"]
      : r.stage === "rejected" || r.stage === "removed" ? ["not sent", "text-muted"]
      : ["waiting, not sent yet", "text-wait"];
    out.set(r.email, [...(out.get(r.email) ?? []), { campaign: r.campaign, outcome, tone }]);
  }
  return out;
}

type Earlier = {
  id: number;
  campaign_id: number | null;
  stage: string;
  verification: string | null;
  verified_at: string | null;
  ghl_contact_id: string | null;
  ghl_verification_tag: string | null;
  dnc: boolean;
};

/**
 * Add leads to a campaign:
 *   - already in this campaign: its fields are refreshed while it's still 'new', otherwise it's left alone;
 *   - replied, bounced, unsubscribed or invalid in any campaign: skipped;
 *   - otherwise added, even while another campaign has it: the send waits until no other sequence is emailing it.
 *     It keeps the address check from its latest earlier campaign.
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

  // Each database trip costs tens of milliseconds, so a batch is read in one query and written in two, however big.
  const wanted = new Map<string, LeadFields>();
  for (const l of leads) {
    const email = l.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) r.skippedInvalid++;
    else if (wanted.has(email)) r.skippedExisting++; // the same address twice in one import
    else wanted.set(email, l);
  }
  if (wanted.size === 0) {
    if (log) await logImport(clientId, source, sourceRef, r);
    return r;
  }
  const earlier = new Map<string, Earlier[]>();
  for (const e of await all<Earlier & { email: string }>(
    `SELECT l.email, l.id, l.campaign_id, l.stage, l.verification, l.verified_at, l.ghl_contact_id, l.ghl_verification_tag, ${DO_NOT_CONTACT("l")} dnc
     FROM leads l WHERE l.client_id = ? AND l.email = ANY(?) ORDER BY l.id DESC`,
    clientId, [...wanted.keys()],
  )) earlier.set(e.email, [...(earlier.get(e.email) ?? []), e]);

  type Write = {
    id?: number; email: string; first_name: string | null; last_name: string | null; company: string | null; title: string | null;
    phone: string | null; website: string | null; fields: string; ghl: string | null;
    verification: string; verified_at: string | null; tag: string | null; stage: string; stage_message: string | null;
  };
  const inserts: Write[] = [];
  const refreshes: Write[] = [];
  for (const [email, l] of wanted) {
    const mine = earlier.get(email) ?? [];
    const existing = mine.find((e) => e.campaign_id === campaignId);
    if (existing && existing.stage !== "new") {
      r.skippedExisting++;
      continue;
    }
    const others = mine.filter((e) => e !== existing);
    if (others.some((e) => e.dnc)) {
      r.skippedDoNotContact++;
      continue;
    }
    const w: Write = {
      email,
      first_name: l.first_name?.trim() || null,
      last_name: l.last_name?.trim() || null,
      company: l.company?.trim() || null,
      title: l.title?.trim() || null,
      phone: l.phone?.trim() || null,
      website: l.website?.trim() || null,
      fields: JSON.stringify(l.fields ?? {}),
      ghl: l.ghl_contact_id ?? others.find((e) => e.ghl_contact_id)?.ghl_contact_id ?? null,
      verification: existing?.verification ?? "queued", verified_at: null, tag: null, stage: "new", stage_message: null,
    };
    const prior = existing ? undefined : others.find((e) => e.verification === "verified" || e.verification === "catch_all");
    const portal = source === "ghl" && w.ghl ? l.check : null;
    if (prior) {
      // Checked in an earlier campaign: keep that result and prepare the email straight away.
      Object.assign(w, { verification: prior.verification, verified_at: prior.verified_at, tag: prior.ghl_verification_tag === "done" ? "done" : null, stage: "drafting" });
      r.reused++;
    } else if (portal && w.verification === "queued") {
      // Already tagged with a result in the portal; a contact mid-check or already checked keeps its own result.
      Object.assign(w, {
        verification: portal, verified_at: now, tag: "done",
        stage: portal === "invalid" ? "rejected" : "drafting",
        stage_message: portal === "invalid" ? "Invalid email address (already tagged in the Nexus Portal)" : null,
      });
      r.reused++;
    }
    if (existing) refreshes.push({ ...w, id: existing.id });
    else inserts.push(w);
  }

  const columns = `email text, first_name text, last_name text, company text, title text, phone text, website text, fields text,
    ghl text, verification text, verified_at text, tag text, stage text, stage_message text`;
  await tx(async () => {
    if (inserts.length) {
      const added = (await run(
        `INSERT INTO leads (client_id, campaign_id, source, source_ref, email, first_name, last_name, company, title, phone, website,
           fields, ghl_contact_id, verification, verified_at, ghl_verification_tag, stage, stage_message)
         SELECT ?, ?, ?, ?, x.email, x.first_name, x.last_name, x.company, x.title, x.phone, x.website, x.fields, x.ghl,
           x.verification, x.verified_at, x.tag, x.stage, x.stage_message
         FROM jsonb_to_recordset(?::jsonb) AS x(${columns})
         ON CONFLICT (campaign_id, email) DO NOTHING`,
        clientId, campaignId, source, sourceRef, JSON.stringify(inserts),
      )).changes;
      r.added += added;
      r.skippedExisting += inserts.length - added; // added by another import a moment ago
    }
    if (refreshes.length) {
      r.updated += (await run(
        `UPDATE leads l SET first_name = x.first_name, last_name = x.last_name, company = x.company, title = x.title, phone = x.phone,
           website = x.website, fields = x.fields, ghl_contact_id = COALESCE(x.ghl, l.ghl_contact_id), verification = x.verification,
           verified_at = COALESCE(x.verified_at, l.verified_at), ghl_verification_tag = COALESCE(x.tag, l.ghl_verification_tag),
           stage = x.stage, stage_message = x.stage_message
         FROM jsonb_to_recordset(?::jsonb) AS x(id int, ${columns})
         WHERE l.id = x.id AND l.stage = 'new'`,
        JSON.stringify(refreshes),
      )).changes;
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
      (r.skippedDoNotContact ? `, ${r.skippedDoNotContact} replied, bounced, unsubscribed or invalid before` : "") +
      (r.skippedInvalid ? `, ${r.skippedInvalid} invalid emails` : ""),
  );
}
