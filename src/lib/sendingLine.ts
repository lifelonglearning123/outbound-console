import "server-only";
import { get } from "./db";
import type { Campaign } from "./campaigns";
import { toDate } from "./format";
import { nextSendWords, startLabel, utcToZoned, zonedToUtc } from "./startTime";

/**
 * One line for a campaign that's switched on, answering "when is the next email?" and "when did the last one go?".
 * The first part comes from the campaign's own sending days and hours; Instantly's reason for not sending is only
 * shown when it's something the hours don't explain.
 */
export async function sendingLine(c: Campaign): Promise<{ text: string; tone: string; last: string }> {
  const now = new Date();
  const tz = c.schedule.timezone;
  const today = utcToZoned(now, tz).slice(0, 10);
  const dayStart = zonedToUtc(`${today}T00:00`, tz).toISOString();
  const sent = await get<{ last: string | null; today: number; total: number; sender: string | null }>(
    `SELECT MAX(sent_at) last, COUNT(*) FILTER (WHERE sent_at >= ?) today, COUNT(*) total,
       (array_agg(account_email ORDER BY sent_at DESC))[1] sender
     FROM emails WHERE campaign_id = ? AND direction = 'out'`,
    dayStart, c.id,
  );
  const sentToday = Number(sent?.today ?? 0);
  const total = Number(sent?.total ?? 0);

  // Instantly's reason is from the last sync: yesterday's "daily limit" says nothing about today.
  const fresh = !!c.last_synced_at && utcToZoned(toDate(c.last_synced_at), tz).slice(0, 10) === today;
  const reason = fresh ? c.not_sending : null;
  const capHit = !!reason && /daily (sending )?limit/i.test(reason);
  const next = nextSendWords(now, c.schedule, capHit);

  let text: string;
  let tone = "text-ink";
  if (capHit) {
    text = `Today's ${c.daily_limit.toLocaleString("en-GB")} ${c.daily_limit === 1 ? "email is" : "emails are"} sent.${next ? ` Next ones go out ${next.when}.` : ""}`;
  } else if (reason && !/outside scheduled sending hours/i.test(reason)) {
    // Something the hours don't explain (nobody left to email, a mailbox limit): say it as Instantly does.
    text = `${reason}.`;
    tone = "text-wait";
  } else if (!next) {
    text = "No sending days are ticked, so nothing goes out.";
    tone = "text-wait";
  } else if (next.sendingNow) {
    text = `Sending ${next.when}.`;
    tone = "text-go";
  } else {
    text = `${total === 0 ? "First emails go" : "Next emails go"} out ${next.when}.`;
  }

  let last = "";
  if (sent?.last) {
    const at = toDate(sent.last);
    const time = utcToZoned(at, tz).slice(11, 16);
    const from = sent.sender ? ` from ${sent.sender}` : "";
    last = sentToday > 0
      ? `${sentToday.toLocaleString("en-GB")} sent today, the last at ${time}${from}.`
      : `Last email went ${startLabel(at, tz)}${from}.`;
  }
  return { text, tone, last };
}
