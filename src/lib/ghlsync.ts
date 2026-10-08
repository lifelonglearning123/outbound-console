import "server-only";
import { all, get, run, logActivity } from "./db";
import type { Client } from "./clients";
import { contactsWithTag, emailDnd, getContact, logEmail, upsertContact, type GhlContact, type GhlCreds } from "./ghl";
import { importLeads, type LeadRow } from "./leads";
import { toHtml } from "./merge";

// GHL is the source of truth for contacts:
//   - every lead added here becomes (or matches) a contact in the client's GHL before anything is sent;
//   - campaigns linked to a GHL tag pull newly tagged contacts in automatically;
//   - a lead's details are refreshed from GHL just before its emails are written;
//   - every email sent and every reply is copied into the contact's GHL conversation.

export function ghlCreds(client: Client): GhlCreds | null {
  return client.ghl_location_id && client.ghl_token ? { locationId: client.ghl_location_id, token: client.ghl_token } : null;
}

/** Create or match the lead's GHL contact. Returns the contact id. */
export async function linkLead(client: Client, lead: LeadRow): Promise<string | null> {
  const creds = ghlCreds(client);
  if (!creds) return null;
  if (lead.ghl_contact_id) return lead.ghl_contact_id;
  const id = await upsertContact(creds, {
    email: lead.email,
    firstName: lead.first_name,
    lastName: lead.last_name,
    companyName: lead.company,
    phone: lead.phone,
    website: lead.website,
  });
  await run("UPDATE leads SET ghl_contact_id = ? WHERE id = ?", id, lead.id);
  return id;
}

/** Link leads added here (typed in, CSV) that aren't in GHL yet. */
export async function linkPendingLeads(client: Client, limit = 100): Promise<number> {
  if (!ghlCreds(client)) return 0;
  const leads = await all<LeadRow>(
    "SELECT * FROM leads WHERE client_id = ? AND ghl_contact_id IS NULL AND stage NOT IN ('removed') ORDER BY id LIMIT ?",
    client.id, limit,
  );
  let n = 0;
  for (const l of leads) {
    try {
      await linkLead(client, l);
      n++;
    } catch (e) {
      await run("UPDATE leads SET stage_message = ? WHERE id = ?", `Couldn't add to Nexus Portal: ${(e as Error).message}`, l.id);
    }
  }
  if (n) await logActivity(client.id, "ghl", `Added ${n} leads to Nexus Portal as contacts`);
  return n;
}

/**
 * GHL wins: refresh the lead's name, company and so on from its GHL contact before its emails are
 * written. Returns false when the contact has email DND on, in which case nothing should be written.
 */
export async function refreshFromGhl(client: Client, lead: LeadRow): Promise<boolean> {
  const creds = ghlCreds(client);
  if (!creds || !lead.ghl_contact_id) return true;
  const c = await getContact(creds, lead.ghl_contact_id);
  if (!c) return true; // deleted in Nexus Portal: keep what we have
  if (emailDnd(c)) {
    await run(
      "UPDATE leads SET stage = 'rejected', stage_message = 'Email Do-Not-Disturb is on in Nexus Portal', ghl_synced_at = datetime('now') WHERE id = ?",
      lead.id,
    );
    return false;
  }
  await run(
    `UPDATE leads SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), company = COALESCE(?, company),
       phone = COALESCE(?, phone), website = COALESCE(?, website), ghl_synced_at = datetime('now') WHERE id = ?`,
    c.firstNameRaw ?? c.firstName ?? null, c.lastNameRaw ?? c.lastName ?? null, c.companyName ?? null, c.phone ?? null,
    c.website ?? null, lead.id,
  );
  return true;
}

