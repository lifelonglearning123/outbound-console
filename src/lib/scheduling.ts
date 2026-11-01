import "server-only";
import { all, get, run, logActivity } from "./db";
import { requireClient } from "./clients";
import { isNexus, pushedLeadCount, requireCampaign, setCampaignRunning } from "./campaigns";
import { instantly } from "./instantly";
import { DO_NOT_CONTACT, STOPPED_OUTSIDE } from "./leads";
import { mailboxHealth } from "./mailboxHealth";
import { pushApproved } from "./push";
import { startLabel, zonedToUtc } from "./startTime";

/**
 * Starting a campaign at a time picked in advance. The console does the starting, rather than Instantly's own start
 * date, so nothing is in Instantly early: approved contacts stay here (pushApproved holds them) and are checked again
 * when they go. If the start can't happen, nothing is sent and the campaign says why.
 */

const YEAR_MS = 365 * 86400_000;
/** The sync can be down for a while. A campaign that has missed its time by more than this waits for someone to decide. */
const TOO_LATE_MS = 86400_000;

export async function scheduleStart(campaignId: number, local: string) {
  const c = await requireCampaign(campaignId);
  if (isNexus(c)) throw new Error("Nexus decides when this campaign starts.");
  if (!c.managed || c.status !== "draft" || !c.instantly_campaign_id) throw new Error("Only a campaign that hasn't started can be scheduled.");
  const at = zonedToUtc(local, c.schedule.timezone);
  if (at.getTime() <= Date.now()) throw new Error("Pick a time in the future.");
  if (at.getTime() > Date.now() + YEAR_MS) throw new Error("Pick a time within the next year.");
  await run("UPDATE campaigns SET start_at = ?, start_problem = NULL WHERE id = ?", at.toISOString(), campaignId);
  await logActivity(c.client_id, "campaign", `Scheduled "${c.name}" to start ${startLabel(at, c.schedule.timezone)}`);
}

export async function cancelStart(campaignId: number) {
  const c = await requireCampaign(campaignId);
  await run("UPDATE campaigns SET start_at = NULL, start_problem = NULL WHERE id = ?", campaignId);
  if (c.start_at) await logActivity(c.client_id, "campaign", `Cancelled the scheduled start of "${c.name}"`);
}

/** Each sync: start the client's campaigns whose time has come. A failure that may be passing is tried again next sync. */
export async function startDueCampaigns(clientId: number) {
  // Started some other way (Instantly directly): the schedule no longer means anything.
  await run("UPDATE campaigns SET start_at = NULL WHERE client_id = ? AND start_at IS NOT NULL AND status <> 'draft'", clientId);
  const due = await all<{ id: number }>(
    "SELECT id FROM campaigns WHERE client_id = ? AND managed = 1 AND status = 'draft' AND start_at IS NOT NULL AND start_at <= ? ORDER BY start_at",
    clientId, new Date().toISOString(),
  );
  for (const { id } of due) {
    try {
      await startCampaign(id);
    } catch (e) {
      // One campaign's trouble mustn't hold up another's start.
      await logActivity(clientId, "error", `Couldn't start campaign ${id} as scheduled, trying again at the next sync: ${(e as Error).message}`);
    }
  }
}

async function startCampaign(id: number) {
  const c = await requireCampaign(id);
  const notStarted = async (why: string) => {
    await run("UPDATE campaigns SET start_at = NULL, start_problem = ? WHERE id = ?", why, id);
    await logActivity(c.client_id, "error", `"${c.name}" didn't start as scheduled: ${why}`);
  };
  if (Date.now() - Date.parse(c.start_at!) > TOO_LATE_MS) {
    return notStarted(`it missed its start time by more than a day (${startLabel(new Date(c.start_at!), c.schedule.timezone)}), so it's waiting for you to pick a new time or start it.`);
  }
  const boxes = await mailboxHealth(c.client_id);
  if (!boxes.some((m) => c.accounts.includes(m.email) && (m.state.key === "sending" || m.state.key === "easing"))) {
    return notStarted("none of its mailboxes can send right now. Nothing was sent.");
  }
  await dropStoppedContacts(id);
  let sent = 0;
  for (;;) {
    const r = await pushApproved(id, { starting: true });
    if (r.pushed === 0) break;
    sent += r.pushed;
  }
  if ((await pushedLeadCount(id)) === 0) return notStarted("it has no approved contacts that can be sent. Nothing was sent.");

  await setCampaignRunning(id, true);
  const waiting = (await get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND stage = 'review'", id))?.n ?? 0;
  await logActivity(
    c.client_id, "resume",
    `Started "${c.name}" as scheduled, handing ${sent} approved contacts to the sender` + (waiting ? `. ${waiting} more still need approving.` : "."),
  );
}

/**
 * Contacts handed to Instantly before the campaign was scheduled were checked then, not now. Nobody has been emailed
 * yet, so anyone who has since bounced, replied or unsubscribed can still come out.
 */
async function dropStoppedContacts(id: number) {
  const c = await requireCampaign(id);
  const stopped = await all<{ id: number; instantly_lead_id: string }>(
    `SELECT l.id, l.instantly_lead_id FROM leads l WHERE l.campaign_id = ? AND l.instantly_lead_id IS NOT NULL
       AND (${STOPPED_OUTSIDE("l")} OR EXISTS (SELECT 1 FROM leads o WHERE o.client_id = l.client_id AND o.email = l.email AND o.id <> l.id AND ${DO_NOT_CONTACT("o")}))`,
    id,
  );
  if (stopped.length === 0) return;
  const api = instantly((await requireClient(c.client_id)).instantly_api_key!);
  for (const l of stopped) {
    await api.deleteLead(l.instantly_lead_id);
    await run(
      "UPDATE leads SET stage = 'rejected', stage_message = ?, pushed_at = NULL, instantly_lead_id = NULL WHERE id = ?",
      "Not sent: replied, bounced or unsubscribed since being approved", l.id,
    );
    await run("UPDATE drafts SET status = 'rejected', reviewed_at = datetime('now') WHERE lead_id = ? AND status IN ('pending', 'approved')", l.id);
  }
  await logActivity(c.client_id, "push", `Took ${stopped.length} contacts out of "${c.name}" before it started: they replied, bounced or unsubscribed since being approved`);
}
