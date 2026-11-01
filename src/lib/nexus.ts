import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { all, get, getSetting, logActivity, run, tx } from "./db";
import { requireClient, type Client } from "./clients";
import {
  formMailboxes, getCampaign, liveSteps, pushedLeadCount, setCampaignRunning, syncCampaignToInstantly, type Campaign, type Step,
} from "./campaigns";
import { instantly, InstantlyError } from "./instantly";
import { DO_NOT_CONTACT, importLeads, mailServers, STOPPED_OUTSIDE, type LeadFields } from "./leads";
import { AT_PROBLEM_DOMAIN, BEHIND_HELD, NO_MAIL_SERVER } from "./mailhost";
import { pushApproved } from "./push";
import { toHtml } from "./merge";
import { DEFAULT_TIMEZONE, INSTANTLY_TIMEZONES } from "./timezones";
import { signToken } from "./auth";
import type { ImportResult } from "./importResult";
import type { PushResult } from "./pushResult";

/**
 * The partner API Nexus calls (docs/nexus-partner-api.md). Nexus owns the people and the words; the console owns
 * delivery. A Nexus campaign is an ordinary console campaign underneath (source = 'nexus'), so every rule the console
 * applies to sending (address checks, held filters, problem companies, other campaigns, mailbox health) applies to it.
 * Route handlers in src/app/api/partner/nexus/ stay thin: they parse, call one function here, and answer.
 */

// ---------- Answers and errors ----------

/** An answer the API gives as `{ error, code }` with this status. */
export class PartnerError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function respond(fn: () => Promise<unknown>): Promise<Response> {
  return fn().then(
    (body) => Response.json(body),
    (e: unknown) => {
      if (e instanceof PartnerError) return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
      if (e instanceof z.ZodError) {
        const first = e.issues[0];
        return Response.json({ error: `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}`, code: "invalid" }, { status: 400 });
      }
      if (e instanceof InstantlyError) return Response.json({ error: e.message, code: "instantly" }, { status: 502 });
      console.error("[nexus partner]", e);
      return Response.json({ error: (e as Error).message ?? "Something went wrong" }, { status: 500 });
    },
  );
}

