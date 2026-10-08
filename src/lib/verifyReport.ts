import "server-only";
import { all, get, run, tx, logActivity, getSetting, setSetting, withLock } from "./db";
import { requireClient } from "./clients";
import { ghlCreds } from "./ghlsync";
import { addContactTags, deleteContact, GhlError } from "./ghl";
import { llmKeyHint, llmLabel, llmReady, llmText } from "./llm";

/**
 * What came out of email verification (verify.ts), what it means, and what to do with each group in the
 * Nexus Portal (the client-facing name of their GHL sub-account; GHL is the source of truth for contacts):
 *   verified  -> tag "Email Verified"
 *   catch_all -> tag "Email Unable To Verify"
 *   invalid   -> tag "Email Invalid"
 * Unable-to-verify and invalid contacts can also be deleted from the portal; the lead then stays in the console as
 * 'removed' so the lists and exports still show what happened to it.
 * Portal calls are made one contact at a time, so the actions run as a resumable background job
 * (leads.ghl_verification_tag: queued_tag | queued_delete | done | deleted), picked up on page views and on each sync.
 */

export const PORTAL = "Nexus Portal";

export type Outcome = "verified" | "catch_all" | "invalid";
export const OUTCOMES: Outcome[] = ["verified", "catch_all", "invalid"];
/** The exact tag each group gets in the portal. */
export const GHL_TAGS: Record<Outcome, string> = { verified: "Email Verified", catch_all: "Email Unable To Verify", invalid: "Email Invalid" };
export const OUTCOME_LABEL: Record<Outcome, string> = { verified: "Verified", catch_all: "Unable to verify", invalid: "Invalid" };

const CONCURRENCY = 3; // the portal allows bursts of 100 per 10s; keep well under it
const BUDGET_MS = 240_000;

type GroupStatus = {
  tagged: number; // carries the tag in the portal
  deleted: number; // deleted from the portal
  tagTodo: number; // in the portal, not tagged yet
  deletable: number; // in the portal, not yet in Instantly (can be deleted)
};

export type VerificationReport = {
  total: number;
  checking: number;
  counts: Record<Outcome, number>;
  checked: number;
  unchecked: number; // still checkable, never checked
  pushedUnchecked: number; // already in Instantly before checks existed; can't be checked now
  campaigns: { id: number; name: string; verified: number; catch_all: number; invalid: number; unchecked: number }[];
  catchAllDomains: { domain: string; n: number }[];
  portal: { connected: boolean; queued: number; error: string | null; groups: Record<Outcome, GroupStatus> };
  credits: string | null;
  summary: { text: string; at: string } | null;
  summaryError: string | null;
};

const CHECKABLE = `pushed_at IS NULL AND instantly_lead_id IS NULL AND stage NOT IN ('rejected', 'removed')`;
const DELETABLE = `pushed_at IS NULL AND instantly_lead_id IS NULL AND ghl_contact_id IS NOT NULL AND (ghl_verification_tag IS NULL OR ghl_verification_tag = 'done')`;

/** `WHERE` fragment and params for one client, optionally one campaign. */
function scope(clientId: number, campaignId: number | null, alias = ""): { where: string; params: number[] } {
  const a = alias ? `${alias}.` : "";
  return campaignId
    ? { where: `${a}client_id = ? AND ${a}campaign_id = ?`, params: [clientId, campaignId] }
    : { where: `${a}client_id = ?`, params: [clientId] };
}

