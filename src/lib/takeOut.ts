import "server-only";
import { all, run, logActivity } from "./db";
import { requireClient } from "./clients";
import { isNexus, requireCampaign } from "./campaigns";
import { instantly, InstantlyError } from "./instantly";

/**
 * Who can be taken out of a campaign, as SQL on a leads row `a`: anyone not removed whose sequence isn't over. That
 * includes contacts already with the sender, part-way through or not emailed yet. Someone who finished, bounced or
 * unsubscribed has nothing left to stop, and stays as the campaign's record.
 */
export const CAN_TAKE_OUT = (a: string) =>
  `(${a}.stage <> 'removed' AND (NOT (${a}.pushed_at IS NOT NULL OR ${a}.instantly_lead_id IS NOT NULL) OR COALESCE(${a}.instantly_status, 1) NOT IN (3, -3, -1, -2)))`;

/**
 * With the sender and not emailed yet, as SQL on a leads row `a`: nothing has gone to them, so pausing the campaign
 * leaves them held by it. The emails table is checked too, because the last-sent time can be up to half an hour behind.
 */
export const UNSENT = (a: string) =>
  `(${a}.instantly_lead_id IS NOT NULL AND ${a}.stage <> 'removed' AND COALESCE(${a}.instantly_status, 1) = 1 AND ${a}.last_sent_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = ${a}.id AND e.direction = 'out'))`;

export async function unsentCount(campaignId: number): Promise<number> {
  return Number((await all<{ n: number }>(`SELECT COUNT(*) n FROM leads a WHERE a.campaign_id = ? AND ${UNSENT("a")}`, campaignId))[0]?.n ?? 0);
}

/** Take back everyone the campaign has handed over but not yet emailed, so another campaign can have them. */
export async function releaseUnsent(campaignId: number) {
  const ids = (await all<{ id: number }>(`SELECT a.id FROM leads a WHERE a.campaign_id = ? AND ${UNSENT("a")}`, campaignId)).map((r) => r.id);
  return takeOut(campaignId, ids, "Released when the campaign was paused, before they were emailed");
}

/**
 * Take contacts out of a campaign so it emails them nothing more and another campaign can have them. Anyone already
 * with the sender is deleted there first, and only marked removed here once that worked, so nobody is shown as out
 * while Instantly could still email them. Nothing is deleted here: their record and any emails already sent stay.
 */
export async function takeOut(campaignId: number, ids: number[], why: string): Promise<{ removed: number; fromSender: number; failed: number }> {
  const c = await requireCampaign(campaignId);
  const result = { removed: 0, fromSender: 0, failed: 0 };
  if (ids.length === 0) return result;
  const leads = await all<{ id: number; instantly_lead_id: string | null; handed: boolean }>(
    `SELECT a.id, a.instantly_lead_id, (a.pushed_at IS NOT NULL OR a.instantly_lead_id IS NOT NULL) handed
     FROM leads a WHERE a.campaign_id = ? AND a.id = ANY(?) AND ${CAN_TAKE_OUT("a")} ORDER BY a.id`,
    campaignId, ids,
  );
  // Nexus hands its own people over and takes them back; here only the ones it hasn't handed over can go.
  const mine = leads.filter((l) => !l.handed || !isNexus(c));
  const waitingHere = mine.filter((l) => !l.handed).map((l) => l.id);
  if (waitingHere.length) {
    result.removed += (await run("UPDATE leads SET stage = 'removed', stage_message = ? WHERE id = ANY(?)", why, waitingHere)).changes;
  }

  const withSender = mine.filter((l) => l.handed);
  if (withSender.length) {
    const api = instantly((await requireClient(c.client_id)).instantly_api_key!);
    for (let i = 0; i < withSender.length; i += 5) {
      await Promise.all(withSender.slice(i, i + 5).map(async (l) => {
        try {
          if (l.instantly_lead_id) await api.deleteLead(l.instantly_lead_id);
        } catch (e) {
          // Already gone from Instantly is what we wanted; anything else leaves them in, so they stay as they are here.
          if (!(e instanceof InstantlyError && e.status === 404)) {
            result.failed++;
            return;
          }
        }
        await run("UPDATE leads SET stage = 'removed', stage_message = ? WHERE id = ?", `${why}. Taken back from the sender, so this campaign emails them nothing more.`, l.id);
        result.removed++;
        result.fromSender++;
      }));
    }
  }
  if (result.removed || result.failed) {
    await logActivity(
      c.client_id, "import",
      `Took ${result.removed} ${result.removed === 1 ? "contact" : "contacts"} out of "${c.name}"` +
        (result.fromSender ? ` (${result.fromSender} already with the sender, removed there too)` : "") +
        (result.failed ? `. ${result.failed} couldn't be removed from the sender, so they stay in; try again` : ""),
    );
  }
  return result;
}
