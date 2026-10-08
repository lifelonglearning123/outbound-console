import "server-only";
import { all, get, run, tx, logActivity, setSetting, withLock } from "./db";
import { requireClient } from "./clients";
import { instantly, InstantlyError, type EmailVerification } from "./instantly";

/**
 * Email verification through Instantly, before a lead can be approved and pushed.
 *
 * Instantly has no bulk endpoint: each address is one POST that answers within ~10 seconds or comes back
 * "pending", which we poll later. So this runs like the writer: a resumable background job (one at a time
 * across server instances) that works through leads marked 'queued', within a time budget, and is picked up
 * again by the next page view or sync until nothing is left.
 *
 * Results, kept in leads.verification:
 *   verified   the address exists
 *   catch_all  the domain accepts anything, so the address can't be confirmed (a reviewer flag is added)
 *   invalid    the address doesn't exist; the lead is rejected unless it's already in Instantly
 *   pending    Instantly is still checking
 */

const CONCURRENCY = 5;
const BUDGET_MS = 240_000; // under the 300s function limit, leaving room for the response
const POLL_AFTER_MS = 15_000; // how long to leave a pending check before asking Instantly again
const CATCH_ALL_FLAG = "Catch-all domain: Instantly couldn't confirm this address exists";

export const VERIFICATION_LABEL: Record<string, string> = {
  queued: "Checking…",
  pending: "Checking…",
  verified: "Verified",
  catch_all: "Catch-all",
  invalid: "Invalid",
};

/** Leads that can still be checked: not yet in Instantly, not rejected, never checked. */
const CHECKABLE = `pushed_at IS NULL AND instantly_lead_id IS NULL AND stage NOT IN ('rejected', 'removed') AND verification IS NULL`;

export async function uncheckedCount(campaignId: number): Promise<number> {
  return (await get<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND ${CHECKABLE}`, campaignId))?.n ?? 0;
}

/** Mark every checkable lead of a campaign for verification. Returns how many. */
export async function queueVerification(campaignId: number): Promise<number> {
  return (await run(`UPDATE leads SET verification = 'queued' WHERE campaign_id = ? AND ${CHECKABLE}`, campaignId)).changes;
}

/** Verify queued leads and poll pending ones. Safe to call repeatedly; returns at once if a run is already going. */
export async function runVerifier() {
  await withLock("verifier", 10 * 60_000, verifyAll);
}

type Pick = { id: number; client_id: number; email: string; verification: string };
type Tally = { verified: number; catch_all: number; invalid: number };

async function verifyAll() {
  const deadline = Date.now() + BUDGET_MS;
  const tallies = new Map<number, Tally>();
  const stopped = new Set<number>(); // clients whose key or plan can't verify right now
  const apis = new Map<number, ReturnType<typeof instantly>>();
  const api = async (clientId: number) => {
    let a = apis.get(clientId);
    if (!a) {
      const client = await requireClient(clientId);
      if (!client.instantly_api_key) throw new Error("No Instantly key");
      a = instantly(client.instantly_api_key);
      apis.set(clientId, a);
    }
    return a;
  };

  while (Date.now() < deadline) {
    const skip = stopped.size ? `AND client_id NOT IN (${[...stopped].join(",")})` : "";
    // New checks first; pending ones only once they've had time to finish on Instantly's side.
    let batch = await all<Pick>(`SELECT id, client_id, email, verification FROM leads WHERE verification = 'queued' ${skip} ORDER BY id LIMIT ?`, CONCURRENCY);
    if (batch.length === 0) {
      const cutoff = new Date(Date.now() - POLL_AFTER_MS).toISOString();
      batch = await all<Pick>(
        `SELECT id, client_id, email, verification FROM leads WHERE verification = 'pending' ${skip} AND (verified_at IS NULL OR verified_at < ?) ORDER BY verified_at LIMIT ?`,
        cutoff, CONCURRENCY,
      );
    }
    if (batch.length === 0) {
      const waiting = (await get<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE verification = 'pending' ${skip}`))?.n ?? 0;
      if (!waiting || Date.now() + 5000 > deadline) break;
      await new Promise((r) => setTimeout(r, 5000)); // give Instantly a moment, then poll again
      continue;
    }

    const results = await Promise.allSettled(
      batch.map(async (l) => {
        const a = await api(l.client_id);
        return l.verification === "queued" ? a.verifyEmail(l.email) : a.verification(l.email);
      }),
    );
    for (const [i, r] of results.entries()) {
      const lead = batch[i];
      if (r.status === "fulfilled") {
        const outcome = await applyResult(lead, r.value);
        if (outcome) {
          const t = tallies.get(lead.client_id) ?? { verified: 0, catch_all: 0, invalid: 0 };
          t[outcome]++;
          tallies.set(lead.client_id, t);
        }
        continue;
      }
      const e = r.reason as Error;
      const status = e instanceof InstantlyError ? e.status : 0;
      if (status === 402 || status === 401 || status === 403) {
        // No credits, no paid plan, or a key without the verification scope: stop this client, leave its leads unchecked.
        if (stopped.has(lead.client_id)) continue;
        stopped.add(lead.client_id);
        const why = /credit/i.test(e.message)
          ? "Instantly has no verification credits left. Buy a credit pack in Instantly (Settings → Billing), then click Check again."
          : /scope/i.test(e.message) || status === 403
            ? `Instantly refused (${e.message}). The API key needs the email verification scope.`
            : `Instantly refused (${e.message}).`;
        await run("UPDATE leads SET verification = NULL WHERE client_id = ? AND verification = 'queued'", lead.client_id);
        await setSetting(`verify_error_${lead.client_id}`, why);
        await logActivity(lead.client_id, "error", `Email verification stopped: ${why}`);
      } else if (status === 404 && lead.verification === "pending") {
        await run("UPDATE leads SET verification = 'queued', verified_at = NULL WHERE id = ?", lead.id); // Instantly lost the job; ask again
      } else {
        await run("UPDATE leads SET verification = NULL, verified_at = NULL WHERE id = ?", lead.id);
        await logActivity(lead.client_id, "error", `Couldn't verify ${lead.email}: ${e.message}`);
      }
    }
    // If everything in a batch failed the problem isn't the leads; stop rather than churn.
    if (results.every((r) => r.status === "rejected")) break;
  }

  for (const [clientId, t] of tallies) {
    await logActivity(
      clientId,
      "verify",
      `Checked ${t.verified + t.catch_all + t.invalid} email addresses: ${t.verified} verified, ${t.catch_all} catch-all, ${t.invalid} invalid (rejected)`,
    );
  }
}