export async function verificationReport(clientId: number, campaignId: number | null = null): Promise<VerificationReport> {
  const client = await requireClient(clientId);
  const sc = scope(clientId, campaignId);
  const rows = await all<{ v: string | null; n: number }>(`SELECT verification v, COUNT(*) n FROM leads WHERE ${sc.where} GROUP BY verification`, ...sc.params);
  const by = (v: string | null) => rows.find((r) => r.v === v)?.n ?? 0;
  const counts = { verified: by("verified"), catch_all: by("catch_all"), invalid: by("invalid") };
  const total = rows.reduce((a, r) => a + r.n, 0);
  const unchecked = (await get<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE ${sc.where} AND verification IS NULL AND ${CHECKABLE}`, ...sc.params))?.n ?? 0;
  const pushedUnchecked =
    (await get<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE ${sc.where} AND verification IS NULL AND (pushed_at IS NOT NULL OR instantly_lead_id IS NOT NULL)`, ...sc.params))?.n ?? 0;

  const campaigns = await all<VerificationReport["campaigns"][number]>(
    `SELECT c.id, c.name,
       COUNT(*) FILTER (WHERE l.verification = 'verified') verified,
       COUNT(*) FILTER (WHERE l.verification = 'catch_all') catch_all,
       COUNT(*) FILTER (WHERE l.verification = 'invalid') invalid,
       COUNT(*) FILTER (WHERE l.verification IS NULL AND l.pushed_at IS NULL AND l.instantly_lead_id IS NULL AND l.stage NOT IN ('rejected', 'removed')) unchecked
     FROM campaigns c JOIN leads l ON l.campaign_id = c.id
     WHERE c.client_id = ? ${campaignId ? "AND c.id = ?" : ""} GROUP BY c.id, c.name HAVING COUNT(*) FILTER (WHERE l.verification IS NOT NULL) > 0 ORDER BY c.created_at DESC`,
    ...sc.params,
  );
  const catchAllDomains = await all<{ domain: string; n: number }>(
    `SELECT split_part(email, '@', 2) domain, COUNT(*) n FROM leads WHERE ${sc.where} AND verification = 'catch_all' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12`,
    ...sc.params,
  );

  const groupRows = await all<{ v: Outcome } & GroupStatus & { queued: number }>(
    `SELECT verification v,
       COUNT(*) FILTER (WHERE ghl_verification_tag = 'done') tagged,
       COUNT(*) FILTER (WHERE ghl_verification_tag = 'deleted') deleted,
       COUNT(*) FILTER (WHERE ghl_verification_tag LIKE 'queued%') queued,
       COUNT(*) FILTER (WHERE ghl_verification_tag IS NULL AND ghl_contact_id IS NOT NULL) "tagTodo",
       COUNT(*) FILTER (WHERE ${DELETABLE}) deletable
     FROM leads WHERE ${sc.where} AND verification IN ('verified', 'catch_all', 'invalid') GROUP BY verification`,
    ...sc.params,
  );
  const group = (v: Outcome): GroupStatus => {
    const g = groupRows.find((r) => r.v === v);
    return { tagged: g?.tagged ?? 0, deleted: g?.deleted ?? 0, tagTodo: g?.tagTodo ?? 0, deletable: g?.deletable ?? 0 };
  };

  const key = summaryKey(clientId, campaignId);
  let summary: VerificationReport["summary"] = null;
  try {
    const raw = await getSetting(`verify_summary_${key}`, "");
    if (raw) summary = JSON.parse(raw);
  } catch {}

  return {
    total,
    checking: by("queued") + by("pending"),
    counts,
    checked: counts.verified + counts.catch_all + counts.invalid,
    unchecked,
    pushedUnchecked,
    campaigns,
    catchAllDomains,
    portal: {
      connected: !!ghlCreds(client),
      queued: groupRows.reduce((a, r) => a + r.queued, 0),
      error: (await getSetting(`verify_actions_error_${clientId}`, "")) || null,
      groups: { verified: group("verified"), catch_all: group("catch_all"), invalid: group("invalid") },
    },
    credits: (await getSetting(`verify_credits_${clientId}`, "")) || null,
    summary,
    summaryError: (await getSetting(`verify_summary_error_${key}`, "")) || null,
  };
}

const summaryKey = (clientId: number, campaignId: number | null) => (campaignId ? `${clientId}_c${campaignId}` : `${clientId}`);

export type GroupLead = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  campaign: string | null;
  verified_at: string | null;
  ghl_verification_tag: string | null;
  in_portal: boolean;
  in_instantly: boolean;
};