/** Null when the bearer secret is right; otherwise the refusal to send. */
export function partnerAuth(req: Request): Response | null {
  const secret = process.env.NEXUS_PARTNER_SECRET;
  if (!secret) return Response.json({ error: "The Nexus partner API isn't set up on this console", code: "not_configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new PartnerError(400, "The body must be JSON", "invalid");
  }
}

/** The app's own address as the caller reached it (behind Vercel's proxy too). */
export function originOf(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

// ---------- Who and which ----------

const locationId = z.string().trim().min(1);

/** The console client for a GoHighLevel location: exactly one, not archived. */
export async function clientFor(location: string): Promise<Client> {
  const rows = await all<{ id: number }>("SELECT id FROM clients WHERE ghl_location_id = ? AND archived = 0", location);
  if (rows.length === 0) throw new PartnerError(404, "No client in the outbound console is linked to this sub-account", "no_client");
  if (rows.length > 1) throw new PartnerError(409, "More than one client in the outbound console is linked to this sub-account", "ambiguous");
  return requireClient(rows[0].id);
}

async function campaignFor(client: Client, nexusId: string): Promise<Campaign> {
  const row = await get<{ id: number }>("SELECT id FROM campaigns WHERE nexus_campaign_id = ? AND client_id = ?", nexusId, client.id);
  const c = row ? await getCampaign(row.id) : undefined;
  if (!c) throw new PartnerError(404, "That campaign isn't in the outbound console yet", "no_campaign");
  return c;
}

function api(client: Client) {
  if (!client.instantly_api_key) throw new PartnerError(409, "The outbound console has no Instantly key for this client", "no_instantly");
  return instantly(client.instantly_api_key);
}

// ---------- GET /status ----------

export async function status(location: string) {
  const client = await clientFor(locationId.parse(location));
  const boxes = await formMailboxes(client.id);
  const credits = await getSetting(`verify_credits_${client.id}`, "");
  return {
    connected: true,
    client: { id: client.id, name: client.name },
    instantly: { ok: !!client.instantly_api_key && client.key_status === "ok", message: client.key_message },
    mailboxes: boxes.map((m) => ({ email: m.email, healthy: m.healthy, ready: m.ready, note: m.note })),
    verification: { credits: credits === "" ? null : Number(credits), problem: (await getSetting(`verify_error_${client.id}`, "")) || null },
  };
}

// ---------- PUT /campaigns/{nexusId} ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const campaignBody = z.object({
  locationId,
  name: z.string().trim().min(1).max(200),
  steps: z.array(z.object({ delayDays: z.number().int().min(0).max(365) })).min(1).max(20),
  schedule: z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1),
    from: z.string().regex(HHMM),
    to: z.string().regex(HHMM),
    timezone: z.string(),
  }),
  dailyLimit: z.number().int().min(1).max(10000),
  accounts: z.array(z.string().trim().toLowerCase()).nullable(),
  webhook: z.object({ url: z.string().url().regex(/^https?:\/\//), token: z.string().min(16) }),
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function putCampaign(nexusId: string, body: unknown) {
  const b = campaignBody.parse(body);
  const client = await clientFor(b.locationId);
  if (!client.instantly_api_key || client.key_status !== "ok") {
    throw new PartnerError(409, "The outbound console isn't connected to Instantly for this client", "no_instantly");
  }

  // The steps carry no copy: Nexus delivers each person's words in custom variables (subject_1, body_n).
  const steps: Step[] = b.steps.map((s) => ({ delay_days: s.delayDays, instructions: "Written by Nexus", mode: "ai" }));
  const timezone = (INSTANTLY_TIMEZONES as readonly string[]).includes(b.schedule.timezone) ? b.schedule.timezone : DEFAULT_TIMEZONE;
  const schedule = { days: [...new Set(b.schedule.days)].sort(), from: b.schedule.from, to: b.schedule.to, timezone };

  // Every mailbox that can send now, unless Nexus named some; resting ones stay chosen and rejoin when healthy.
  const boxes = await formMailboxes(client.id);
  const own = new Set(boxes.map((m) => m.email.toLowerCase()));
  let accounts = b.accounts ? b.accounts.filter((e) => own.has(e)) : boxes.filter((m) => m.healthy).map((m) => m.email);
  if (accounts.length === 0) accounts = boxes.map((m) => m.email);

  const existing = await get<{ id: number; client_id: number }>("SELECT id, client_id FROM campaigns WHERE nexus_campaign_id = ?", nexusId);
  if (existing && existing.client_id !== client.id) throw new PartnerError(409, "That campaign belongs to another client", "ambiguous");

  let id: number;
  if (existing) {
    const c = (await getCampaign(existing.id))!;
    if (steps.length !== c.steps.length && (await pushedLeadCount(c.id)) > 0) {
      throw new PartnerError(409, "People are already in Instantly for this campaign, so its number of emails can't change", "steps_locked");
    }
    await run(
      `UPDATE campaigns SET name = ?, steps = ?, schedule = ?, daily_limit = ?, accounts = ?, stop_on_reply = 1, managed = 1,
         source = 'nexus', hold_after = NULL, release_to = NULL WHERE id = ?`,
      b.name, JSON.stringify(steps), JSON.stringify(schedule), b.dailyLimit, JSON.stringify(accounts), c.id,
    );
    id = c.id;
  } else {
    // A second call racing this one for the same campaign finds the row the first made.
    await run(
      `INSERT INTO campaigns (client_id, name, steps, schedule, daily_limit, accounts, stop_on_reply, managed, source, nexus_campaign_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'nexus', ?) ON CONFLICT (nexus_campaign_id) WHERE nexus_campaign_id IS NOT NULL DO NOTHING`,
      client.id, b.name, JSON.stringify(steps), JSON.stringify(schedule), b.dailyLimit, JSON.stringify(accounts), nexusId,
    );
    id = (await get<{ id: number }>("SELECT id FROM campaigns WHERE nexus_campaign_id = ?", nexusId))!.id;
    await logActivity(client.id, "campaign", `Nexus started the campaign "${b.name}"`);
  }

  const remote = await syncCampaignToInstantly(id);
  await ensureWebhook(client, id, remote.id, b.name, b.webhook);
  const c = (await getCampaign(id))!;
  return { campaignId: c.id, instantlyCampaignId: remote.id, status: c.status };
}

/** One Instantly webhook per campaign, delivering every event to Nexus with its bearer token; replaced when either changes. */
async function ensureWebhook(client: Client, campaignId: number, instantlyId: string, name: string, hook: { url: string; token: string }) {
  const row = await get<{ nexus_webhook_id: string | null; nexus_webhook_url: string | null; nexus_webhook_token_hash: string | null }>(
    "SELECT nexus_webhook_id, nexus_webhook_url, nexus_webhook_token_hash FROM campaigns WHERE id = ?",
    campaignId,
  );
  const hash = sha256(hook.token);
  if (row?.nexus_webhook_id && row.nexus_webhook_url === hook.url && row.nexus_webhook_token_hash === hash) return;
  const a = api(client);
  if (row?.nexus_webhook_id) {
    await a.deleteWebhook(row.nexus_webhook_id).catch((e) => {
      if (!(e instanceof InstantlyError && e.status === 404)) throw e;
    });
  }
  const created = await a.createWebhook({
    target_hook_url: hook.url,
    event_type: "all_events",
    campaign: instantlyId,
    name: `Nexus: ${name}`.slice(0, 100),
    headers: { Authorization: `Bearer ${hook.token}` },
  });
  await run(
    "UPDATE campaigns SET nexus_webhook_id = ?, nexus_webhook_url = ?, nexus_webhook_token_hash = ? WHERE id = ?",
    created.id, hook.url, hash, campaignId,
  );
}

// ---------- POST /campaigns/{nexusId}/leads ----------

const leadsBody = z.object({
  locationId,
  leads: z
    .array(
      z.object({
        email: z.string().trim().min(3),
        firstName: z.string().nullish(),
        lastName: z.string().nullish(),
        company: z.string().nullish(),
        title: z.string().nullish(),
        phone: z.string().nullish(),
        website: z.string().nullish(),
        ghlContactId: z.string().nullish(),
      }),
    )
    .max(1000),
});

export async function addLeads(nexusId: string, body: unknown): Promise<ImportResult> {
  const b = leadsBody.parse(body);
  const client = await clientFor(b.locationId);
  const c = await campaignFor(client, nexusId);
  const leads: LeadFields[] = b.leads.map((l) => ({
    email: l.email,
    first_name: l.firstName ?? null,
    last_name: l.lastName ?? null,
    company: l.company ?? null,
    title: l.title ?? null,
    phone: l.phone ?? null,
    website: l.website ?? null,
    ghl_contact_id: l.ghlContactId ?? null,
  }));
  // source_ref "nexus" labels them "A Nexus campaign" in the people lists.
  return importLeads(client.id, c.id, "nexus", "nexus", leads);
}

// ---------- GET /campaigns/{nexusId}/leads ----------

export const LEADS_PAGE = 500;

type Verdict = "removed" | "do_not_contact" | "invalid" | "no_mail_server" | "problem_company" | "held_filter" | "checking" | "unconfirmed" | "ok";

const VERDICT_REASON: Record<Verdict, string | null> = {
  removed: "Taken out of the campaign",
  do_not_contact: "Replied, bounced or unsubscribed in another of this client's campaigns",
  invalid: "The address doesn't exist",
  no_mail_server: "Their domain has no mail server, so an email could only bounce",
  problem_company: "Their company is on the problem companies list",
  held_filter: "Behind a mail filter this campaign is holding back",
  checking: null,
  unconfirmed: "The company accepts every address, so this one couldn't be confirmed",
  ok: null,
};

type Facts = {
  id: number;
  email: string;
  ghl_contact_id: string | null;
  verification: string | null;
  stage: string;
  stage_message: string | null;
  instantly_status: number | null;
  pushed_at: string | null;
  instantly_lead_id: string | null;
  last_sent_at: string | null;
  last_reply_at: string | null;
  step_reached: number | null;
  dnc: boolean;
  nomail: boolean;
  problem: boolean;
  held: boolean;
  reply_at: string | null;
  reply_subject: string | null;
  reply_text: string | null;
};

/** Every fact the verdict needs, for a campaign's leads (all of them, a page, or some addresses). */
async function leadFacts(c: Campaign, opts: { emails?: string[]; offset?: number; limit?: number }): Promise<Facts[]> {
  // The send-time rules only matter before a contact reaches Instantly; once there, Instantly's own status is the story.
  const notSent = "l.pushed_at IS NULL AND l.instantly_lead_id IS NULL";
  return all<Facts>(
    `SELECT l.id, l.email, l.ghl_contact_id, l.verification, l.stage, l.stage_message, l.instantly_status, l.pushed_at, l.instantly_lead_id,
       l.last_sent_at, l.last_reply_at, l.step_reached,
       (${notSent} AND (${STOPPED_OUTSIDE("l")} OR EXISTS (SELECT 1 FROM leads o WHERE o.client_id = l.client_id AND o.email = l.email AND o.id <> l.id
         AND o.campaign_id IS DISTINCT FROM l.campaign_id AND ${DO_NOT_CONTACT("o")}))) dnc,
       (${notSent} AND ${NO_MAIL_SERVER("l")}) nomail,
       (${notSent} AND ${AT_PROBLEM_DOMAIN("l")}) problem,
       (${notSent} AND ${BEHIND_HELD("l").replace("?", "@held")}) held,
       r.sent_at reply_at, r.subject reply_subject, r.body_text reply_text
     FROM leads l
     LEFT JOIN LATERAL (
       SELECT e.sent_at, e.subject, e.body_text FROM emails e
       WHERE e.client_id = l.client_id AND e.lead_email = l.email AND e.direction = 'in' AND e.campaign_id = l.campaign_id
       ORDER BY e.sent_at DESC LIMIT 1
     ) r ON TRUE
     WHERE l.campaign_id = @campaignId ${opts.emails ? "AND l.email = ANY(@emails)" : ""}
     ORDER BY l.id ${opts.limit ? "LIMIT @limit OFFSET @offset" : ""}`,
    { campaignId: c.id, held: c.hold_gateways, emails: opts.emails ?? [], limit: opts.limit ?? 0, offset: opts.offset ?? 0 },
  );
}

/** The first that applies, in the contract's order. */
function verdictOf(f: Facts): Verdict {
  if (f.stage === "removed") return "removed";
  if (f.dnc) return "do_not_contact";
  if (f.verification === "invalid") return "invalid";
  if (f.nomail) return "no_mail_server";
  if (f.problem) return "problem_company";
  if (f.held) return "held_filter";
  if (!f.verification || f.verification === "queued" || f.verification === "pending") return "checking";
  if (f.verification === "catch_all") return "unconfirmed";
  return "ok";
}

export async function listLeads(nexusId: string, location: string, pageParam: string | null) {
  const client = await clientFor(locationId.parse(location));
  const c = await campaignFor(client, nexusId);
  const page = Math.max(1, Math.floor(Number(pageParam) || 1));
  const facts = await leadFacts(c, { limit: LEADS_PAGE, offset: (page - 1) * LEADS_PAGE });
  const servers = await mailServers(facts.map((f) => f.email));
  const totals = await get<{ total: number; checking: number }>(
    `SELECT COUNT(*) total,
       COUNT(*) FILTER (WHERE stage <> 'removed' AND (verification IS NULL OR verification IN ('queued', 'pending'))) checking
     FROM leads WHERE campaign_id = ?`,
    c.id,
  );
  return {
    leads: facts.map((f) => {
      const verdict = verdictOf(f);
      return {
        email: f.email,
        ghlContactId: f.ghl_contact_id,
        verification: f.verification,
        verdict,
        reason: f.stage_message ?? VERDICT_REASON[verdict],
        mailServer: servers.get(f.email)?.label ?? null,
        stage: f.stage,
        instantlyStatus: f.instantly_status,
        pushedAt: f.pushed_at,
        lastSentAt: f.last_sent_at,
        lastReplyAt: f.last_reply_at,
        stepReached: f.step_reached,
        lastReply: f.reply_at ? { at: f.reply_at, subject: f.reply_subject, text: f.reply_text } : null,
      };
    }),
    total: totals?.total ?? 0,
    page,
    pageSize: LEADS_PAGE,
    checking: totals?.checking ?? 0,
  };
}

// ---------- PUT /campaigns/{nexusId}/copy ----------

const copyBody = z.object({
  locationId,
  leads: z
    .array(
      z.object({
        email: z.string().trim().min(3),
        steps: z.array(z.object({ step: z.number().int().min(1).max(20), subject: z.string().default(""), text: z.string() })).min(1),
      }),
    )
    .max(1000),
});

type CopyProblem = "unknown" | "not_checked" | "not_sendable" | "incomplete" | "already_sent";

export async function putCopy(nexusId: string, body: unknown) {
  const b = copyBody.parse(body);
  const client = await clientFor(b.locationId);
  const c = await campaignFor(client, nexusId);
  const live = liveSteps(c);
  const emails = [...new Set(b.leads.map((l) => l.email.toLowerCase()))];
  const facts = new Map((await leadFacts(c, { emails })).map((f) => [f.email, f]));

  const results: { email: string; ok: boolean; problem?: CopyProblem }[] = [];
  for (const l of b.leads) {
    const email = l.email.toLowerCase();
    const f = facts.get(email);
    const fail = (problem: CopyProblem) => results.push({ email: l.email, ok: false, problem });
    if (!f) {
      fail("unknown");
      continue;
    }
    if (f.pushed_at || f.instantly_lead_id) {
      fail("already_sent");
      continue;
    }
    const verdict = verdictOf(f);
    if (verdict === "checking") {
      fail("not_checked");
      continue;
    }
    if (verdict !== "ok" && verdict !== "unconfirmed" && verdict !== "held_filter") {
      fail("not_sendable");
      continue;
    }
    const byStep = new Map(l.steps.map((s) => [s.step, s]));
    const complete = Array.from({ length: live }, (_, i) => byStep.get(i + 1)).every(
      (s, i) => s && s.text.trim() && (i > 0 || s.subject.trim()),
    );
    if (!complete) {
      fail("incomplete");
      continue;
    }
    await tx(async () => {
      for (let step = 1; step <= live; step++) {
        const s = byStep.get(step)!;
        // Follow-ups reply in the thread, so only the first email has a subject.
        await run(
          `INSERT INTO drafts (lead_id, step, subject, body, status, format, reviewed_at) VALUES (?, ?, ?, ?, 'approved', 'text', datetime('now'))
           ON CONFLICT (lead_id, step) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, status = 'approved',
             format = 'text', flags = NULL, reviewed_at = EXCLUDED.reviewed_at`,
          f.id, step, step === 1 ? s.subject.trim() : "", s.text.trim(),
        );
      }
      await run("UPDATE leads SET stage = 'approved', stage_message = NULL WHERE id = ?", f.id);
    });
    results.push({ email: l.email, ok: true });
  }
  return { results };
}

// ---------- POST /campaigns/{nexusId}/push ----------

export async function push(nexusId: string, body: unknown): Promise<PushResult> {
  const b = z.object({ locationId }).parse(body);
  const client = await clientFor(b.locationId);
  const c = await campaignFor(client, nexusId);
  if (!c.instantly_campaign_id) throw new PartnerError(409, "The campaign isn't in Instantly yet", "no_campaign");
  const r = await pushApproved(c.id);
  // Start a campaign that has never sent; one Nexus paused stays paused until Nexus resumes it.
  if (c.status === "draft" && (await pushedLeadCount(c.id)) > 0) await setCampaignRunning(c.id, true);
  return r;
}

// ---------- POST /campaigns/{nexusId}/status ----------

export async function setStatus(nexusId: string, body: unknown) {
  const b = z.object({ locationId, action: z.enum(["pause", "resume"]) }).parse(body);
  const client = await clientFor(b.locationId);
  const c = await campaignFor(client, nexusId);
  if (!c.instantly_campaign_id) throw new PartnerError(409, "The campaign isn't in Instantly yet", "no_campaign");
  await setCampaignRunning(c.id, b.action === "resume");
  return { status: (await getCampaign(c.id))!.status };
}

// ---------- POST /campaigns/{nexusId}/leads/stop ----------

export async function stopLead(nexusId: string, body: unknown) {
  const b = z.object({ locationId, email: z.string().trim().min(3), reason: z.string().trim().max(500).optional(), block: z.boolean().optional() }).parse(body);
  const client = await clientFor(b.locationId);
  const c = await campaignFor(client, nexusId);
  const email = b.email.toLowerCase();
  const lead = await get<{ id: number; instantly_lead_id: string | null }>("SELECT id, instantly_lead_id FROM leads WHERE campaign_id = ? AND email = ?", c.id, email);
  if (!lead) throw new PartnerError(404, "That person isn't in the campaign", "unknown");
  const a = lead.instantly_lead_id || b.block ? api(client) : null;
  if (lead.instantly_lead_id) {
    await a!.deleteLead(lead.instantly_lead_id).catch((e) => {
      if (!(e instanceof InstantlyError && e.status === 404)) throw e;
    });
  }
  if (b.block) await a!.blockEmail(email);
  const why = b.reason?.trim() || "Stopped from Nexus";
  await tx(async () => {
    await run("UPDATE leads SET stage = 'removed', stage_message = ? WHERE id = ?", why, lead.id);
    await run("UPDATE drafts SET status = 'rejected', reviewed_at = datetime('now') WHERE lead_id = ? AND status IN ('pending', 'approved')", lead.id);
  });
  await logActivity(client.id, b.block ? "unsubscribe" : "import", `Nexus took ${email} out of "${c.name}": ${why}${b.block ? " (added to the Instantly blocklist)" : ""}`);
  return { ok: true };
}

// ---------- POST /campaigns/{nexusId}/reply ----------

const stripRe = (s: string) => s.replace(/^\s*((re|fwd?)\s*:\s*)+/i, "").trim();

export async function reply(nexusId: string, body: unknown) {
  const b = z.object({ locationId, email: z.string().trim().min(3), subject: z.string().nullish(), text: z.string().trim().min(1) }).parse(body);
  const client = await clientFor(b.locationId);
  const c = await campaignFor(client, nexusId);
  if (!c.instantly_campaign_id) throw new PartnerError(404, "Nothing has been sent to them yet", "no_thread");
  const email = b.email.toLowerCase();
  const a = api(client);
  // The thread as Instantly has it now: the newest email with them, either way, is the one to answer.
  const thread = await a.emailsWithLead(c.instantly_campaign_id, email);
  const latest = thread[0];
  if (!latest) throw new PartnerError(404, "Nothing has been sent to them yet", "no_thread");
  const mailbox = latest.eaccount;
  const resting = await get<{ rested_at: string | null }>("SELECT rested_at FROM mailboxes WHERE client_id = ? AND lower(email) = lower(?)", client.id, mailbox);
  if (resting?.rested_at) {
    throw new PartnerError(409, `${mailbox} is resting, so the email waits rather than coming from a different address`, "mailbox_resting");
  }
  const original = thread[thread.length - 1]?.subject || latest.subject || "";
  const subject = b.subject?.trim() || `Re: ${stripRe(original)}`;
  const sent = await a.reply({ eaccount: mailbox, reply_to_uuid: latest.id, subject, body: { html: toHtml(b.text), text: b.text } });
  await logActivity(client.id, "reply", `Nexus replied to ${email} in "${c.name}" from ${mailbox}`);
  return { id: sent.id, eaccount: sent.eaccount ?? mailbox, threadId: sent.thread_id ?? latest.thread_id };
}

// ---------- POST /signin ----------

const SIGNIN_TTL_MS = 2 * 60_000;

export type SigninToken = { uid: number; path: string; exp: number; nonce: string };

export async function signin(body: unknown, origin: string) {
  const b = z.object({ locationId, email: z.string().trim().toLowerCase().email(), nexusId: z.string().nullish() }).parse(body);
  const client = await clientFor(b.locationId);
  let path = `/clients/${client.id}`;
  if (b.nexusId) path = `/clients/${client.id}/campaigns/${(await campaignFor(client, b.nexusId)).id}/contacts`;

  // A client login for this person, created on first use; an admin stays an admin.
  await run("INSERT INTO users (email, role) VALUES (?, 'client') ON CONFLICT (email) DO NOTHING", b.email);
  const user = (await get<{ id: number; role: string }>("SELECT id, role FROM users WHERE email = ?", b.email))!;
  await run("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?) ON CONFLICT DO NOTHING", user.id, client.id);

  const token = signToken({ uid: user.id, path, exp: Date.now() + SIGNIN_TTL_MS, nonce: randomBytes(16).toString("base64url") } satisfies SigninToken);
  return { url: `${origin}/partner-signin?token=${encodeURIComponent(token)}` };
}

/** Claim a sign-in token's nonce once; false when it was already used. Old markers are cleared on the way. */
export async function claimNonce(nonce: string, exp: number): Promise<boolean> {
  await run("DELETE FROM settings WHERE key LIKE 'signin_used_%' AND value::bigint < ?", Date.now() - SIGNIN_TTL_MS);
  return (await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", `signin_used_${nonce}`, String(exp))).changes === 1;
}
