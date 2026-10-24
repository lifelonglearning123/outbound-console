import "server-only";
import { all, get, run, tx, getSetting, logActivity } from "./db";
import { requireClient } from "./clients";
import { instantly, type InstantlyClient } from "./instantly";
import {
  DAY_MS, DEFAULT_RULES, RAMP_DAYS, bounceProblem, daysSince, isoDay, mailboxState, nextRampStep, rampLimit, readiness, suggestion,
  summariseWarmup, warmupProblem, type HealthRules, type Readiness, type StateKey, type Tone, type WarmupDay, type WarmupSummary,
} from "./healthLogic";

/**
 * Mailbox health, in one place for every page and the sync, so the numbers always agree.
 *
 * The console never pauses a mailbox in Instantly by itself: a paused mailbox stops warming up, its warmup score falls
 * to 0, and a warmup rule would then keep it paused for good. Instead it *rests* a mailbox that breaks the rules: takes
 * it out of the client's campaigns in Instantly (remembered in mailbox_rests) while its warmup keeps running, and puts
 * it back into the same campaigns once it has looked healthy for a few days, easing its daily limit up over two weeks.
 * The rules are never stricter than Instantly's own (a campaign over 5% bounces after 100 sends).
 */

export type { HealthRules };
export type RestKind = "bounce" | "warmup" | "paused" | "manual";

const num = async (key: string, fallback: number) => Number(await getSetting(key, String(fallback)));
const flag = async (key: string, fallback: boolean) => (await getSetting(key, fallback ? "1" : "0")) === "1";

export async function healthRules(): Promise<HealthRules> {
  return {
    bouncePct: await num("health_bounce_limit", DEFAULT_RULES.bouncePct),
    minSent: await num("health_min_sends", DEFAULT_RULES.minSent),
    windowDays: await num("health_window_days", DEFAULT_RULES.windowDays),
    minWarmupScore: await num("health_min_warmup", DEFAULT_RULES.minWarmupScore),
    returnDays: await num("health_return_days", DEFAULT_RULES.returnDays),
    autoRest: await flag("health_auto_rest", DEFAULT_RULES.autoRest),
    autoReturn: await flag("health_auto_return", DEFAULT_RULES.autoReturn),
    easeIn: await flag("health_ease_in", DEFAULT_RULES.easeIn),
  };
}

// ---------- Reading ----------

export type MailboxHealth = {
  clientId: number;
  client: string;
  email: string;
  domain: string;
  /** Who hosts the mailbox, from Instantly's provider code: matters for ESP matching. */
  provider: "google" | "microsoft" | "other" | null;
  status: number | null;
  state: { key: StateKey; label: string; tone: Tone };
  /** One sentence: why it's in this state, and what happens next. */
  detail: string | null;
  warmupStatus: number | null;
  score: number | null;
  warmupAgeDays: number | null;
  warmup: WarmupSummary;
  /** The last 14 days of warmup, oldest first, quiet days included. */
  trend: WarmupDay[];
  sentToday: number;
  dailyLimit: number | null;
  campaignSends7: number;
  /** Campaign emails and bounces counted by the bounce rule (the window, from when it last came back). */
  window: { sent: number; bounced: number };
  bounceProblem: string | null;
  warmupProblem: string | null;
  rest: { at: string; kind: RestKind; reason: string | null; healthySince: string | null; returnsInDays: number | null; out: string[] } | null;
  ramp: { target: number; day: number; limit: number; next: { date: string; limit: number } | null; fullBy: string } | null;
  error: string | null;
  note: string | null;
  campaigns: { id: number; name: string; status: string; resting: boolean }[];
  readiness: Readiness;
  suggestion: { ease: boolean; text: string } | null;
  /** Paused by the old rules, so its warmup stopped. "Bring back" rebuilds it. */
  stuck: boolean;
  autoPausedAt: string | null;
};

type Row = {
  client_id: number; client: string; email: string; status: number | null; warmup_status: number | null; warmup_score: number | null;
  daily_limit: number | null; sent_today: number | null; rested_at: string | null; rest_reason: string | null; rest_kind: RestKind | null;
  healthy_since: string | null; health_note: string | null; ramp_target: number | null; ramp_started_at: string | null;
  status_message: string | null; warmup_started_at: string | null; auto_paused_at: string | null; auto_paused_reason: string | null;
  provider_code: number | null; w_sent: number; w_bounced: number; c_sent7: number;
};

