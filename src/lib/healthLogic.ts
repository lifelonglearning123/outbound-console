// The rules behind mailbox health, with no database or network, so every page and the sync apply the same ones and
// they can be read (and tested) on their own. mailboxHealth.ts feeds them real data and acts on the answers.

export type HealthRules = {
  bouncePct: number; // rest a mailbox whose bounce rate is over this…
  minSent: number; // …once it has sent at least this many emails…
  windowDays: number; // …counted over this many days
  minWarmupScore: number; // rest a mailbox whose warmup emails land in spam (score under this, warmup running)
  returnDays: number; // a resting mailbox goes back after looking healthy for this many days
  autoRest: boolean;
  autoReturn: boolean;
  easeIn: boolean; // ease a returning mailbox's daily limit up over two weeks
};

/** Instantly's own line: it pauses a campaign once it has sent 100 emails with over 5% bouncing. */
export const INSTANTLY_RULE = { bouncePct: 5, minSent: 100 };

export const DEFAULT_RULES: HealthRules = {
  bouncePct: INSTANTLY_RULE.bouncePct,
  minSent: INSTANTLY_RULE.minSent,
  windowDays: 14,
  minWarmupScore: 70,
  returnDays: 3,
  autoRest: true,
  autoReturn: true,
  easeIn: true,
};

export const DAY_MS = 86400_000;