/** Record one verification answer on its lead. Returns the final outcome, or null while still pending. */
async function applyResult(lead: Pick, v: EmailVerification): Promise<keyof Tally | null> {
  const now = new Date().toISOString();
  if (v.credits !== null && v.credits !== undefined) await setSetting(`verify_credits_${lead.client_id}`, String(v.credits));
  await run("DELETE FROM settings WHERE key = ?", `verify_error_${lead.client_id}`); // it's working again

  if (v.verification_status === "pending") {
    await run("UPDATE leads SET verification = 'pending', verified_at = ? WHERE id = ?", now, lead.id);
    return null;
  }
  if (v.verification_status === "invalid") {
    await tx(async () => {
      await run("UPDATE leads SET verification = 'invalid', verified_at = ? WHERE id = ?", now, lead.id);
      // Only leads that haven't reached Instantly are rejected; a pushed lead keeps whatever Instantly does with it.
      const changed = (await run(
        `UPDATE leads SET stage = 'rejected', stage_message = 'Invalid email address (Instantly verification)'
         WHERE id = ? AND pushed_at IS NULL AND instantly_lead_id IS NULL AND stage NOT IN ('rejected', 'removed')`,
        lead.id,
      )).changes;
      if (changed) await run("UPDATE drafts SET status = 'rejected', reviewed_at = ? WHERE lead_id = ? AND status IN ('pending', 'approved')", now, lead.id);
    });
    return "invalid";
  }
  if (v.catch_all === true) {
    await tx(async () => {
      await run("UPDATE leads SET verification = 'catch_all', verified_at = ? WHERE id = ?", now, lead.id);
      // Flag the first email so the reviewer sees it, and so "approve all unflagged" leaves it alone.
      await run(
        `UPDATE drafts SET flags = CASE WHEN flags IS NULL OR flags = '' THEN ? ELSE flags || ' · ' || ? END
         WHERE lead_id = ? AND step = 1 AND status = 'pending' AND (flags IS NULL OR flags NOT LIKE ?)`,
        CATCH_ALL_FLAG, CATCH_ALL_FLAG, lead.id, `%${CATCH_ALL_FLAG}%`,
      );
    });
    return "catch_all";
  }
  await run("UPDATE leads SET verification = 'verified', verified_at = ? WHERE id = ?", now, lead.id);
  return "verified";
}

export { CATCH_ALL_FLAG };