// Instantly's provider codes (docs/instantly-api.md): 2 Google, 3 Microsoft; the rest are other kinds of mailbox.
const PROVIDER: Record<number, "google" | "microsoft"> = { 2: "google", 3: "microsoft" };

const fmtDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtWhen = (v: string) => fmtDay(Date.parse(/[zZ]$/.test(v) ? v : `${v.replace(" ", "T")}Z`));
export const quoteList = (names: string[]) =>
  names.length <= 1 ? names.map((n) => `"${n}"`).join("") : `${names.slice(0, -1).map((n) => `"${n}"`).join(", ")} and "${names.at(-1)}"`;
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Every mailbox of one client (or of every client, for the cross-client page), with its health worked out.
 * `scopeSql` narrows it further (a client login's own clients).
 */
export async function mailboxHealth(clientId: number | null, opts: { scopeSql?: string; rules?: HealthRules } = {}): Promise<MailboxHealth[]> {
  const rules = opts.rules ?? (await healthRules());
  const now = Date.now();
  const since = isoDay(now - (rules.windowDays - 1) * DAY_MS);
  const week = isoDay(now - 6 * DAY_MS);
  const trendFrom = isoDay(now - 13 * DAY_MS);
  const p = { clientId: clientId ?? 0, since, week, trendFrom };
  const one = clientId ? "AND m.client_id = @clientId" : "";
  const rows = await all<Row>(
    `SELECT m.client_id, c.name client, m.email, m.status, m.warmup_status, m.warmup_score, m.daily_limit, m.sent_today,
       m.rested_at, m.rest_reason, m.rest_kind, m.healthy_since, m.health_note, m.ramp_target, m.ramp_started_at,
       m.status_message, m.warmup_started_at, m.auto_paused_at, m.auto_paused_reason, m.provider_code,
       COALESCE(w.sent, 0) w_sent, COALESCE(w.bounced, 0) w_bounced, COALESCE(w.sent7, 0) c_sent7
     FROM mailboxes m JOIN clients c ON c.id = m.client_id
     LEFT JOIN LATERAL (
       SELECT SUM(d.sent) FILTER (WHERE d.date >= GREATEST(@since::text, COALESCE(substr(m.returned_at, 1, 10), ''))) sent,
              SUM(d.bounced) FILTER (WHERE d.date >= GREATEST(@since::text, COALESCE(substr(m.returned_at, 1, 10), ''))) bounced,
              SUM(d.sent) FILTER (WHERE d.date >= @week::text) sent7
       FROM mailbox_daily d WHERE d.client_id = m.client_id AND d.email = m.email AND d.date >= LEAST(@since::text, @week::text)
     ) w ON TRUE
     WHERE c.archived = 0 ${one} ${opts.scopeSql ?? ""}
     ORDER BY lower(c.name), split_part(m.email, '@', 2), m.email`,
    p,
  );
  if (rows.length === 0) return [];
  const clientFilter = clientId ? "AND client_id = @clientId" : "";
  const days = await all<WarmupDay & { client_id: number; email: string }>(
    `SELECT client_id, email, date, sent, inbox, spam FROM warmup_daily WHERE date >= @trendFrom::text ${clientFilter}`,
    p,
  );
  const campaigns = await all<{ id: number; client_id: number; name: string; status: string; accounts: string }>(
    `SELECT id, client_id, name, status, accounts FROM campaigns
     WHERE instantly_campaign_id IS NOT NULL AND status IN ('active', 'paused') ${clientFilter} ORDER BY status = 'active' DESC, name`,
    p,
  );
  const rests = await all<{ client_id: number; email: string; campaign_id: number }>(
    `SELECT client_id, email, campaign_id FROM mailbox_rests WHERE TRUE ${clientFilter}`,
    p,
  );
  const parsed = campaigns.map((c) => {
    let accounts: string[] = [];
    try {
      accounts = JSON.parse(c.accounts || "[]");
    } catch {}
    return { ...c, accounts };
  });

  return rows.map((r) => {
    const mine = days.filter((d) => d.client_id === r.client_id && d.email === r.email);
    const trend: WarmupDay[] = [];
    for (let i = 13; i >= 0; i--) {
      const date = isoDay(now - i * DAY_MS);
      const d = mine.find((x) => x.date === date);
      trend.push({ date, sent: d?.sent ?? 0, inbox: d?.inbox ?? 0, spam: d?.spam ?? 0 });
    }
    const warmup = summariseWarmup(mine, now);
    // No warmup history stored yet (the first sync after an update): a score above 0 still means warmup is running.
    if (mine.length === 0 && (r.warmup_score ?? 0) > 0) warmup.active = true;
    const restRows = rests.filter((x) => x.client_id === r.client_id && x.email === r.email);
    const inCampaigns = parsed
      .filter((c) => c.client_id === r.client_id && c.accounts.includes(r.email))
      .map((c) => ({ id: c.id, name: c.name, status: c.status, resting: restRows.some((x) => x.campaign_id === c.id) }));
    const warmupAgeDays = daysSince(r.warmup_started_at, now);
    const bp = bounceProblem(Number(r.w_sent), Number(r.w_bounced), rules);
    const wp = warmupProblem(r.warmup_score, warmup, rules);

    const rest = r.rested_at
      ? {
          at: r.rested_at,
          kind: (r.rest_kind ?? "manual") as RestKind,
          reason: r.rest_reason,
          healthySince: r.healthy_since,
          returnsInDays: r.healthy_since ? Math.max(0, rules.returnDays - (daysSince(r.healthy_since, now) ?? 0)) : null,
          out: inCampaigns.filter((c) => c.resting).map((c) => c.name),
        }
      : null;
    const rampDay = daysSince(r.ramp_started_at, now);
    const ramp = r.ramp_target && r.ramp_started_at && rampDay !== null
      ? (() => {
          const started = Date.parse(/[zZ]$/.test(r.ramp_started_at!) ? r.ramp_started_at! : `${r.ramp_started_at!.replace(" ", "T")}Z`);
          const next = nextRampStep(rampDay, r.ramp_target!);
          return {
            target: r.ramp_target!,
            day: rampDay,
            limit: rampLimit(rampDay, r.ramp_target!),
            next: next ? { date: isoDay(started + next.day * DAY_MS), limit: next.limit } : null,
            fullBy: isoDay(started + RAMP_DAYS * DAY_MS),
          };
        })()
      : null;
    const state = mailboxState({ status: r.status, rested: !!rest, easing: !!ramp });
    const stuck = r.status === 2 && !!r.auto_paused_at;
    const ready = readiness({ status: r.status, warmupStatus: r.warmup_status, warmupAgeDays, score: r.warmup_score, warmup, rules });

    let detail: string | null = null;
    if (state.key === "error") {
      detail = `Instantly reports: ${r.status_message ?? "it can't connect to the mailbox"}. Nothing sends from it until it's fixed in Instantly.`;
    } else if (state.key === "maintenance") {
      detail = "Instantly paused it for maintenance; it resumes by itself.";
    } else if (state.key === "paused") {
      detail = stuck
        ? `Paused by the console on ${fmtWhen(r.auto_paused_at!)} (${r.auto_paused_reason ?? "health rules"}). A paused mailbox doesn't warm up, so its score can't recover: bring it back to rebuild it.`
        : "Paused in Instantly: it sends no campaign emails and no warmup.";
    } else if (rest) {
      const why = rest.reason ? `${sentence(rest.reason)}. ` : "";
      const where = rest.out.length ? `Out of ${quoteList(rest.out)} since ${fmtWhen(rest.at)}` : `Resting since ${fmtWhen(rest.at)}`;
      const back = rest.kind === "manual"
        ? " Put it back when you're ready."
        : !rules.autoReturn
          ? " Automatic return is off, so put it back when you're ready."
          : rest.returnsInDays !== null
            ? rest.returnsInDays === 0
              ? " Goes back at the next sync."
              : ` Back in about ${rest.returnsInDays} ${rest.returnsInDays === 1 ? "day" : "days"} if it stays healthy.`
            : rest.kind === "bounce"
              ? ` Goes back once its warmup has looked healthy for ${rules.returnDays} days.`
              : ` Goes back once its warmup health has been ${rules.minWarmupScore} or more for ${rules.returnDays} days.`;
      detail = `${why}${where}; warmup keeps running.${back}`;
    } else if (ramp) {
      detail = `Easing in: ${ramp.limit} a day now${ramp.next ? `, ${ramp.next.limit} from ${fmtDay(Date.parse(ramp.next.date))}` : ""}, up to ${ramp.target} by ${fmtDay(Date.parse(ramp.fullBy))}.`;
    } else if (r.health_note) {
      detail = r.health_note;
    } else if (bp || wp) {
      detail = `${sentence((bp ?? wp)!)}. Automatic resting is off, so it keeps sending.`;
    }

    return {
      clientId: r.client_id,
      client: r.client,
      email: r.email,
      domain: r.email.split("@")[1] ?? "",
      provider: r.provider_code === null ? null : PROVIDER[r.provider_code] ?? "other",
      status: r.status,
      state,
      detail,
      warmupStatus: r.warmup_status,
      score: r.warmup_score,
      warmupAgeDays,
      warmup,
      trend,
      sentToday: r.sent_today ?? 0,
      dailyLimit: r.daily_limit,
      campaignSends7: Number(r.c_sent7),
      window: { sent: Number(r.w_sent), bounced: Number(r.w_bounced) },
      bounceProblem: bp,
      warmupProblem: wp,
      rest,
      ramp,
      error: r.status !== null && r.status < 0 ? r.status_message : null,
      note: r.health_note,
      campaigns: inCampaigns,
      readiness: ready,
      suggestion: state.key === "sending"
        ? suggestion({ readiness: ready, easing: false, resting: false, campaignSends7: Number(r.c_sent7), dailyLimit: r.daily_limit })
        : null,
      stuck,
      autoPausedAt: r.auto_paused_at,
    };
  });
}

export async function oneMailbox(clientId: number, email: string): Promise<MailboxHealth | undefined> {
  return (await mailboxHealth(clientId)).find((m) => m.email === email);
}

// ---------- Acting ----------

async function apiFor(clientId: number): Promise<InstantlyClient> {
  const client = await requireClient(clientId);
  if (!client.instantly_api_key) throw new Error("This client has no Instantly key");
  return instantly(client.instantly_api_key);
}

/** The client's campaigns in Instantly that use this mailbox and could send (active or paused). */
async function campaignsWith(clientId: number, email: string) {
  const rows = await all<{ id: number; name: string; status: string; instantly_campaign_id: string; accounts: string }>(
    `SELECT id, name, status, instantly_campaign_id, accounts FROM campaigns
     WHERE client_id = ? AND instantly_campaign_id IS NOT NULL AND status IN ('active', 'paused')`,
    clientId,
  );
  return rows.filter((c) => {
    try {
      return (JSON.parse(c.accounts || "[]") as string[]).includes(email);
    } catch {
      return false;
    }
  });
}

/** Mailboxes the client can send from right now: active in Instantly and not resting. */
async function workingMailboxes(clientId: number): Promise<Set<string>> {
  return new Set((await all<{ email: string }>(
    "SELECT email FROM mailboxes WHERE client_id = ? AND status = 1 AND rested_at IS NULL", clientId,
  )).map((r) => r.email));
}

const addRestRow = (clientId: number, email: string, campaignId: number) =>
  run(
    "INSERT INTO mailbox_rests (client_id, email, campaign_id, removed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    clientId, email, campaignId, new Date().toISOString(),
  );

/**
 * Take a mailbox out of the client's campaigns in Instantly; its warmup keeps running. It stays in any active campaign
 * it's the only working mailbox of (a campaign can't send from nothing; Instantly's own bounce protection still covers it).
 */
export async function restMailbox(
  clientId: number, email: string, kind: RestKind, reason: string, by: "auto" | "you",
  opts: { api?: InstantlyClient; quiet?: boolean } = {},
): Promise<{ rested: boolean; out: string[]; kept: string[] }> {
  const api = opts.api ?? (await apiFor(clientId));
  const working = await workingMailboxes(clientId);
  working.delete(email);
  const out: string[] = [];
  const kept: string[] = [];
  for (const c of await campaignsWith(clientId, email)) {
    const list = (await api.campaign(c.instantly_campaign_id)).email_list ?? [];
    if (!list.includes(email)) {
      await addRestRow(clientId, email, c.id); // chosen here but already out of Instantly's list: it goes back there too
      out.push(c.name);
      continue;
    }
    if (!list.some((e) => e !== email && working.has(e))) {
      if (c.status === "active") kept.push(c.name);
      continue;
    }
    await api.patchCampaign(c.instantly_campaign_id, { email_list: list.filter((e) => e !== email) });
    await addRestRow(clientId, email, c.id);
    out.push(c.name);
  }
  if (out.length === 0 && kept.length > 0) {
    const note = `${sentence(reason)}, but it's the only working mailbox on ${quoteList(kept)}, so it keeps sending there. Instantly's own bounce protection still watches ${kept.length === 1 ? "that campaign" : "those campaigns"}.`;
    await run("UPDATE mailboxes SET health_note = ? WHERE client_id = ? AND email = ?", note, clientId, email);
    return { rested: false, out, kept };
  }
  await run(
    `UPDATE mailboxes SET rested_at = ?, rest_kind = ?, rest_reason = ?, healthy_since = NULL, health_note = ?
     WHERE client_id = ? AND email = ?`,
    new Date().toISOString(), kind, reason, kept.length ? `Still in ${quoteList(kept)}: it's the only working mailbox there.` : null,
    clientId, email,
  );
  if (!opts.quiet) {
    await logActivity(
      clientId, "rest",
      `${by === "auto" ? "Rested" : "You rested"} ${email}: ${reason}. ${out.length ? `Taken out of ${quoteList(out)}` : "It's in no campaign"}; ` +
        `warmup keeps running${kind === "manual" ? "" : ", and it goes back by itself once it's healthy"}.`,
      { subject: email, undo: "return" },
    );
  }
  return { rested: true, out, kept };
}

/** Put a resting mailbox back into the campaigns it was taken out of, optionally easing its daily limit up again. */
export async function returnMailbox(clientId: number, email: string, by: "auto" | "you", ease: boolean, opts: { api?: InstantlyClient } = {}) {
  const api = opts.api ?? (await apiFor(clientId));
  const rows = await all<{ campaign_id: number; name: string; instantly_campaign_id: string | null; status: string }>(
    `SELECT r.campaign_id, c.name, c.instantly_campaign_id, c.status FROM mailbox_rests r JOIN campaigns c ON c.id = r.campaign_id
     WHERE r.client_id = ? AND r.email = ?`,
    clientId, email,
  );
  const back: string[] = [];
  for (const r of rows) {
    if (!r.instantly_campaign_id || !["active", "paused", "draft"].includes(r.status)) continue;
    const list = (await api.campaign(r.instantly_campaign_id)).email_list ?? [];
    if (!list.includes(email)) await api.patchCampaign(r.instantly_campaign_id, { email_list: [...list, email] });
    back.push(r.name);
  }
  const m = await get<{ daily_limit: number | null; ramp_target: number | null }>(
    "SELECT daily_limit, ramp_target FROM mailboxes WHERE client_id = ? AND email = ?", clientId, email,
  );
  const target = m?.ramp_target ?? m?.daily_limit ?? 30;
  await tx(async () => {
    await run("DELETE FROM mailbox_rests WHERE client_id = ? AND email = ?", clientId, email);
    await run(
      `UPDATE mailboxes SET rested_at = NULL, rest_kind = NULL, rest_reason = NULL, healthy_since = NULL, health_note = NULL, returned_at = ?
       WHERE client_id = ? AND email = ?`,
      new Date().toISOString(), clientId, email,
    );
  });
  if (ease) await startEasing(clientId, email, target, { api, quiet: true });
  await logActivity(
    clientId, "return",
    `${by === "auto" ? "Put" : "You put"} ${email} back into ${back.length ? quoteList(back) : "sending"}` +
      (ease ? `, easing in at ${rampLimit(0, target)} a day and up to ${target} over two weeks.` : "."),
    { subject: email, undo: "rest" },
  );
}

/** Ease a mailbox's daily limit up to `target` over two weeks (5, 10, 15, 20, 25, then the target). */
export async function startEasing(clientId: number, email: string, target: number, opts: { api?: InstantlyClient; quiet?: boolean } = {}) {
  const api = opts.api ?? (await apiFor(clientId));
  const limit = rampLimit(0, target);
  const a = await api.patchAccount(email, { daily_limit: limit });
  await run(
    "UPDATE mailboxes SET ramp_target = ?, ramp_started_at = ?, daily_limit = ? WHERE client_id = ? AND email = ?",
    target, new Date().toISOString(), a.daily_limit ?? limit, clientId, email,
  );
  if (!opts.quiet) {
    await logActivity(clientId, "ramp", `Easing ${email} in: ${limit} a day now, up to ${target} over two weeks.`, { subject: email, undo: "stop_easing" });
  }
}

/** Stop easing in and go straight to the full daily limit. */
export async function stopEasing(clientId: number, email: string, opts: { api?: InstantlyClient; finished?: boolean } = {}) {
  const m = await get<{ ramp_target: number | null }>("SELECT ramp_target FROM mailboxes WHERE client_id = ? AND email = ?", clientId, email);
  if (!m?.ramp_target) return;
  const api = opts.api ?? (await apiFor(clientId));
  const a = await api.patchAccount(email, { daily_limit: m.ramp_target });
  await run(
    "UPDATE mailboxes SET ramp_target = NULL, ramp_started_at = NULL, daily_limit = ? WHERE client_id = ? AND email = ?",
    a.daily_limit ?? m.ramp_target, clientId, email,
  );
  await logActivity(
    clientId, "ramp",
    opts.finished ? `${email} has finished easing in: now up to ${m.ramp_target} a day.` : `Stopped easing ${email} in: straight to ${m.ramp_target} a day.`,
    { subject: email },
  );
}

/** Mailboxes paused by the old rules: rest them out of campaigns first, then resume them in Instantly so warmup restarts. */
export async function bringBack(clientId: number, emails: string[], opts: { api?: InstantlyClient } = {}) {
  const api = opts.api ?? (await apiFor(clientId));
  for (const email of emails) {
    await restMailbox(clientId, email, "paused", "its warmup stopped while it was paused, so it rebuilds before campaign emails", "you", { api, quiet: true });
    const a = await api.resumeAccount(email);
    await run(
      "UPDATE mailboxes SET status = ?, auto_paused_at = NULL, auto_paused_reason = NULL WHERE client_id = ? AND email = ?",
      a.status ?? 1, clientId, email,
    );
    await logActivity(
      clientId, "resume",
      `Brought back ${email}: resumed in Instantly so its warmup restarts, resting out of campaigns meanwhile. It goes back by itself once its warmup has been healthy for a few days.`,
      { subject: email, undo: "return" },
    );
  }
}

export async function turnWarmupOn(clientId: number, email: string) {
  await (await apiFor(clientId)).enableWarmup([email]);
  await run("UPDATE mailboxes SET warmup_status = 1 WHERE client_id = ? AND email = ?", clientId, email);
  await logActivity(clientId, "warmup", `Turned warmup on for ${email}`, { subject: email });
}

/**
 * The sync's health step. Rests mailboxes that break the rules, puts recovered ones back, and moves easing-in limits
 * along. Never pauses a mailbox in Instantly.
 */
export async function enforceHealth(clientId: number, api: InstantlyClient) {
  const rules = await healthRules();
  const now = Date.now();
  for (const m of await mailboxHealth(clientId, { rules })) {
    if (m.status !== 1) continue;
    if (!m.rest) {
      const problem = m.bounceProblem ?? m.warmupProblem;
      if (problem && rules.autoRest) {
        await restMailbox(clientId, m.email, m.bounceProblem ? "bounce" : "warmup", problem, "auto", { api });
      } else {
        if (!problem && m.note) await run("UPDATE mailboxes SET health_note = NULL WHERE client_id = ? AND email = ?", clientId, m.email);
        if (m.ramp) await advanceEasing(m, api);
      }
      continue;
    }
    // Resting. Healthy again means warmup is landing in the inbox; with no warmup running, a bounce rest only waits.
    const recovered = m.warmup.active ? (m.score ?? 0) >= rules.minWarmupScore : m.rest.kind === "bounce";
    if (!recovered) {
      if (m.rest.healthySince) await run("UPDATE mailboxes SET healthy_since = NULL WHERE client_id = ? AND email = ?", clientId, m.email);
      continue;
    }
    if (!m.rest.healthySince) {
      await run("UPDATE mailboxes SET healthy_since = ? WHERE client_id = ? AND email = ?", new Date(now).toISOString(), clientId, m.email);
      continue;
    }
    if (m.rest.kind !== "manual" && rules.autoReturn && (daysSince(m.rest.healthySince, now) ?? 0) >= rules.returnDays) {
      await returnMailbox(clientId, m.email, "auto", rules.easeIn, { api });
    }
  }
}

async function advanceEasing(m: MailboxHealth, api: InstantlyClient) {
  if (!m.ramp) return;
  if (m.ramp.day >= RAMP_DAYS) {
    await stopEasing(m.clientId, m.email, { api, finished: true });
    return;
  }
  if (m.dailyLimit === m.ramp.limit) return;
  const a = await api.patchAccount(m.email, { daily_limit: m.ramp.limit });
  await run("UPDATE mailboxes SET daily_limit = ? WHERE client_id = ? AND email = ?", a.daily_limit ?? m.ramp.limit, m.clientId, m.email);
}

// ---------- Campaigns and resting mailboxes ----------

/**
 * The mailboxes to give Instantly for a campaign: the chosen ones minus any that are resting (but never none). Resting
 * ones that were chosen are remembered so they go back into this campaign when they return.
 */
export async function sendList(clientId: number, campaignId: number, chosen: string[]): Promise<string[]> {
  const resting = new Set((await all<{ email: string }>(
    "SELECT email FROM mailboxes WHERE client_id = ? AND rested_at IS NOT NULL", clientId,
  )).map((r) => r.email));
  const live = chosen.filter((e) => !resting.has(e));
  const list = live.length ? live : chosen;
  const waiting = chosen.filter((e) => !list.includes(e));
  await tx(async () => {
    await run("DELETE FROM mailbox_rests WHERE campaign_id = ? AND NOT (email = ANY(?))", campaignId, waiting);
    for (const e of waiting) await addRestRow(clientId, e, campaignId);
  });
  return list;
}

// ---------- Data from Instantly ----------

/** Warmup results per mailbox and day (Instantly gives about the last week each time; the console keeps the history). */
export async function syncWarmup(clientId: number, api: InstantlyClient) {
  const emails = (await all<{ email: string }>("SELECT email FROM mailboxes WHERE client_id = ?", clientId)).map((m) => m.email);
  for (let i = 0; i < emails.length; i += 100) {
    const res = await api.warmupAnalytics(emails.slice(i, i + 100));
    const rows: { email: string; date: string; sent: number; inbox: number; spam: number; received: number }[] = [];
    for (const [email, byDay] of Object.entries(res.email_date_data ?? {})) {
      for (const [date, v] of Object.entries(byDay ?? {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        rows.push({ email, date, sent: v.sent ?? 0, inbox: v.landed_inbox ?? 0, spam: v.landed_spam ?? 0, received: v.received ?? 0 });
      }
    }
    if (rows.length) {
      await run(
        `INSERT INTO warmup_daily (client_id, email, date, sent, inbox, spam, received)
         SELECT ?, x.email, x.date, x.sent, x.inbox, x.spam, x.received
         FROM jsonb_to_recordset(?::jsonb) AS x(email text, date text, sent int, inbox int, spam int, received int)
         ON CONFLICT (client_id, email, date) DO UPDATE SET sent = EXCLUDED.sent, inbox = EXCLUDED.inbox, spam = EXCLUDED.spam,
           received = EXCLUDED.received`,
        clientId, JSON.stringify(rows),
      );
    }
  }
}

export type DomainCheck = { domain: string; mx: boolean | null; spf: boolean | null; dkim: boolean | null; dmarc: boolean | null; all_pass: boolean | null; checked_at: string };

/** Check each sending domain's DNS records with Instantly. Weekly from the sync, or now with `force`. */
export async function checkDomains(clientId: number, opts: { api?: InstantlyClient; force?: boolean } = {}): Promise<number> {
  const boxes = (await all<{ email: string }>("SELECT email FROM mailboxes WHERE client_id = ? ORDER BY email", clientId)).map((m) => m.email);
  const byDomain = new Map<string, string>();
  for (const e of boxes) {
    const d = e.split("@")[1];
    if (d && !byDomain.has(d)) byDomain.set(d, e);
  }
  if (byDomain.size === 0) return 0;
  const fresh = opts.force
    ? []
    : (await all<{ domain: string }>(
        "SELECT domain FROM domain_checks WHERE domain = ANY(?) AND checked_at >= ?",
        [...byDomain.keys()], new Date(Date.now() - 7 * DAY_MS).toISOString(),
      )).map((r) => r.domain);
  const due = [...byDomain].filter(([d]) => !fresh.includes(d));
  if (due.length === 0) return 0;
  const api = opts.api ?? (await apiFor(clientId));
  const res = await api.vitals(due.map(([, e]) => e));
  const now = new Date().toISOString();
  for (const v of [...(res.success_list ?? []), ...(res.failure_list ?? [])]) {
    await run(
      `INSERT INTO domain_checks (domain, mx, spf, dkim, dmarc, all_pass, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (domain) DO UPDATE SET mx = EXCLUDED.mx, spf = EXCLUDED.spf, dkim = EXCLUDED.dkim, dmarc = EXCLUDED.dmarc,
         all_pass = EXCLUDED.all_pass, checked_at = EXCLUDED.checked_at`,
      v.domain, v.mx ?? null, v.spf ?? null, v.dkim ?? null, v.dmarc ?? null, v.allPass ?? null, now,
    );
  }
  return due.length;
}

export async function domainChecks(domains: string[]): Promise<DomainCheck[]> {
  if (domains.length === 0) return [];
  return all<DomainCheck>("SELECT * FROM domain_checks WHERE domain = ANY(?)", domains);
}

/**
 * Sending health over a period, per sending domain, for the client report: campaign emails and bounces, where warmup
 * emails landed, how the mailboxes stand now, and what the console did about them.
 */
export async function sendingHealthReport(clientId: number, from: string, to: string) {
  const rows = await all<{ domain: string; boxes: number; sent: number; bounced: number }>(
    `SELECT split_part(m.email, '@', 2) domain, COUNT(DISTINCT m.email) boxes, COALESCE(SUM(d.sent), 0) sent, COALESCE(SUM(d.bounced), 0) bounced
     FROM mailboxes m LEFT JOIN mailbox_daily d ON d.client_id = m.client_id AND d.email = m.email AND d.date BETWEEN ? AND ?
     WHERE m.client_id = ? GROUP BY 1 ORDER BY 1`,
    from, to, clientId,
  );
  const warm = await all<{ domain: string; sent: number; inbox: number; spam: number }>(
    `SELECT split_part(email, '@', 2) domain, COALESCE(SUM(sent), 0) sent, COALESCE(SUM(inbox), 0) inbox, COALESCE(SUM(spam), 0) spam
     FROM warmup_daily WHERE client_id = ? AND date BETWEEN ? AND ? GROUP BY 1`,
    clientId, from, to,
  );
  const boxes = await mailboxHealth(clientId);
  const actions = (await mailboxActions(clientId, from, 200)).filter((a) => a.at.slice(0, 10) <= to);
  return {
    domains: rows.map((r) => {
      const w = warm.find((x) => x.domain === r.domain);
      const mine = boxes.filter((b) => b.domain === r.domain);
      const states = ["sending", "easing", "resting", "paused", "error"]
        .map((k) => ({ key: k, n: mine.filter((b) => b.state.key === k).length }))
        .filter((s) => s.n > 0);
      return {
        domain: r.domain,
        boxes: Number(r.boxes),
        sent: Number(r.sent),
        bounced: Number(r.bounced),
        warmupSent: Number(w?.sent ?? 0),
        warmupInbox: Number(w?.inbox ?? 0),
        warmupSpam: Number(w?.spam ?? 0),
        states,
      };
    }),
    actions,
  };
}

/** Automatic actions on a client's mailboxes over a period, for the report and the mailbox page. */
export async function mailboxActions(clientId: number, from: string, limit = 50) {
  return all<{ id: number; kind: string; message: string; at: string; subject: string | null; undo: string | null; undone_at: string | null }>(
    `SELECT id, kind, message, at, subject, undo, undone_at FROM activity
     WHERE client_id = ? AND (subject IS NOT NULL OR kind = 'auto_pause') AND at >= ?
     ORDER BY id DESC LIMIT ?`,
    clientId, from, limit,
  );
}