/** Whole days from `from` to `now` (0 on the same day). Bare database timestamps are UTC. */
export function daysSince(from: string | null | undefined, now: number): number | null {
  if (!from) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(from) ? from : `${from.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : null;
}

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const pctText = (n: number, d: number) => {
  if (!d) return "–";
  if (!n) return "0%";
  const v = (n / d) * 100;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
};

// ---------- Easing in ----------

/** A returning or new mailbox's daily limit by day since easing in started, up to its usual limit by day 14. */
const RAMP: [day: number, limit: number][] = [[0, 5], [3, 10], [6, 15], [9, 20], [12, 25]];
export const RAMP_DAYS = 14;

export function rampLimit(day: number, target: number): number {
  if (day >= RAMP_DAYS) return target;
  let limit = RAMP[0][1];
  for (const [d, l] of RAMP) if (day >= d) limit = l;
  return Math.min(limit, target);
}

/** When the limit next goes up, and to what; null once it has reached the target. */
export function nextRampStep(day: number, target: number): { day: number; limit: number } | null {
  const now = rampLimit(day, target);
  for (let d = day + 1; d <= RAMP_DAYS; d++) {
    const l = rampLimit(d, target);
    if (l > now) return { day: d, limit: l };
  }
  return null;
}

// ---------- Warmup ----------

export type WarmupDay = { date: string; sent: number; inbox: number; spam: number };

export type WarmupSummary = {
  active: boolean; // sent warmup emails in the last 7 days
  sent7: number;
  inbox7: number;
  spam7: number;
  inboxShare7: number | null; // of the warmup emails sent in the last 7 days, the share that landed in the inbox
  falling: boolean; // that share fell three sending days running and is now under 90%
  spamRising: boolean; // 10% or more of the last 7 days' warmup emails went to spam
};

export function summariseWarmup(days: WarmupDay[], now: number): WarmupSummary {
  const since = isoDay(now - 6 * DAY_MS);
  const week = days.filter((d) => d.date >= since);
  const sent7 = week.reduce((a, d) => a + d.sent, 0);
  const inbox7 = week.reduce((a, d) => a + d.inbox, 0);
  const spam7 = week.reduce((a, d) => a + d.spam, 0);
  const sending = [...days].filter((d) => d.sent > 0).sort((a, b) => a.date.localeCompare(b.date)).slice(-3).map((d) => d.inbox / d.sent);
  const falling = sending.length === 3 && sending[0] > sending[1] && sending[1] > sending[2] && sending[2] < 0.9;
  return {
    active: sent7 > 0,
    sent7,
    inbox7,
    spam7,
    inboxShare7: sent7 ? inbox7 / sent7 : null,
    falling,
    spamRising: sent7 >= 20 && spam7 / sent7 >= 0.1,
  };
}

/**
 * Warmup only counts against a mailbox when warmup is actually running. Instantly reports a score of 0 for a
 * mailbox that sent no warmup emails (paused, say), which means "no data", not "landing in spam".
 */
export function warmupProblem(score: number | null, w: WarmupSummary, rules: HealthRules): string | null {
  if (!w.active || score === null || score >= rules.minWarmupScore) return null;
  return `warmup emails are landing in spam: health ${score} (minimum ${rules.minWarmupScore})`;
}

export function bounceProblem(sent: number, bounced: number, rules: HealthRules): string | null {
  if (sent < rules.minSent || (bounced / sent) * 100 <= rules.bouncePct) return null;
  return `bounce rate ${pctText(bounced, sent)} (${bounced} of ${sent} in the last ${rules.windowDays} days; limit ${rules.bouncePct}% after ${rules.minSent} sends)`;
}

// ---------- State ----------

export type Tone = "go" | "wait" | "bad" | "info" | "muted";
export type StateKey = "sending" | "easing" | "resting" | "paused" | "maintenance" | "error";

const ERROR_LABEL: Record<number, string> = { [-1]: "Connection error", [-2]: "Soft bounce error", [-3]: "Sending error" };

/** One word for where a mailbox is: what Instantly says, plus what the console is doing with it. */
export function mailboxState(m: { status: number | null; rested: boolean; easing: boolean }): { key: StateKey; label: string; tone: Tone } {
  if (m.status !== null && m.status < 0) return { key: "error", label: ERROR_LABEL[m.status] ?? "Error", tone: "bad" };
  if (m.status === 3) return { key: "maintenance", label: "Maintenance pause", tone: "wait" };
  if (m.status !== 1) return { key: "paused", label: "Paused", tone: "bad" };
  if (m.rested) return { key: "resting", label: "Resting", tone: "wait" };
  if (m.easing) return { key: "easing", label: "Easing in", tone: "info" };
  return { key: "sending", label: "Sending", tone: "go" };
}

// ---------- Readiness ----------

export type Readiness = { ready: boolean; label: string; tone: Tone; daysLeft: number | null };

/** Warmup usually needs about two weeks before a mailbox sends campaign emails. */
export const WARMUP_DAYS = 14;

/** Whether a mailbox is ready for campaign emails, in a few words. */
export function readiness(m: {
  status: number | null;
  warmupStatus: number | null;
  warmupAgeDays: number | null;
  score: number | null;
  warmup: WarmupSummary;
  rules: HealthRules;
}): Readiness {
  if (m.status !== null && m.status < 0) return { ready: false, label: "Not connected: fix it in Instantly", tone: "bad", daysLeft: null };
  if (m.warmupStatus === -1) return { ready: false, label: "Warmup banned by Instantly", tone: "bad", daysLeft: null };
  if (m.warmupStatus === -3) return { ready: false, label: "Warmup suspended by Instantly", tone: "bad", daysLeft: null };
  if (m.warmupStatus === 0) return { ready: false, label: "Warmup is off", tone: "bad", daysLeft: null };
  if (m.status === 2) return { ready: false, label: "Paused, so warmup isn't running", tone: "wait", daysLeft: null };
  if (m.warmupAgeDays !== null && m.warmupAgeDays < WARMUP_DAYS) {
    const left = WARMUP_DAYS - m.warmupAgeDays;
    return { ready: false, label: `Warming up, day ${m.warmupAgeDays + 1}: ready in about ${left} ${left === 1 ? "day" : "days"}`, tone: "wait", daysLeft: left };
  }
  if (!m.warmup.active) return { ready: false, label: "No warmup activity this week yet", tone: "wait", daysLeft: null };
  if (m.score !== null && m.score < m.rules.minWarmupScore) return { ready: false, label: `Warmup landing in spam (health ${m.score})`, tone: "bad", daysLeft: null };
  if (m.score !== null && m.score < 90) return { ready: true, label: `Ready, warmup health ${m.score}`, tone: "wait", daysLeft: 0 };
  return { ready: true, label: "Ready", tone: "go", daysLeft: 0 };
}

/** What the console suggests for a mailbox's daily campaign emails. */
export function suggestion(m: { readiness: Readiness; easing: boolean; resting: boolean; campaignSends7: number; dailyLimit: number | null }):
  { ease: boolean; text: string } | null {
  if (m.resting || m.easing) return null;
  if (!m.readiness.ready) return { ease: false, text: "Keep it out of campaigns until it's ready." };
  if (m.campaignSends7 === 0) return { ease: true, text: `Ease in: 5 a day, rising to ${m.dailyLimit ?? 30} over two weeks.` };
  return null;
}

// ---------- Recipients ----------

/** What to do about a mail filter, from how its contacts have done across the client's campaigns. */
export function filterAdvice(emailed: number, bounced: number): { verdict: "unknown" | "hold" | "risky" | "safe"; text: string; tone: Tone } {
  if (emailed < 10) {
    return { verdict: "unknown", tone: "muted", text: `${emailed ? `Only ${emailed} emailed so far` : "None emailed yet"}: too few to tell. A test of 10 would show.` };
  }
  const rate = (bounced / emailed) * 100;
  if (rate >= 20) return { verdict: "hold", tone: "bad", text: `Keep holding: ${pctText(bounced, emailed)} bounced (${bounced} of ${emailed}).` };
  if (rate > INSTANTLY_RULE.bouncePct) return { verdict: "risky", tone: "wait", text: `Risky: ${pctText(bounced, emailed)} bounced (${bounced} of ${emailed}). Hold, or send small tests.` };
  return { verdict: "safe", tone: "go", text: `Safe to send: ${pctText(bounced, emailed)} bounced (${bounced} of ${emailed}).` };
}

/** How many unconfirmed (catch-all) contacts to send at a time, from how earlier ones did. */
export function unconfirmedBatch(emailed: number, bounced: number, waiting: number): { size: number; text: string } {
  const cap = (n: number) => Math.min(n, waiting);
  if (emailed < 20) return { size: cap(10), text: `Start with 10: ${emailed ? `only ${emailed}` : "no"} unconfirmed contacts emailed so far, too few to judge.` };
  const rate = (bounced / emailed) * 100;
  if (rate > INSTANTLY_RULE.bouncePct) {
    return { size: 0, text: `Hold off: ${pctText(bounced, emailed)} of unconfirmed contacts bounced so far (${bounced} of ${emailed}), over Instantly's 5% line.` };
  }
  if (rate > 2) return { size: cap(20), text: `Small batches of 20: ${pctText(bounced, emailed)} bounced so far (${bounced} of ${emailed}).` };
  return { size: cap(50), text: `Batches of 50 look safe: ${pctText(bounced, emailed)} bounced so far (${bounced} of ${emailed}).` };
}
