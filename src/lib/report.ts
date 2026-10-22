import "server-only";
import { all, get } from "./db";

// Every figure on the stats dashboard and the client report comes from here, so both always agree.
//
// Definitions (per period):
//   contacted  – new leads Instantly sent a first email to (daily "new_leads_contacted")
//   sent       – emails sent, all steps
//   replied    – unique replies, auto-replies excluded (Instantly)
//   positive   – leads whose reply was tagged Interested
//   meetings   – leads who booked in the client's GHL (calendar or meeting stage) after being emailed
//   rates      – divided by leads contacted
//   opened     – unique opens; shown with a caveat (Apple Mail inflates, Outlook blocks)

export type Range = { from: string; to: string; days: number; key: string; label: string };

export const RANGES = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
] as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function rangeFor(key: string | undefined, now = new Date()): Range {
  const r = RANGES.find((x) => x.key === key) ?? RANGES[1];
  return { ...lastDays(r.days, now), key: r.key, label: r.label };
}

/** The last `days` days up to today, for a chart that picks its own span (a campaign's life so far). */
export function lastDays(days: number, now = new Date()): Range {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (days - 1) * 86400_000);
  return { from: iso(from), to: iso(to), days, key: `${days}d`, label: `Last ${days} days` };
}

function previous(r: Range): Range {
  const to = new Date(Date.parse(r.from) - 86400_000);
  const from = new Date(to.getTime() - (r.days - 1) * 86400_000);
  return { ...r, from: iso(from), to: iso(to) };
}

export type Headline = {
  contacted: number;
  sent: number;
  replied: number;
  positive: number;
  meetings: number;
  opened: number;
  bounced: number;
  bounceBase: number; // emails sent from the same mailboxes, for the bounce rate
  unsubscribed: number;
};

type Scope = { clientId: number; campaignId: number | null };

/** Campaign filter for tables that carry campaign_id. */
const camp = (s: Scope, col = "campaign_id") => (s.campaignId ? `AND ${col} = @campaignId` : "");

async function headline(s: Scope, r: Range): Promise<Headline> {
  const p = { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, to: r.to, toEnd: `${r.to}T23:59:59.999Z` };
  const d = (await get<{ contacted: number; sent: number; replied: number; opened: number }>(
    `SELECT COALESCE(SUM(contacted),0) contacted, COALESCE(SUM(sent),0) sent, COALESCE(SUM(replied),0) replied, COALESCE(SUM(opened),0) opened
     FROM daily_stats WHERE client_id = @clientId ${camp(s)} AND date BETWEEN @from AND @to`,
    p,
  ))!;
  const tagged = (await get<{ positive: number; unsubscribed: number }>(
    `SELECT COUNT(DISTINCT CASE WHEN interest = 'interested' THEN lead_email END) positive,
            COUNT(DISTINCT CASE WHEN interest = 'unsubscribe' THEN lead_email END) unsubscribed
     FROM emails WHERE client_id = @clientId ${camp(s)} AND direction = 'in' AND sent_at BETWEEN @from AND @toEnd`,
    p,
  ))!;
  const meetings =
    (await get<{ n: number }>(
      `SELECT COUNT(DISTINCT m.lead_id) n FROM meetings m JOIN leads l ON l.id = m.lead_id
       WHERE m.client_id = @clientId ${camp(s, "l.campaign_id")} AND substr(m.booked_at, 1, 10) BETWEEN @from AND @to`,
      p,
    ))?.n ?? 0;
  // Bounces are reported per mailbox. With a campaign selected, use that campaign's mailboxes.
  const boxes = s.campaignId
    ? `AND email IN (SELECT json_array_elements_text(accounts::json) FROM campaigns WHERE id = @campaignId)`
    : "";
  const b = (await get<{ bounced: number; sent: number }>(
    `SELECT COALESCE(SUM(bounced),0) bounced, COALESCE(SUM(sent),0) sent FROM mailbox_daily
     WHERE client_id = @clientId ${boxes} AND date BETWEEN @from AND @to`,
    p,
  ))!;
  return { ...d, ...tagged, meetings, bounced: b.bounced, bounceBase: b.sent };
}

export type Day = { date: string; sent: number; replied: number; positive: number };

export async function daily(s: Scope, r: Range): Promise<Day[]> {
  const p = { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, to: r.to, toEnd: `${r.to}T23:59:59.999Z` };
  const base = new Map(
    (await all<{ date: string; sent: number; replied: number }>(
      `SELECT date, SUM(sent) sent, SUM(replied) replied FROM daily_stats
       WHERE client_id = @clientId ${camp(s)} AND date BETWEEN @from AND @to GROUP BY date`,
      p,
    )).map((d) => [d.date, d]),
  );
  const pos = new Map(
    (await all<{ date: string; n: number }>(
      `SELECT substr(sent_at, 1, 10) date, COUNT(DISTINCT lead_email) n FROM emails
       WHERE client_id = @clientId ${camp(s)} AND direction = 'in' AND interest = 'interested' AND sent_at BETWEEN @from AND @toEnd
       GROUP BY 1`,
      p,
    )).map((d) => [d.date, d.n]),
  );
  // Every day in the range, including quiet ones, so the chart's time axis is honest.
  const out: Day[] = [];
  for (let t = Date.parse(r.from); t <= Date.parse(r.to); t += 86400_000) {
    const date = iso(new Date(t));
    const b = base.get(date);
    out.push({ date, sent: b?.sent ?? 0, replied: b?.replied ?? 0, positive: pos.get(date) ?? 0 });
  }
  return out;
}

export type StepRow = { campaign: string; campaignId: number; step: number; sent: number; replied: number; opened: number };

