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
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (r.days - 1) * 86400_000);
  return { from: iso(from), to: iso(to), days: r.days, key: r.key, label: r.label };
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

function headline(s: Scope, r: Range): Headline {
  const p = { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, to: r.to, toEnd: `${r.to}T23:59:59.999Z` };
  const d = get<{ contacted: number; sent: number; replied: number; opened: number }>(
    `SELECT COALESCE(SUM(contacted),0) contacted, COALESCE(SUM(sent),0) sent, COALESCE(SUM(replied),0) replied, COALESCE(SUM(opened),0) opened
     FROM daily_stats WHERE client_id = @clientId ${camp(s)} AND date BETWEEN @from AND @to`,
    p,
  )!;
  const tagged = get<{ positive: number; unsubscribed: number }>(
    `SELECT COUNT(DISTINCT CASE WHEN interest = 'interested' THEN lead_email END) positive,
            COUNT(DISTINCT CASE WHEN interest = 'unsubscribe' THEN lead_email END) unsubscribed
     FROM emails WHERE client_id = @clientId ${camp(s)} AND direction = 'in' AND sent_at BETWEEN @from AND @toEnd`,
    p,
  )!;
  const meetings =
    get<{ n: number }>(
      `SELECT COUNT(DISTINCT m.lead_id) n FROM meetings m JOIN leads l ON l.id = m.lead_id
       WHERE m.client_id = @clientId ${camp(s, "l.campaign_id")} AND substr(m.booked_at, 1, 10) BETWEEN @from AND @to`,
      p,
    )?.n ?? 0;
  // Bounces are reported per mailbox. With a campaign selected, use that campaign's mailboxes.
  const boxes = s.campaignId
    ? `AND email IN (SELECT value FROM json_each((SELECT accounts FROM campaigns WHERE id = @campaignId)))`
    : "";
  const b = get<{ bounced: number; sent: number }>(
    `SELECT COALESCE(SUM(bounced),0) bounced, COALESCE(SUM(sent),0) sent FROM mailbox_daily
     WHERE client_id = @clientId ${boxes} AND date BETWEEN @from AND @to`,
    p,
  )!;
  return { ...d, ...tagged, meetings, bounced: b.bounced, bounceBase: b.sent };
}

export type Day = { date: string; sent: number; replied: number; positive: number };

