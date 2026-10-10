import "server-only";
import { all, get, run, tx, logActivity } from "./db";
import { requireCampaign } from "./campaigns";
import { pushApproved } from "./push";
import { CATCH_ALL_FLAG } from "./verify";

/**
 * The campaign page's progress strip and batch approval. Both read the same lead table the rest of the app
 * uses, but describe it the way the user thinks: contacts added, addresses checked, emails approved, sent, replies.
 */

export type Progress = {
  contacts: number; // everyone added, minus removed
  checked: number; // addresses checked (any outcome)
  verified: number;
  catchAll: number; // unable to verify
  invalid: number;
  ready: number; // verified, email prepared, needs the go: "Ready to send"
  unconfirmed: number; // unable to verify, email prepared: can be sent in small batches
  waiting: number; // ready + unconfirmed (every contact a person could approve)
  approved: number; // approved (not yet sent) + already sending
  sending: number; // handed to the sender
  sent: number; // emails sent so far (all steps)
  replies: number; // contacts who replied
  preparing: number; // emails being written right now
  checking: number; // addresses being checked right now
  updatingPortal: number; // Nexus Portal tags / deletions still to do
};

export async function campaignProgress(campaignId: number): Promise<Progress> {
  const l = (await get<Omit<Progress, "sent" | "replies">>(
    `SELECT COUNT(*) FILTER (WHERE stage <> 'removed') contacts,
       COUNT(*) FILTER (WHERE verification IN ('verified', 'catch_all', 'invalid')) checked,
       COUNT(*) FILTER (WHERE verification = 'verified') verified,
       COUNT(*) FILTER (WHERE verification = 'catch_all') "catchAll",
       COUNT(*) FILTER (WHERE verification = 'invalid') invalid,
       COUNT(*) FILTER (WHERE stage IN ('review', 'extend_review') AND verification = 'verified') ready,
       COUNT(*) FILTER (WHERE stage IN ('review', 'extend_review') AND verification = 'catch_all') unconfirmed,
       COUNT(*) FILTER (WHERE stage IN ('review', 'extend_review') AND verification IN ('verified', 'catch_all')) waiting,
       COUNT(*) FILTER (WHERE stage IN ('approved', 'pushed') OR stage LIKE 'extend_%') approved,
       COUNT(*) FILTER (WHERE stage = 'pushed' OR stage LIKE 'extend_%') sending,
       COUNT(*) FILTER (WHERE stage IN ('drafting', 'extending')) preparing,
       COUNT(*) FILTER (WHERE verification IN ('queued', 'pending')) checking,
       COUNT(*) FILTER (WHERE ghl_verification_tag LIKE 'queued%') "updatingPortal"
     FROM leads WHERE campaign_id = ?`,
    campaignId,
  ))!;
  const s = (await get<{ sent: number }>("SELECT COALESCE(SUM(sent), 0) sent FROM daily_stats WHERE campaign_id = ?", campaignId))!;
  const r = (await get<{ replies: number }>("SELECT COUNT(DISTINCT lead_email) replies FROM emails WHERE campaign_id = ? AND direction = 'in'", campaignId))!;
  return { ...l, sent: s.sent, replies: r.replies };
}

// ---------- Batch approval (campaigns whose every email is the client's own text) ----------

export type BatchGroup = "verified" | "catch_all";

export type BatchInfo = {
  fixed: boolean; // every step is the client's own email, so one approval covers everyone
  groups: Record<BatchGroup, number>; // contacts ready for a decision, by address check result
  checking: number; // contacts still being checked (can't be approved yet)
  flagged: number; // ready contacts with a note other than "unable to verify" (missing name, placeholder…)
  sample: { subject: string; body: string; format: string; email: string } | null; // one contact's email, for the preview
  approvedNotSent: number;
};

const WAITING = `stage = 'review'`;

export async function batchInfo(campaignId: number): Promise<BatchInfo> {
  const c = await requireCampaign(campaignId);
  const fixed = c.steps.length > 0 && c.steps.every((s) => s.mode === "fixed");
  const g = (await get<{ verified: number; catch_all: number; checking: number; flagged: number; approved: number }>(
    `SELECT COUNT(*) FILTER (WHERE ${WAITING} AND verification = 'verified') verified,
       COUNT(*) FILTER (WHERE ${WAITING} AND verification = 'catch_all') catch_all,
       COUNT(*) FILTER (WHERE verification IN ('queued', 'pending')) checking,
       COUNT(*) FILTER (WHERE ${WAITING} AND verification IN ('verified', 'catch_all') AND EXISTS (
         SELECT 1 FROM drafts d WHERE d.lead_id = leads.id AND d.flags IS NOT NULL AND replace(d.flags, ?, '') ~ '[A-Za-z]')) flagged,
       COUNT(*) FILTER (WHERE stage = 'approved') approved
     FROM leads WHERE campaign_id = ?`,
    CATCH_ALL_FLAG, campaignId,
  ))!;
  const sample = await get<{ subject: string; body: string; format: string; email: string }>(
    `SELECT d.subject, d.body, d.format, l.email FROM drafts d JOIN leads l ON l.id = d.lead_id
     WHERE l.campaign_id = ? AND l.${WAITING} AND d.step = 1 ORDER BY l.verification = 'verified' DESC, l.id LIMIT 1`,
    campaignId,
  );
  return {
    fixed,
    groups: { verified: g.verified, catch_all: g.catch_all },
    checking: g.checking,
    flagged: g.flagged,
    sample: sample ?? null,
    approvedNotSent: g.approved,
  };
}

/**
 * Approve the waiting contacts of one group (up to `limit`) and hand them to the sender. Only for fixed-email
 * campaigns, where every contact gets the same text, so one look at the preview is the review.
 */
export async function approveAndSend(campaignId: number, group: BatchGroup, limit: number | null): Promise<{ approved: number; pushed: number; skipped: number }> {
  const c = await requireCampaign(campaignId);
  if (!c.steps.every((s) => s.mode === "fixed")) throw new Error("This campaign has AI-written emails; approve them one by one on the Approve tab.");
  const cond = group === "verified" ? "verification = 'verified'" : "verification = 'catch_all'";
  const ids = (await all<{ id: number }>(
    `SELECT id FROM leads WHERE campaign_id = ? AND ${WAITING} AND ${cond} ORDER BY id ${limit ? "LIMIT ?" : ""}`,
    ...(limit ? [campaignId, limit] : [campaignId]),
  )).map((r) => r.id);
  if (ids.length === 0) return { approved: 0, pushed: 0, skipped: 0 };
  await tx(async () => {
    const marks = ids.map(() => "?").join(",");
    await run(`UPDATE drafts SET status = 'approved', reviewed_at = datetime('now') WHERE lead_id IN (${marks}) AND status = 'pending'`, ...ids);
    await run(`UPDATE leads SET stage = 'approved' WHERE id IN (${marks}) AND stage = 'review'`, ...ids);
  });
  const label = group === "verified" ? "verified" : "unconfirmed";
  await logActivity(c.client_id, "approve", `Approved ${ids.length} ${label} contacts in "${c.name}" in one go`);
  const r = await pushApproved(campaignId);
  return { approved: ids.length, pushed: r.pushed, skipped: r.skipped };
}