/** Since launch: Instantly's per-step totals aren't split by day. */
async function steps(s: Scope): Promise<StepRow[]> {
  return await all<StepRow>(
    `SELECT c.name campaign, c.id "campaignId", st.step, st.sent, st.replied, st.opened
     FROM step_stats st JOIN campaigns c ON c.id = st.campaign_id
     WHERE c.client_id = @clientId ${camp(s, "c.id")} ORDER BY c.created_at DESC, st.step`,
    { clientId: s.clientId, campaignId: s.campaignId ?? 0 },
  );
}

export const REPLY_TYPES = [
  { key: "interested", label: "Interested" },
  { key: "not_now", label: "Not now" },
  { key: "not_interested", label: "Not interested" },
  { key: "wrong_person", label: "Wrong person" },
  { key: "ooo", label: "Out of office" },
  { key: "unsubscribe", label: "Unsubscribe" },
  { key: "other", label: "Other" },
] as const;

async function replyBreakdown(s: Scope, r: Range): Promise<{ key: string; label: string; n: number }[]> {
  const p = { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, toEnd: `${r.to}T23:59:59.999Z` };
  const counts = new Map(
    (await all<{ interest: string | null; n: number }>(
      `SELECT interest, COUNT(DISTINCT lead_email) n FROM emails
       WHERE client_id = @clientId ${camp(s)} AND direction = 'in' AND sent_at BETWEEN @from AND @toEnd GROUP BY interest`,
      p,
    )).map((x) => [x.interest ?? "other", x.n]),
  );
  return REPLY_TYPES.map((t) => ({ ...t, n: counts.get(t.key) ?? 0 }));
}

export type MailboxRow = {
  email: string;
  status: number | null;
  warmup_score: number | null;
  auto_paused_reason: string | null;
  sent: number;
  bounced: number;
  replied: number;
};

async function mailboxes(s: Scope, r: Range): Promise<MailboxRow[]> {
  return await all<MailboxRow>(
    `SELECT m.email, m.status, m.warmup_score, m.auto_paused_reason,
       COALESCE(SUM(d.sent),0) sent, COALESCE(SUM(d.bounced),0) bounced, COALESCE(SUM(d.replied),0) replied
     FROM mailboxes m LEFT JOIN mailbox_daily d ON d.client_id = m.client_id AND d.email = m.email AND d.date BETWEEN @from AND @to
     WHERE m.client_id = @clientId GROUP BY m.id ORDER BY sent DESC, m.email`,
    { clientId: s.clientId, from: r.from, to: r.to },
  );
}

/** Replies (not auto/out-of-office) by UK weekday (0 = Mon) and hour. */
async function replyTimes(s: Scope, r: Range): Promise<number[][]> {
  const rows = await all<{ sent_at: string }>(
    `SELECT sent_at FROM emails WHERE client_id = @clientId ${camp(s)} AND direction = 'in'
       AND COALESCE(interest, '') NOT IN ('ooo') AND sent_at BETWEEN @from AND @toEnd`,
    { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, toEnd: `${r.to}T23:59:59.999Z` },
  );
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", hour12: false });
  const dayIndex: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  for (const { sent_at } of rows) {
    const parts = fmt.formatToParts(new Date(sent_at));
    const wd = dayIndex[parts.find((x) => x.type === "weekday")?.value ?? ""];
    const hr = Number(parts.find((x) => x.type === "hour")?.value) % 24;
    if (wd !== undefined && Number.isFinite(hr)) grid[wd][hr]++;
  }
  return grid;
}

export type MeetingRow = { name: string; company: string | null; campaign: string; booked_at: string; starts_at: string | null; source: string };

async function meetingList(s: Scope, r: Range): Promise<MeetingRow[]> {
  return (await all<MeetingRow & { first_name: string | null; last_name: string | null; email: string }>(
    `SELECT l.first_name, l.last_name, l.email, l.company, c.name campaign, m.booked_at, m.starts_at, m.source
     FROM meetings m JOIN leads l ON l.id = m.lead_id JOIN campaigns c ON c.id = l.campaign_id
     WHERE m.client_id = @clientId ${camp(s, "l.campaign_id")} AND substr(m.booked_at, 1, 10) BETWEEN @from AND @to
     ORDER BY m.booked_at DESC`,
    { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, to: r.to },
  )).map((m) => ({ ...m, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email }));
}

export type Report = {
  range: Range;
  previousRange: Range;
  now: Headline;
  before: Headline;
  daily: Day[];
  steps: StepRow[];
  replies: { key: string; label: string; n: number }[];
  mailboxes: MailboxRow[];
  replyTimes: number[][];
  meetings: MeetingRow[];
  campaigns: { id: number; name: string }[];
  lastSync: string | null;
};

export async function buildReport(clientId: number, rangeKey: string | undefined, campaignId: number | null): Promise<Report> {
  const scope = { clientId, campaignId };
  const range = rangeFor(rangeKey);
  const prev = previous(range);
  return {
    range,
    previousRange: prev,
    now: await headline(scope, range),
    before: await headline(scope, prev),
    daily: await daily(scope, range),
    steps: await steps(scope),
    replies: await replyBreakdown(scope, range),
    mailboxes: await mailboxes(scope, range),
    replyTimes: await replyTimes(scope, range),
    meetings: await meetingList(scope, range),
    campaigns: await all<{ id: number; name: string }>(
      "SELECT id, name FROM campaigns WHERE client_id = ? AND instantly_campaign_id IS NOT NULL ORDER BY created_at DESC",
      clientId,
    ),
    lastSync: (await get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `last_sync_${clientId}`))?.value ?? null,
  };
}