function daily(s: Scope, r: Range): Day[] {
  const p = { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, to: r.to, toEnd: `${r.to}T23:59:59.999Z` };
  const base = new Map(
    all<{ date: string; sent: number; replied: number }>(
      `SELECT date, SUM(sent) sent, SUM(replied) replied FROM daily_stats
       WHERE client_id = @clientId ${camp(s)} AND date BETWEEN @from AND @to GROUP BY date`,
      p,
    ).map((d) => [d.date, d]),
  );
  const pos = new Map(
    all<{ date: string; n: number }>(
      `SELECT substr(sent_at, 1, 10) date, COUNT(DISTINCT lead_email) n FROM emails
       WHERE client_id = @clientId ${camp(s)} AND direction = 'in' AND interest = 'interested' AND sent_at BETWEEN @from AND @toEnd
       GROUP BY 1`,
      p,
    ).map((d) => [d.date, d.n]),
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
function steps(s: Scope): StepRow[] {
  return all<StepRow>(
    `SELECT c.name campaign, c.id campaignId, st.step, st.sent, st.replied, st.opened
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

function replyBreakdown(s: Scope, r: Range): { key: string; label: string; n: number }[] {
  const p = { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, toEnd: `${r.to}T23:59:59.999Z` };
  const counts = new Map(
    all<{ interest: string | null; n: number }>(
      `SELECT interest, COUNT(DISTINCT lead_email) n FROM emails
       WHERE client_id = @clientId ${camp(s)} AND direction = 'in' AND sent_at BETWEEN @from AND @toEnd GROUP BY interest`,
      p,
    ).map((x) => [x.interest ?? "other", x.n]),
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

function mailboxes(s: Scope, r: Range): MailboxRow[] {
  return all<MailboxRow>(
    `SELECT m.email, m.status, m.warmup_score, m.auto_paused_reason,
       COALESCE(SUM(d.sent),0) sent, COALESCE(SUM(d.bounced),0) bounced, COALESCE(SUM(d.replied),0) replied
     FROM mailboxes m LEFT JOIN mailbox_daily d ON d.client_id = m.client_id AND d.email = m.email AND d.date BETWEEN @from AND @to
     WHERE m.client_id = @clientId GROUP BY m.email ORDER BY sent DESC, m.email`,
    { clientId: s.clientId, from: r.from, to: r.to },
  );
}

/** Replies (not auto/out-of-office) by UK weekday (0 = Mon) and hour. */
function replyTimes(s: Scope, r: Range): number[][] {
  const rows = all<{ sent_at: string }>(
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

export type LeadRow = {
  id: number;
  name: string;
  email: string;
  company: string | null;
  campaign: string;
  steps_sent: number;
  last_sent: string | null;
  replied_at: string | null;
  interest: string | null;
  meeting_at: string | null;
  status: number | null;
};

export const LEAD_FILTERS = [
  { key: "all", label: "Everyone contacted" },
  { key: "interested_no_meeting", label: "Interested, no meeting yet" },
  { key: "meeting", label: "Meeting booked" },
  { key: "replied", label: "Replied" },
  { key: "no_reply", label: "No reply yet" },
  { key: "bounced", label: "Bounced / unsubscribed" },
] as const;

export function leadList(s: Scope, filter: string): LeadRow[] {
  const rows = all<LeadRow & { first_name: string | null; last_name: string | null }>(
    `SELECT l.id, l.first_name, l.last_name, l.email, l.company, c.name campaign, l.instantly_status status,
       (SELECT COUNT(DISTINCT e.step) FROM emails e WHERE e.lead_id = l.id AND e.direction = 'out') steps_sent,
       (SELECT MAX(e.sent_at) FROM emails e WHERE e.lead_id = l.id AND e.direction = 'out') last_sent,
       (SELECT MIN(e.sent_at) FROM emails e WHERE e.lead_id = l.id AND e.direction = 'in') replied_at,
       (SELECT e.interest FROM emails e WHERE e.lead_id = l.id AND e.direction = 'in' ORDER BY e.sent_at DESC LIMIT 1) interest,
       (SELECT MIN(m.booked_at) FROM meetings m WHERE m.lead_id = l.id) meeting_at
     FROM leads l JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.client_id = @clientId ${camp(s, "l.campaign_id")} AND l.instantly_lead_id IS NOT NULL
     ORDER BY COALESCE(meeting_at, replied_at, last_sent, l.pushed_at) DESC LIMIT 1000`,
    { clientId: s.clientId, campaignId: s.campaignId ?? 0 },
  ).map((l) => ({ ...l, name: [l.first_name, l.last_name].filter(Boolean).join(" ") || l.email }));
  const keep: Record<string, (l: LeadRow) => boolean> = {
    all: () => true,
    interested_no_meeting: (l) => l.interest === "interested" && !l.meeting_at,
    meeting: (l) => !!l.meeting_at,
    replied: (l) => !!l.replied_at,
    no_reply: (l) => !l.replied_at && !l.meeting_at && ![-1, -2].includes(l.status ?? 0),
    bounced: (l) => [-1, -2].includes(l.status ?? 0) || l.interest === "unsubscribe",
  };
  return rows.filter(keep[filter] ?? keep.all);
}

export type MeetingRow = { name: string; company: string | null; campaign: string; booked_at: string; starts_at: string | null; source: string };

function meetingList(s: Scope, r: Range): MeetingRow[] {
  return all<MeetingRow & { first_name: string | null; last_name: string | null; email: string }>(
    `SELECT l.first_name, l.last_name, l.email, l.company, c.name campaign, m.booked_at, m.starts_at, m.source
     FROM meetings m JOIN leads l ON l.id = m.lead_id JOIN campaigns c ON c.id = l.campaign_id
     WHERE m.client_id = @clientId ${camp(s, "l.campaign_id")} AND substr(m.booked_at, 1, 10) BETWEEN @from AND @to
     ORDER BY m.booked_at DESC`,
    { clientId: s.clientId, campaignId: s.campaignId ?? 0, from: r.from, to: r.to },
  ).map((m) => ({ ...m, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email }));
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

export function buildReport(clientId: number, rangeKey: string | undefined, campaignId: number | null): Report {
  const scope = { clientId, campaignId };
  const range = rangeFor(rangeKey);
  const prev = previous(range);
  return {
    range,
    previousRange: prev,
    now: headline(scope, range),
    before: headline(scope, prev),
    daily: daily(scope, range),
    steps: steps(scope),
    replies: replyBreakdown(scope, range),
    mailboxes: mailboxes(scope, range),
    replyTimes: replyTimes(scope, range),
    meetings: meetingList(scope, range),
    campaigns: all<{ id: number; name: string }>(
      "SELECT id, name FROM campaigns WHERE client_id = ? AND instantly_campaign_id IS NOT NULL ORDER BY created_at DESC",
      clientId,
    ),
    lastSync: get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `last_sync_${clientId}`)?.value ?? null,
  };
}