/** Contacts newly tagged in GHL join the campaign linked to that tag and go straight to the AI writer. */
export async function pullTaggedContacts(client: Client): Promise<number> {
  const creds = ghlCreds(client);
  if (!creds) return 0;
  const campaigns = await all<{ id: number; name: string; ghl_tag: string }>(
    "SELECT id, name, ghl_tag FROM campaigns WHERE client_id = ? AND managed = 1 AND ghl_tag IS NOT NULL AND ghl_tag != '' AND status != 'completed'",
    client.id,
  );
  let total = 0;
  for (const c of campaigns) {
    const contacts: GhlContact[] = (await contactsWithTag(creds, c.ghl_tag)).filter((x) => x.email && !emailDnd(x));
    // Only contacts this client doesn't have yet; people already in any campaign are left where they are.
    const fresh: GhlContact[] = [];
    for (const x of contacts) {
      const known = await get<{ id: number }>("SELECT id FROM leads WHERE client_id = ? AND email = ?", client.id, String(x.email).toLowerCase());
      if (!known) fresh.push(x);
    }
    if (fresh.length === 0) continue;
    const r = await importLeads(
      client.id,
      c.id,
      "ghl",
      `tag: ${c.ghl_tag}`,
      fresh.map((x) => ({
        email: String(x.email),
        first_name: x.firstNameRaw ?? x.firstName ?? null,
        last_name: x.lastNameRaw ?? x.lastName ?? null,
        company: x.companyName ?? null,
        phone: x.phone ?? null,
        website: x.website ?? null,
        ghl_contact_id: x.id,
      })),
    );
    await run(
      "UPDATE leads SET stage = 'drafting' WHERE client_id = ? AND campaign_id = ? AND stage = 'new' AND source = 'ghl'",
      client.id, c.id,
    );
    total += r.added;
    if (r.added) await logActivity(client.id, "ghl", `${r.added} new contacts tagged "${c.ghl_tag}" in Nexus Portal joined "${c.name}"; writing their emails`);
  }
  return total;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Copy emails sent and replies received into each contact's GHL conversation (records only; nothing is sent). */
export async function logEmailsToGhl(client: Client, limit = 40): Promise<number> {
  const creds = ghlCreds(client);
  if (!creds) return 0;
  // Start from the first lead this console sent for the client (or now), so older mailbox history isn't copied.
  let since = client.ghl_log_since;
  if (!since) {
    since =
      (await get<{ t: string | null }>("SELECT MIN(pushed_at) t FROM leads WHERE client_id = ? AND pushed_at IS NOT NULL", client.id))?.t ??
      new Date().toISOString();
    await run("UPDATE clients SET ghl_log_since = ? WHERE id = ?", since, client.id);
  }
  const emails = await all<{
    id: string; lead_id: number | null; lead_email: string | null; direction: string; step: number | null; account_email: string;
    subject: string | null; body_text: string | null; sent_at: string;
  }>(
    `SELECT id, lead_id, lead_email, direction, step, account_email, subject, body_text, sent_at FROM emails
     WHERE client_id = ? AND ghl_logged_at IS NULL AND ghl_log_error IS NULL AND sent_at >= ? AND lead_email IS NOT NULL
     ORDER BY sent_at LIMIT ?`,
    client.id, since, limit,
  );
  let n = 0;
  for (const e of emails) {
    try {
      // The lead's contact, or (for replies to campaigns built in Instantly) a contact matched by email.
      const lead = e.lead_id ? await get<LeadRow>("SELECT * FROM leads WHERE id = ?", e.lead_id) : undefined;
      const contactId = lead ? await linkLead(client, lead) : await upsertContact(creds, { email: e.lead_email! });
      if (!contactId) continue;
      // For our own sends, log the approved design rather than Instantly's stripped text.
      const draft =
        e.direction === "out" && e.lead_id && e.step
          ? await get<{ body: string; format: string }>("SELECT body, format FROM drafts WHERE lead_id = ? AND step = ?", e.lead_id, e.step)
          : undefined;
      const text = e.body_text ?? "";
      const html = draft ? (draft.format === "html" ? draft.body : toHtml(draft.body)) : esc(text).replace(/\r?\n/g, "<br/>");
      const out = e.direction === "out";
      await logEmail(creds, {
        contactId,
        direction: out ? "outbound" : "inbound",
        subject: e.subject ?? "",
        html,
        text,
        from: out ? e.account_email : e.lead_email!,
        to: out ? e.lead_email! : e.account_email,
        date: e.sent_at,
      });
      await run("UPDATE emails SET ghl_logged_at = datetime('now') WHERE id = ?", e.id);
      n++;
    } catch (err) {
      await run("UPDATE emails SET ghl_log_error = ? WHERE id = ?", (err as Error).message.slice(0, 300), e.id);
    }
  }
  return n;
}