/** Every lead in one verification group, for the folded list and the CSV export. */
export async function groupLeads(clientId: number, outcome: Outcome, campaignId: number | null = null): Promise<GroupLead[]> {
  const sc = scope(clientId, campaignId, "l");
  return all<GroupLead>(
    `SELECT l.email, l.first_name, l.last_name, l.company, c.name campaign, l.verified_at, l.ghl_verification_tag,
       l.ghl_contact_id IS NOT NULL in_portal, (l.pushed_at IS NOT NULL OR l.instantly_lead_id IS NOT NULL) in_instantly
     FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE ${sc.where} AND l.verification = ? ORDER BY l.company NULLS LAST, l.email`,
    ...sc.params, outcome,
  );
}

/** What has happened to the lead's contact in the portal, in words. */
export function portalStatus(l: Pick<GroupLead, "ghl_verification_tag" | "in_portal">, outcome: Outcome): string {
  switch (l.ghl_verification_tag) {
    case "done": return `Tagged "${GHL_TAGS[outcome]}"`;
    case "deleted": return `Deleted from ${PORTAL}`;
    case "queued_tag": return "Tagging…";
    case "queued_delete": return "Deleting…";
    default: return l.in_portal ? "Not tagged yet" : `Not in ${PORTAL}`;
  }
}

/** The reading of the numbers that's always shown, whether or not the AI summary has been written. */
export function plainReading(r: VerificationReport): string[] {
  const p = (n: number) => (r.checked ? `${Math.round((n / r.checked) * 100)}%` : "0%");
  const out: string[] = [];
  if (!r.checked) return ["No addresses have been checked yet. Use \"Check email addresses\" on the Leads page first."];
  out.push(`${r.checked.toLocaleString("en-GB")} addresses were checked with Instantly: ${r.counts.verified.toLocaleString("en-GB")} verified (${p(r.counts.verified)}), ${r.counts.catch_all.toLocaleString("en-GB")} unable to verify (${p(r.counts.catch_all)}) and ${r.counts.invalid.toLocaleString("en-GB")} invalid (${p(r.counts.invalid)}).`);
  if (r.counts.invalid / r.checked > 0.08) {
    out.push(`An invalid share above 8% means the list is stale: sending to it unchecked would have bounced at roughly that rate and put the mailboxes at risk. Those leads are already rejected and won't be emailed.`);
  } else if (r.counts.invalid) {
    out.push(`The invalid share is low, so the list is in reasonable shape. Those leads are already rejected.`);
  }
  if (r.counts.catch_all) {
    out.push(`"Unable to verify" means the company's mail server accepts every address (a catch-all), so no checker can confirm whether the person still works there. Send to the verified group first, then release these in small daily batches so a bad run can't push a mailbox's bounce rate over 3%.`);
  }
  if (r.counts.verified) out.push(`The verified group is safe to approve and send.`);
  if (r.pushedUnchecked) out.push(`${r.pushedUnchecked.toLocaleString("en-GB")} leads were already in Instantly before the check and can't be checked now; their bounces will show on the campaign page.`);
  if (r.unchecked) out.push(`${r.unchecked.toLocaleString("en-GB")} leads are still unchecked.`);
  return out;
}

// ---------- AI summary ----------

