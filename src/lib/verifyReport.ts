import "server-only";
import { all, get, run, logActivity, getSetting, setSetting, withLock } from "./db";
import { requireClient } from "./clients";
import { ghlCreds } from "./ghlsync";
import { addContactTags, deleteContact, GhlError } from "./ghl";
import { llmKeyHint, llmLabel, llmReady, llmText } from "./llm";

/**
 * What came out of email verification (verify.ts), what it means, and what to do with each group in GHL:
 *   verified  -> tag the GHL contact "email verified"
 *   catch_all -> tag the GHL contact "email catch-all"
 *   invalid   -> remove the lead from the console and tag the contact "email invalid", or delete the contact from GHL too
 * GHL calls are made one lead at a time, so the actions run as a resumable background job (leads.ghl_verification_tag:
 * queued_tag | queued_remove | queued_delete | done), picked up on page views and on each sync.
 */

export type Outcome = "verified" | "catch_all" | "invalid";
export const OUTCOMES: Outcome[] = ["verified", "catch_all", "invalid"];
export const GHL_TAGS: Record<Outcome, string> = { verified: "email verified", catch_all: "email catch-all", invalid: "email invalid" };

const CONCURRENCY = 3; // GHL allows bursts of 100 per 10s; keep well under it
const BUDGET_MS = 240_000;

export type VerificationReport = {
  total: number;
  checking: number;
  counts: Record<Outcome, number>;
  checked: number;
  unchecked: number; // still checkable, never checked
  pushedUnchecked: number; // already in Instantly before checks existed; can't be checked now
  campaigns: { id: number; name: string; verified: number; catch_all: number; invalid: number; unchecked: number }[];
  catchAllDomains: { domain: string; n: number }[];
  ghl: {
    connected: boolean;
    tagged: Record<Outcome, number>; // done
    queued: number; // GHL work still to do
    todo: Record<Outcome, number>; // leads the buttons would act on
    catchAllRemovable: number; // catch-all leads not yet in Instantly, which "delete from GHL" would remove
    error: string | null;
  };
  credits: string | null;
  summary: { text: string; at: string } | null;
  summaryError: string | null;
};

const CHECKABLE = `pushed_at IS NULL AND instantly_lead_id IS NULL AND stage NOT IN ('rejected', 'removed')`;

