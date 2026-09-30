import "server-only";
import { all, get, run, tx, logActivity } from "./db";
import { requireClient } from "./clients";
import { requireCampaign, liveSteps, syncCampaignToInstantly, campaignStepProblems } from "./campaigns";
import { instantly } from "./instantly";
import { copyVars } from "./push";
import { campaignState } from "./connection";

// A hold keeps the steps after it out of Instantly. Releasing it:
//   1. prepare  – every lead already in Instantly (and still in play) gets its next emails written;
//   2. review   – you approve or reject those emails in Approvals, like any other;
//   3. apply    – the campaign is paused, each approved lead gets its new copy, rejected leads are removed
//                 from the campaign, the new steps are added, and sending resumes.
// Instantly re-activates finished leads when steps are added, and times each new step from when the
// previous one was sent (help.instantly.ai "How to Add New Steps to an Active Campaign").

export type HoldStatus = {
  live: number;
  total: number;
  releaseTo: number | null;
  writing: number;
  review: number;
  approved: number;
  rejected: number;
  failed: number;
  waitingOnHold: number;
};

export function holdStatus(campaignId: number): HoldStatus {
  const c = requireCampaign(campaignId);
  const n = (stage: string) =>
    get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND stage = ?", campaignId, stage)?.n ?? 0;
  return {
    live: liveSteps(c),
    total: c.steps.length,
    releaseTo: c.release_to,
    writing: n("extending"),
    review: n("extend_review"),
    approved: n("extend_approved"),
    rejected: n("extend_rejected"),
    failed: n("extend_error"),
    waitingOnHold: get<{ n: number }>(
      `SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND stage = 'pushed' AND last_reply_at IS NULL
         AND COALESCE(instantly_status, 1) NOT IN (-1, -2, -3)`,
      campaignId,
    )?.n ?? 0,
  };
}

/** Step 1: write the next emails for every lead that will receive them. */
export function prepareRelease(campaignId: number, upTo: number) {
  const c = requireCampaign(campaignId);
  const live = liveSteps(c);
  if (c.release_to) throw new Error("A release is already in progress");
  if (upTo <= live || upTo > c.steps.length) throw new Error(`Pick a step between ${live + 1} and ${c.steps.length}`);
  const problems = campaignStepProblems(c.steps.slice(0, upTo));
  if (problems.length) throw new Error(`Finish these steps first: ${problems.join("; ")}`);

  tx(() => {
    run("UPDATE campaigns SET release_to = ? WHERE id = ?", upTo, campaignId);
    // Leads already in Instantly and still in play: they will get the new steps.
    const n = run(
      `UPDATE leads SET stage = 'extending', stage_message = NULL
       WHERE campaign_id = ? AND stage = 'pushed' AND instantly_lead_id IS NOT NULL AND last_reply_at IS NULL
         AND COALESCE(instantly_status, 1) NOT IN (-1, -2, -3)`,
      campaignId,
    ).changes;
    // Leads not sent yet but already written: add the new steps to what they have.
    run("UPDATE leads SET stage = 'drafting' WHERE campaign_id = ? AND stage IN ('review', 'approved')", campaignId);
    logActivity(c.client_id, "hold", `Releasing the hold on "${c.name}" up to step ${upTo}: writing the next emails for ${n} leads`);
  });
}

/** Undo a prepared release: throw away the new drafts and leave the hold where it was. */
export function cancelRelease(campaignId: number) {
  const c = requireCampaign(campaignId);
  const live = liveSteps(c);
  tx(() => {
    run(
      `DELETE FROM drafts WHERE step > ? AND lead_id IN (SELECT id FROM leads WHERE campaign_id = ?)`,
      live, campaignId,
    );
    run(
      `UPDATE leads SET stage = 'pushed', stage_message = NULL
       WHERE campaign_id = ? AND stage IN ('extending', 'extend_review', 'extend_approved', 'extend_rejected', 'extend_error')`,
      campaignId,
    );
    run("UPDATE campaigns SET release_to = NULL WHERE id = ?", campaignId);
  });
  logActivity(c.client_id, "hold", `Cancelled releasing the hold on "${c.name}"`);
}

export function retryFailed(campaignId: number) {
  run("UPDATE leads SET stage = 'extending', stage_message = NULL WHERE campaign_id = ? AND stage = 'extend_error'", campaignId);
}

/** Step 3: put the approved emails and the new steps into Instantly. */
export async function applyRelease(campaignId: number): Promise<string> {
  const c = requireCampaign(campaignId);
  if (!c.release_to || !c.instantly_campaign_id) throw new Error("Nothing to release");
  const s = holdStatus(campaignId);
  if (s.writing || s.review || s.failed) {
    throw new Error("Every lead's next emails must be written and reviewed (approved or rejected) first");
  }
  const client = requireClient(c.client_id);
  const api = instantly(client.instantly_api_key!);
  const upTo = c.release_to;

  // Instantly asks for the campaign to be paused while steps are added.
  const wasActive = c.status === "active";
  if (wasActive) await api.pause(c.instantly_campaign_id);
  run("UPDATE campaigns SET release_resume = ? WHERE id = ?", wasActive ? 1 : 0, campaignId);

  let updated = 0;
  let removed = 0;
  try {
    // Every approved lead gets its new copy before the steps exist, so nobody can get a blank email.
    const approved = all<{ id: number; instantly_lead_id: string }>(
      "SELECT id, instantly_lead_id FROM leads WHERE campaign_id = ? AND stage = 'extend_approved'",
      campaignId,
    );
    for (const l of approved) {
      const drafts = all<{ step: number; subject: string; body: string; format: string }>(
        "SELECT step, subject, body, format FROM drafts WHERE lead_id = ? AND step <= ? AND status = 'approved' ORDER BY step",
        l.id, upTo,
      );
      if (drafts.length < upTo) throw new Error(`Lead ${l.id} is missing approved copy for some steps`);
      await api.patchLeadVars(l.instantly_lead_id, copyVars(drafts));
      run("UPDATE leads SET stage = 'pushed' WHERE id = ?", l.id);
      updated++;
    }
    // Rejected for the next emails: take them out of the campaign so they can't get a blank one.
    const rejected = all<{ id: number; instantly_lead_id: string }>(
      "SELECT id, instantly_lead_id FROM leads WHERE campaign_id = ? AND stage = 'extend_rejected'",
      campaignId,
    );
    for (const l of rejected) {
      await api.deleteLead(l.instantly_lead_id);
      run(
        "UPDATE leads SET stage = 'removed', stage_message = 'Removed from the campaign when the hold was released' WHERE id = ?",
        l.id,
      );
      removed++;
    }

    run("UPDATE campaigns SET hold_after = ?, release_to = NULL WHERE id = ?", upTo, campaignId);
    await syncCampaignToInstantly(campaignId);
  } finally {
    if (wasActive) {
      const remote = await api.activate(c.instantly_campaign_id);
      run("UPDATE campaigns SET status = ?, instantly_status = ? WHERE id = ?", campaignState(remote.status), remote.status, campaignId);
    }
  }
  const msg =
    `Released "${c.name}" up to step ${upTo}: ${updated} leads will get the new emails` +
    (removed ? `, ${removed} removed from the campaign` : "") +
    (wasActive ? ". Sending resumed." : ". The campaign is still paused; launch it when ready.");
  logActivity(c.client_id, "hold", msg);
  return msg;
}