/** Ask the model for a short account-manager style summary of the verification results. Stored per client. */
export async function writeVerificationSummary(clientId: number, campaignId: number | null = null): Promise<void> {
  const client = await requireClient(clientId);
  const r = await verificationReport(clientId, campaignId);
  const g = r.portal.groups;
  const key = summaryKey(clientId, campaignId);
  await run("DELETE FROM settings WHERE key = ?", `verify_summary_error_${key}`);
  try {
    if (!llmReady()) throw new Error(`No AI key: set ${llmKeyHint()} in Vercel`);
    const facts = [
      `Client: ${client.name}.`,
      `Leads in the console: ${r.total}. Checked: ${r.checked}. Verified: ${r.counts.verified}. Unable to verify (catch-all domain): ${r.counts.catch_all}. Invalid: ${r.counts.invalid}.`,
      `Still unchecked and checkable: ${r.unchecked}. Already in Instantly before checks existed (can't be checked now): ${r.pushedUnchecked}.`,
      `Per campaign: ${r.campaigns.map((c) => `"${c.name}": ${c.verified} verified, ${c.catch_all} unable to verify, ${c.invalid} invalid`).join("; ") || "none"}.`,
      `Companies with the most unable-to-verify addresses: ${r.catchAllDomains.slice(0, 6).map((d) => `${d.domain} (${d.n})`).join(", ") || "none"}.`,
      `The client's CRM is called the ${PORTAL}. ${r.portal.connected ? "Connected" : "Not connected"}. Tagged so far: ${g.verified.tagged} "${GHL_TAGS.verified}", ${g.catch_all.tagged} "${GHL_TAGS.catch_all}", ${g.invalid.tagged} "${GHL_TAGS.invalid}". Deleted from the portal: ${g.catch_all.deleted + g.invalid.deleted}.`,
      `Available actions: tag each group in the ${PORTAL} ("${GHL_TAGS.verified}", "${GHL_TAGS.catch_all}", "${GHL_TAGS.invalid}"); delete unable-to-verify or invalid contacts from the ${PORTAL}; export each group's emails as CSV.`,
    ].join("\n");
    const text = await llmText({
      system:
        "You are a cold-email deliverability lead writing for the account owner of a small B2B outreach client. British English, plain text, no headings, no bullet lists, no markdown. " +
        `Always call the CRM the ${PORTAL}; never say GHL, HighLevel or GoHighLevel. ` +
        "Write three short paragraphs, under 180 words in total: (1) what the check found and what it says about the list quality, with the key percentages; " +
        "(2) what each group means for deliverability (verified = safe; unable to verify = catch-all domain, unconfirmed, send in small batches after the verified group; invalid = would bounce, already rejected); " +
        "(3) the recommended next actions in order, using only the actions listed. Use only the facts given; never invent numbers.",
      user: facts,
      effort: "low",
    });
    await setSetting(`verify_summary_${key}`, JSON.stringify({ text, at: new Date().toISOString(), model: llmLabel() }));
  } catch (e) {
    const msg = (e as Error).message;
    await setSetting(
      `verify_summary_error_${key}`,
      /401|Incorrect API key|invalid.*key|authentication/i.test(msg) ? `${llmLabel()} rejected the API key. Fix ${llmKeyHint()} in Vercel, then try again.` : msg,
    );
  }
}

// ---------- Portal actions ----------

/** Queue tagging in the portal for every lead of a group that's in the portal and not tagged yet. Returns how many. */
export async function queueTagging(clientId: number, outcome: Outcome, campaignId: number | null = null): Promise<number> {
  const sc = scope(clientId, campaignId);
  return (await run(
    `UPDATE leads SET ghl_verification_tag = 'queued_tag' WHERE ${sc.where} AND verification = ? AND ghl_contact_id IS NOT NULL AND ghl_verification_tag IS NULL`,
    ...sc.params, outcome,
  )).changes;
}

/**
 * Queue deleting a group's contacts from the portal (unable-to-verify or invalid only). Leads already in Instantly
 * are left alone. The lead stays in the console as 'removed' so it still appears in the lists and exports.
 */
export async function queueDeletion(clientId: number, outcome: "invalid" | "catch_all", campaignId: number | null = null): Promise<number> {
  const sc = scope(clientId, campaignId);
  return (await run(`UPDATE leads SET ghl_verification_tag = 'queued_delete' WHERE ${sc.where} AND verification = ? AND ${DELETABLE}`, ...sc.params, outcome)).changes;
}

export async function runVerificationActions() {
  await withLock("verify_actions", 10 * 60_000, actAll);
}

type Job = { id: number; client_id: number; email: string; verification: Outcome; ghl_contact_id: string | null; ghl_verification_tag: string };