export async function verificationReport(clientId: number): Promise<VerificationReport> {
  const client = await requireClient(clientId);
  const rows = await all<{ v: string | null; n: number }>("SELECT verification v, COUNT(*) n FROM leads WHERE client_id = ? GROUP BY verification", clientId);
  const by = (v: string | null) => rows.find((r) => r.v === v)?.n ?? 0;
  const counts = { verified: by("verified"), catch_all: by("catch_all"), invalid: by("invalid") };
  const total = rows.reduce((a, r) => a + r.n, 0);
  const unchecked = (await get<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE client_id = ? AND verification IS NULL AND ${CHECKABLE}`, clientId))?.n ?? 0;
  const pushedUnchecked =
    (await get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE client_id = ? AND verification IS NULL AND (pushed_at IS NOT NULL OR instantly_lead_id IS NOT NULL)", clientId))?.n ?? 0;

  const campaigns = await all<VerificationReport["campaigns"][number]>(
    `SELECT c.id, c.name,
       COUNT(*) FILTER (WHERE l.verification = 'verified') verified,
       COUNT(*) FILTER (WHERE l.verification = 'catch_all') catch_all,
       COUNT(*) FILTER (WHERE l.verification = 'invalid') invalid,
       COUNT(*) FILTER (WHERE l.verification IS NULL AND l.pushed_at IS NULL AND l.instantly_lead_id IS NULL AND l.stage NOT IN ('rejected', 'removed')) unchecked
     FROM campaigns c JOIN leads l ON l.campaign_id = c.id
     WHERE c.client_id = ? GROUP BY c.id, c.name HAVING COUNT(*) FILTER (WHERE l.verification IS NOT NULL) > 0 ORDER BY c.created_at DESC`,
    clientId,
  );
  const catchAllDomains = await all<{ domain: string; n: number }>(
    "SELECT split_part(email, '@', 2) domain, COUNT(*) n FROM leads WHERE client_id = ? AND verification = 'catch_all' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12",
    clientId,
  );

  const tagRows = await all<{ v: Outcome; done: number; queued: number; todo: number }>(
    `SELECT verification v,
       COUNT(*) FILTER (WHERE ghl_verification_tag = 'done') done,
       COUNT(*) FILTER (WHERE ghl_verification_tag LIKE 'queued%') queued,
       COUNT(*) FILTER (WHERE ghl_verification_tag IS NULL AND ghl_contact_id IS NOT NULL) todo
     FROM leads WHERE client_id = ? AND verification IN ('verified', 'catch_all', 'invalid') GROUP BY verification`,
    clientId,
  );
  const tag = (v: Outcome) => tagRows.find((r) => r.v === v);
  const removable = async (v: Outcome) =>
    (await get<{ n: number }>(
      `SELECT COUNT(*) n FROM leads WHERE client_id = ? AND verification = ? AND pushed_at IS NULL AND instantly_lead_id IS NULL
       AND (ghl_verification_tag IS NULL OR ghl_verification_tag = 'done')`,
      clientId, v,
    ))?.n ?? 0;
  const invalidTodo = await removable("invalid");
  const catchAllRemovable = await removable("catch_all");

  let summary: VerificationReport["summary"] = null;
  try {
    const raw = await getSetting(`verify_summary_${clientId}`, "");
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
    ghl: {
      connected: !!ghlCreds(client),
      tagged: { verified: tag("verified")?.done ?? 0, catch_all: tag("catch_all")?.done ?? 0, invalid: tag("invalid")?.done ?? 0 },
      queued: tagRows.reduce((a, r) => a + r.queued, 0),
      todo: { verified: tag("verified")?.todo ?? 0, catch_all: tag("catch_all")?.todo ?? 0, invalid: invalidTodo },
      catchAllRemovable,
      error: (await getSetting(`verify_actions_error_${clientId}`, "")) || null,
    },
    credits: (await getSetting(`verify_credits_${clientId}`, "")) || null,
    summary,
    summaryError: (await getSetting(`verify_summary_error_${clientId}`, "")) || null,
  };
}

/** The reading of the numbers that's always shown, whether or not the AI summary has been written. */
export function plainReading(r: VerificationReport): string[] {
  const p = (n: number) => (r.checked ? `${Math.round((n / r.checked) * 100)}%` : "0%");
  const out: string[] = [];
  if (!r.checked) return ["No addresses have been checked yet. Use \"Check email addresses\" on the Leads page first."];
  out.push(`${r.checked.toLocaleString("en-GB")} addresses were checked with Instantly: ${r.counts.verified.toLocaleString("en-GB")} verified (${p(r.counts.verified)}), ${r.counts.catch_all.toLocaleString("en-GB")} catch-all (${p(r.counts.catch_all)}) and ${r.counts.invalid.toLocaleString("en-GB")} invalid (${p(r.counts.invalid)}).`);
  if (r.counts.invalid / r.checked > 0.08) {
    out.push(`An invalid share above 8% means the list is stale: sending to it unchecked would have bounced at roughly that rate and put the mailboxes at risk. Those leads are already rejected; removing them keeps the console and GHL clean.`);
  } else if (r.counts.invalid) {
    out.push(`The invalid share is low, so the list is in reasonable shape. Those leads are already rejected.`);
  }
  if (r.counts.catch_all) {
    out.push(`Catch-all addresses can't be confirmed either way: the company's mail server accepts everything. Treat them as a second tier: send to the verified group first, then release catch-all leads in small daily batches so a bad run can't push a mailbox's bounce rate over 3%.`);
  }
  if (r.counts.verified) out.push(`The verified group is safe to approve and send.`);
  if (r.pushedUnchecked) out.push(`${r.pushedUnchecked.toLocaleString("en-GB")} leads were already in Instantly before the check and can't be checked now; their bounces will show on the campaign page.`);
  if (r.unchecked) out.push(`${r.unchecked.toLocaleString("en-GB")} leads are still unchecked.`);
  return out;
}

// ---------- AI summary ----------

/** Ask the model for a short account-manager style summary of the verification results. Stored per client. */
export async function writeVerificationSummary(clientId: number): Promise<void> {
  const client = await requireClient(clientId);
  const r = await verificationReport(clientId);
  await run("DELETE FROM settings WHERE key = ?", `verify_summary_error_${clientId}`);
  try {
    if (!llmReady()) throw new Error(`No AI key: set ${llmKeyHint()} in Vercel`);
    const facts = [
      `Client: ${client.name}.`,
      `Leads in the console: ${r.total}. Checked: ${r.checked}. Verified: ${r.counts.verified}. Catch-all: ${r.counts.catch_all}. Invalid: ${r.counts.invalid}.`,
      `Still unchecked and checkable: ${r.unchecked}. Already in Instantly before checks existed (can't be checked now): ${r.pushedUnchecked}.`,
      `Per campaign: ${r.campaigns.map((c) => `"${c.name}": ${c.verified} verified, ${c.catch_all} catch-all, ${c.invalid} invalid`).join("; ") || "none"}.`,
      `Companies with the most catch-all addresses: ${r.catchAllDomains.slice(0, 6).map((d) => `${d.domain} (${d.n})`).join(", ") || "none"}.`,
      `GHL: ${r.ghl.connected ? "connected" : "not connected"}. Tagged so far: ${r.ghl.tagged.verified} verified, ${r.ghl.tagged.catch_all} catch-all, ${r.ghl.tagged.invalid} invalid.`,
      `Available actions in the console: tag verified contacts in GHL "email verified"; tag catch-all contacts "email catch-all"; remove invalid leads from the console and tag the GHL contact "email invalid", or also delete those contacts from GHL.`,
    ].join("\n");
    const text = await llmText({
      system:
        "You are a cold-email deliverability lead writing for the account owner of a small B2B outreach client. British English, plain text, no headings, no bullet lists, no markdown. " +
        "Write three short paragraphs, under 180 words in total: (1) what the check found and what it says about the list quality, with the key percentages; " +
        "(2) what each group means for deliverability (verified = safe; catch-all = unconfirmed, send in small batches after the verified group; invalid = would bounce, already rejected); " +
        "(3) the recommended next actions in order, using only the actions listed. Use only the facts given; never invent numbers.",
      user: facts,
      effort: "low",
    });
    await setSetting(`verify_summary_${clientId}`, JSON.stringify({ text, at: new Date().toISOString(), model: llmLabel() }));
  } catch (e) {
    const msg = (e as Error).message;
    await setSetting(
      `verify_summary_error_${clientId}`,
      /401|Incorrect API key|invalid.*key|authentication/i.test(msg) ? `${llmLabel()} rejected the API key. Fix ${llmKeyHint()} in Vercel, then try again.` : msg,
    );
  }
}

// ---------- GHL actions ----------

/** Queue tagging in GHL for every verified or catch-all lead not tagged yet. Returns how many. */
export async function queueGhlTagging(clientId: number, outcome: "verified" | "catch_all"): Promise<number> {
  return (await run(
    "UPDATE leads SET ghl_verification_tag = 'queued_tag' WHERE client_id = ? AND verification = ? AND ghl_contact_id IS NOT NULL AND ghl_verification_tag IS NULL",
    clientId, outcome,
  )).changes;
}

/**
 * Queue removal of a group's leads from the console. Invalid: tag the GHL contact "email invalid", or delete it.
 * Catch-all: only the delete option exists (keeping them is what the tag is for). Leads already in Instantly are left alone.
 */
export async function queueRemoval(clientId: number, outcome: "invalid" | "catch_all", deleteInGhl: boolean): Promise<number> {
  if (outcome === "catch_all" && !deleteInGhl) return 0;
  return (await run(
    `UPDATE leads SET ghl_verification_tag = ? WHERE client_id = ? AND verification = ?
     AND pushed_at IS NULL AND instantly_lead_id IS NULL AND (ghl_verification_tag IS NULL OR ghl_verification_tag = 'done')`,
    deleteInGhl ? "queued_delete" : "queued_remove", clientId, outcome,
  )).changes;
}

export async function runVerificationActions() {
  await withLock("verify_actions", 10 * 60_000, actAll);
}

type Pick = { id: number; client_id: number; email: string; verification: Outcome; ghl_contact_id: string | null; ghl_verification_tag: string };

async function actAll() {
  const deadline = Date.now() + BUDGET_MS;
  const stopped = new Set<number>();
  const tally = new Map<number, { tagged: number; removed: number; deleted: number }>();
  const creds = new Map<number, NonNullable<ReturnType<typeof ghlCreds>> | null>();
  const credsFor = async (clientId: number) => {
    if (!creds.has(clientId)) creds.set(clientId, ghlCreds(await requireClient(clientId)));
    return creds.get(clientId)!;
  };

  while (Date.now() < deadline) {
    const skip = stopped.size ? `AND client_id NOT IN (${[...stopped].join(",")})` : "";
    const batch = await all<Pick>(
      `SELECT id, client_id, email, verification, ghl_contact_id, ghl_verification_tag FROM leads WHERE ghl_verification_tag LIKE 'queued%' ${skip} ORDER BY id LIMIT ?`,
      CONCURRENCY,
    );
    if (batch.length === 0) break;

    const results = await Promise.allSettled(batch.map(async (l) => actOnLead(l, await credsFor(l.client_id))));
    for (const [i, r] of results.entries()) {
      const lead = batch[i];
      const t = tally.get(lead.client_id) ?? { tagged: 0, removed: 0, deleted: 0 };
      tally.set(lead.client_id, t);
      if (r.status === "fulfilled") {
        t[r.value]++;
        continue;
      }
      const e = r.reason as Error;
      const status = e instanceof GhlError ? e.status : 0;
      if (status === 401 || status === 403) {
        if (stopped.has(lead.client_id)) continue;
        stopped.add(lead.client_id);
        await run("UPDATE leads SET ghl_verification_tag = NULL WHERE client_id = ? AND ghl_verification_tag LIKE 'queued%'", lead.client_id);
        await setSetting(`verify_actions_error_${lead.client_id}`, `GHL refused (${e.message}). Check the GHL token in Settings, then try again.`);
        await logActivity(lead.client_id, "error", `GHL tagging stopped: ${e.message}`);
      } else {
        await run("UPDATE leads SET ghl_verification_tag = NULL WHERE id = ?", lead.id);
        await logActivity(lead.client_id, "error", `Couldn't update ${lead.email} in GHL: ${e.message}`);
      }
    }
    if (results.every((r) => r.status === "rejected")) break;
  }

  for (const [clientId, t] of tally) {
    if (!t.tagged && !t.removed && !t.deleted) continue;
    await run("DELETE FROM settings WHERE key = ?", `verify_actions_error_${clientId}`);
    const parts = [
      t.tagged ? `tagged ${t.tagged} contacts in GHL` : "",
      t.removed ? `removed ${t.removed} invalid leads (tagged "${GHL_TAGS.invalid}" in GHL)` : "",
      t.deleted ? `removed ${t.deleted} invalid leads and deleted their GHL contacts` : "",
    ].filter(Boolean);
    await logActivity(clientId, "verify", `Email verification follow-up: ${parts.join(", ")}`);
  }
}

async function actOnLead(l: Pick, creds: NonNullable<ReturnType<typeof ghlCreds>> | null): Promise<"tagged" | "removed" | "deleted"> {
  if (l.ghl_verification_tag === "queued_tag") {
    if (creds && l.ghl_contact_id) await addContactTags(creds, l.ghl_contact_id, [GHL_TAGS[l.verification]]);
    await run("UPDATE leads SET ghl_verification_tag = 'done' WHERE id = ?", l.id);
    return "tagged";
  }
  if (l.ghl_verification_tag === "queued_delete") {
    if (creds && l.ghl_contact_id) {
      await deleteContact(creds, l.ghl_contact_id);
      await run("DELETE FROM ghl_contacts WHERE client_id = ? AND contact_id = ?", l.client_id, l.ghl_contact_id);
    }
    await run("DELETE FROM leads WHERE id = ?", l.id); // drafts go with it (ON DELETE CASCADE)
    return "deleted";
  }
  // queued_remove
  if (creds && l.ghl_contact_id) await addContactTags(creds, l.ghl_contact_id, [GHL_TAGS.invalid]);
  await run("DELETE FROM leads WHERE id = ?", l.id);
  return "removed";
}
