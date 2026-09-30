import "server-only";
import { all, get } from "./db";

export type FunnelData = {
  approved: number;
  sent: number;
  opened: number;
  replied: number;
  interested: number;
  inGhl: number;
  bounced: number;
  mailboxSent: number; // bounce rate denominator: Instantly counts bounces per mailbox
  daily: { date: string; sent: number; replied: number }[];
};

/** Funnel for one client (or every client when clientId is null) over the last `days` days. */
export async function funnelFor(clientId: number | null, days: number): Promise<FunnelData> {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const scope = clientId === null ? "1 = 1" : "client_id = @clientId";
  const p = { clientId: clientId ?? 0, since };

  const totals =
    await get<{ sent: number; opened: number; replied: number }>(
      `SELECT COALESCE(SUM(sent),0) sent, COALESCE(SUM(opened),0) opened, COALESCE(SUM(replied),0) replied
       FROM daily_stats WHERE ${scope} AND date >= @since`,
      p,
    ) ?? { sent: 0, opened: 0, replied: 0 };
  // Instantly reports bounces per mailbox, not per campaign.
  const box =
    await get<{ bounced: number; sent: number }>(
      `SELECT COALESCE(SUM(bounced),0) bounced, COALESCE(SUM(sent),0) sent FROM mailbox_daily WHERE ${scope} AND date >= @since`,
      p,
    ) ?? { bounced: 0, sent: 0 };

  const approved =
    (await get<{ n: number }>(
      `SELECT COUNT(*) n FROM leads WHERE ${scope} AND stage IN ('approved','pushed') AND created_at >= @since`,
      p,
    ))?.n ?? 0;

  const replies =
    await get<{ interested: number; inGhl: number }>(
      `SELECT COUNT(DISTINCT CASE WHEN interest = 'interested' THEN lead_email END) interested,
              COUNT(DISTINCT CASE WHEN ghl_pushed_at IS NOT NULL THEN lead_email END) "inGhl"
       FROM emails WHERE ${scope} AND direction = 'in' AND sent_at >= @since`,
      p,
    ) ?? { interested: 0, inGhl: 0 };

  const daily = await all<{ date: string; sent: number; replied: number }>(
    `SELECT date, SUM(sent) sent, SUM(replied) replied FROM daily_stats
     WHERE ${scope} AND date >= @since GROUP BY date ORDER BY date`,
    p,
  );

  return { approved, ...totals, bounced: box.bounced, mailboxSent: box.sent, ...replies, daily };
}