async function actAll() {
  const deadline = Date.now() + BUDGET_MS;
  const stopped = new Set<number>();
  const tally = new Map<number, { tagged: Record<Outcome, number>; deleted: number }>();
  const creds = new Map<number, NonNullable<ReturnType<typeof ghlCreds>> | null>();
  const credsFor = async (clientId: number) => {
    if (!creds.has(clientId)) creds.set(clientId, ghlCreds(await requireClient(clientId)));
    return creds.get(clientId)!;
  };

  while (Date.now() < deadline) {
    const skip = stopped.size ? `AND client_id NOT IN (${[...stopped].join(",")})` : "";
    const batch = await all<Job>(
      `SELECT id, client_id, email, verification, ghl_contact_id, ghl_verification_tag FROM leads WHERE ghl_verification_tag LIKE 'queued%' ${skip} ORDER BY id LIMIT ?`,
      CONCURRENCY,
    );
    if (batch.length === 0) break;

    const results = await Promise.allSettled(batch.map(async (l) => actOnLead(l, await credsFor(l.client_id))));
    for (const [i, r] of results.entries()) {
      const lead = batch[i];
      const t = tally.get(lead.client_id) ?? { tagged: { verified: 0, catch_all: 0, invalid: 0 }, deleted: 0 };
      tally.set(lead.client_id, t);
      if (r.status === "fulfilled") {
        if (r.value === "tagged") t.tagged[lead.verification]++;
        else t.deleted++;
        continue;
      }
      const e = r.reason as Error;
      const status = e instanceof GhlError ? e.status : 0;
      if (status === 404 && lead.ghl_verification_tag === "queued_delete") {
        await markDeleted(lead); // already gone from the portal
        t.deleted++;
      } else if (status === 401 || status === 403) {
        if (stopped.has(lead.client_id)) continue;
        stopped.add(lead.client_id);
        await run("UPDATE leads SET ghl_verification_tag = NULL WHERE client_id = ? AND ghl_verification_tag LIKE 'queued%'", lead.client_id);
        await setSetting(`verify_actions_error_${lead.client_id}`, `The ${PORTAL} refused the change (${e.message}). Check the portal token in Settings, then try again.`);
        await logActivity(lead.client_id, "error", `${PORTAL} updates stopped: ${e.message}`);
      } else {
        await run("UPDATE leads SET ghl_verification_tag = NULL WHERE id = ?", lead.id);
        await logActivity(lead.client_id, "error", `Couldn't update ${lead.email} in the ${PORTAL}: ${e.message}`);
      }
    }
    if (results.every((r) => r.status === "rejected")) break;
  }

  for (const [clientId, t] of tally) {
    const parts = [
      ...OUTCOMES.filter((o) => t.tagged[o]).map((o) => `tagged ${t.tagged[o]} contacts "${GHL_TAGS[o]}"`),
      t.deleted ? `deleted ${t.deleted} contacts` : "",
    ].filter(Boolean);
    if (!parts.length) continue;
    await run("DELETE FROM settings WHERE key = ?", `verify_actions_error_${clientId}`);
    await logActivity(clientId, "verify", `${PORTAL}: ${parts.join(", ")}`);
  }
}

async function markDeleted(l: Job) {
  await tx(async () => {
    if (l.ghl_contact_id) await run("DELETE FROM ghl_contacts WHERE client_id = ? AND contact_id = ?", l.client_id, l.ghl_contact_id);
    await run(
      `UPDATE leads SET stage = 'removed', stage_message = ?, ghl_contact_id = NULL, ghl_verification_tag = 'deleted' WHERE id = ?`,
      `Deleted from the ${PORTAL} (email ${OUTCOME_LABEL[l.verification].toLowerCase()})`, l.id,
    );
    await run("UPDATE drafts SET status = 'rejected', reviewed_at = datetime('now') WHERE lead_id = ? AND status IN ('pending', 'approved')", l.id);
  });
}

async function actOnLead(l: Job, creds: NonNullable<ReturnType<typeof ghlCreds>> | null): Promise<"tagged" | "deleted"> {
  if (!creds || !l.ghl_contact_id) {
    await run("UPDATE leads SET ghl_verification_tag = NULL WHERE id = ?", l.id);
    throw new Error(`not linked to a ${PORTAL} contact`);
  }
  if (l.ghl_verification_tag === "queued_delete") {
    await deleteContact(creds, l.ghl_contact_id);
    await markDeleted(l);
    return "deleted";
  }
  await addContactTags(creds, l.ghl_contact_id, [GHL_TAGS[l.verification]]);
  await run("UPDATE leads SET ghl_verification_tag = 'done' WHERE id = ?", l.id);
  return "tagged";
}
