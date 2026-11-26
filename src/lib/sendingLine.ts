import "server-only";
import { get } from "./db";
import type { Campaign } from "./campaigns";
import type { SendingStatus } from "./instantly";
import { toDate } from "./format";
import { sendNotice, type SendNotice } from "./sendNotice";
import { utcToZoned, zonedToUtc } from "./startTime";

/**
 * Under a running campaign's name: how today is going in a few words ("5 sent today", "All 5 of today's emails are
 * sent", "Sending starts at 09:50"), and, only when something needs a person, a notice saying what.
 */
export async function sendingLine(c: Campaign): Promise<{ line: { text: string; tone: string } | null; notice: SendNotice | null }> {
  const now = new Date();
  const tz = c.schedule.timezone;
  const today = utcToZoned(now, tz).slice(0, 10);
  const sent = Number((await get<{ n: number }>(
    "SELECT COUNT(*) n FROM emails WHERE campaign_id = ? AND direction = 'out' AND sent_at >= ?",
    c.id, zonedToUtc(`${today}T00:00`, tz).toISOString(),
  ))?.n ?? 0);

  // The sending platform's own status, only if it's from today.
  let diag: SendingStatus | null = null;
  try {
    if (c.sending_diag && c.sending_diag_at && utcToZoned(toDate(c.sending_diag_at), tz).slice(0, 10) === today) diag = JSON.parse(c.sending_diag);
  } catch {}
  const code = diag?.summary?.status ?? null;
  const sentToday = Math.max(sent, diag?.diagnostics?.campaign_daily_limit?.sent ?? 0);
  const capHit = code === "daily_limit_met" || !!diag?.diagnostics?.campaign_daily_limit?.limit_hit || sentToday >= c.daily_limit;
  const notice = sendNotice(code, diag ? null : c.not_sending);

  const n = sentToday.toLocaleString("en-GB");
  let line: { text: string; tone: string } | null = null;
  if (capHit && sentToday > 0) {
    line = { text: `All ${n} of today's emails are sent.`, tone: "text-go" };
  } else if (sentToday > 0) {
    line = { text: `${n} sent today.`, tone: "text-ink" };
  } else if (c.schedule.days.includes(new Date(`${today}T12:00:00Z`).getUTCDay())) {
    const open = zonedToUtc(`${today}T${c.schedule.from}`, tz);
    const close = zonedToUtc(`${today}T${c.schedule.to}`, tz);
    if (now < open) line = { text: `Sending starts at ${c.schedule.from}.`, tone: "text-ink" };
    else if (now < close && !notice) line = { text: "Sending now.", tone: "text-go" };
  }
  return { line, notice };
}
