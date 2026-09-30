import "server-only";
import { all, get, run, tx, logActivity, getSetting, setSetting, withLock } from "./db";
import { listClients, requireClient, type Client } from "./clients";
import { instantly, type Email, type InstantlyClient } from "./instantly";
import { pruneForeignEmails, upsertCampaigns, upsertMailboxes } from "./connection";
import { ensureTag, scopedMailboxes, sharingProblem } from "./scope";
import { triageNewReplies } from "./triage";
import { runWriter } from "./writer";
import { syncMeetings } from "./meetings";
import { linkPendingLeads, logEmailsToGhl, pullTaggedContacts } from "./ghlsync";

const day = (offset = 0) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop the quoted thread under a reply so the inbox shows only what the lead wrote. */
function newestPart(text: string): string {
  const cut = text.search(/\n\s*(On [^\n]{5,120}\n?[^\n]{0,80}wrote:|-----Original Message-----|From: .+\nSent: )/i);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

export type HealthRules = { bouncePct: number; minSent: number; minWarmupScore: number };

export async function healthRules(): Promise<HealthRules> {
  return {
    bouncePct: Number(await getSetting("health_bounce_pct", "3")),
    minSent: Number(await getSetting("health_min_sent", "20")),
    minWarmupScore: Number(await getSetting("health_min_warmup", "70")),
  };
}

/** Instantly labels steps "0_0_0" (sequence_step_variant, zero-based); older payloads use a plain number. */
export function parseStep(step: string | null | undefined): number | null {
  if (!step) return null;
  const parts = String(step).split("_");
  if (parts.length >= 2) {
    const n = Number(parts[1]);
    return Number.isFinite(n) ? n + 1 : null;
  }
  const n = Number(step);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function syncEmails(client: Client, api: InstantlyClient) {
  const clientId = client.id;
  const cursorKey = `emails_cursor_${clientId}`;
  // One-off: re-read history once so emails stored before step parsing was fixed get their step number.
  if (await getSetting(`step_backfill_${clientId}`, "") !== "1") {
    await setSetting(cursorKey, "");
    await setSetting(`step_backfill_${clientId}`, "1");
  }
  const since = await getSetting(cursorKey, "") || null;
  // Shared workspace: Instantly can't filter emails by tag, so filter by the client's own mailboxes.
  const own = await scopedMailboxes(client);
  if (own && own.length === 0) return 0;
  const emails = await api.emailsSince(since, 5, own);
  if (emails.length === 0) return 0;

  const campaigns = new Map(
    (await all<{ id: number; instantly_campaign_id: string }>("SELECT id, instantly_campaign_id FROM campaigns WHERE client_id = ?", clientId)).map((c) => [
      c.instantly_campaign_id,
      c.id,
    ]),
  );
  const leadId = async (email: string | null) =>
    email ? ((await get<{ id: number }>("SELECT id FROM leads WHERE client_id = ? AND email = ?", clientId, email.toLowerCase()))?.id ?? null) : null;

  let newest = since ?? "";
  let inbound = 0;
  await tx(async () => {
    for (const e of emails as Email[]) {
      if (e.timestamp_created > newest) newest = e.timestamp_created;
      if (e.ue_type === 4) continue; // scheduled: handled by syncScheduled
      const direction = e.ue_type === 2 ? "in" : "out";
      const text = e.body?.text || (e.body?.html ? stripHtml(e.body.html) : e.content_preview ?? "");
      const lead = e.lead?.toLowerCase() ?? null;
      const known = await get<{ client_id: number }>("SELECT client_id FROM emails WHERE id = ?", e.id);
      await run(
        // Re-reads fill in details stored before (step), and a mailbox that moved to this client from another
        // one sharing the workspace brings its emails with it.
        `INSERT INTO emails (id, client_id, campaign_id, lead_id, lead_email, direction, step, account_email, subject,
           body_text, thread_id, sent_at, is_unread, interest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id,
           campaign_id = COALESCE(excluded.campaign_id, emails.campaign_id), lead_id = COALESCE(excluded.lead_id, emails.lead_id),
           step = COALESCE(emails.step, excluded.step)`,
        e.id, clientId, e.campaign_id ? campaigns.get(e.campaign_id) ?? null : null, await leadId(lead), lead, direction,
        parseStep(e.step), e.eaccount, e.subject,
        direction === "in" ? newestPart(text) : text,
        e.thread_id, e.timestamp_email, e.is_unread ? 1 : 0,
        direction === "in" && e.is_auto_reply ? "ooo" : null,
      );
      if (known && known.client_id === clientId) continue; // not new to this client
      const lid = await leadId(lead);
      if (lid && direction === "out") await run("UPDATE leads SET last_sent_at = GREATEST(COALESCE(last_sent_at, ''), ?) WHERE id = ?", e.timestamp_email, lid);
      if (lid && direction === "in") await run("UPDATE leads SET last_reply_at = GREATEST(COALESCE(last_reply_at, ''), ?) WHERE id = ?", e.timestamp_email, lid);
      if (direction === "in") inbound++;
    }
  });
  await setSetting(cursorKey, newest);
  if (inbound) await logActivity(clientId, "reply", `${inbound} new ${inbound === 1 ? "reply" : "replies"}`);
  return emails.length;
}

async function syncScheduled(client: Client, api: InstantlyClient) {
  const clientId = client.id;
  const own = await scopedMailboxes(client);
  // One page is plenty at this scale; it's a preview of what goes out next.
  const res = own && own.length === 0 ? [] : await api.scheduledEmails(own);
  const campaigns = new Map(
    (await all<{ id: number; instantly_campaign_id: string }>("SELECT id, instantly_campaign_id FROM campaigns WHERE client_id = ?", clientId)).map((c) => [
      c.instantly_campaign_id,
      c.id,
    ]),
  );
  await tx(async () => {
    await run("DELETE FROM scheduled WHERE client_id = ?", clientId);
    for (const e of res) {
      await run(
        `INSERT INTO scheduled (id, client_id, campaign_id, lead_email, account_email, step, subject, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, campaign_id = EXCLUDED.campaign_id, step = EXCLUDED.step,
           subject = EXCLUDED.subject, due_at = EXCLUDED.due_at`,
        e.id, clientId, e.campaign_id ? campaigns.get(e.campaign_id) ?? null : null, e.lead, e.eaccount,
        parseStep(e.step), e.subject, e.timestamp_email,
      );
    }
  });
}

async function syncStats(clientId: number, api: InstantlyClient) {
  const campaigns = await all<{ id: number; instantly_campaign_id: string; status: string }>(
    "SELECT id, instantly_campaign_id, status FROM campaigns WHERE client_id = ? AND instantly_campaign_id IS NOT NULL",
    clientId,
  );
  // The first stats sync reaches back 120 days so the dashboard's longer ranges have data; later ones refresh 30.
  const backfilled = await getSetting(`stats_backfill_${clientId}`, "") === "1";
  const history = backfilled ? 30 : 120;
  for (const c of campaigns) {
    const daily = await api.campaignDaily(c.instantly_campaign_id, day(history), day(0));
    for (const d of daily) {
      await run(
        `INSERT INTO daily_stats (client_id, campaign_id, date, sent, contacted, opened, replied, clicked, opportunities)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id, date) DO UPDATE SET sent = excluded.sent, contacted = excluded.contacted, opened = excluded.opened,
           replied = excluded.replied, clicked = excluded.clicked, opportunities = excluded.opportunities`,
        clientId, c.id, d.date, d.sent ?? 0, d.new_leads_contacted ?? 0, d.unique_opened ?? 0, d.unique_replies ?? 0,
        d.unique_clicks ?? 0, d.unique_opportunities ?? 0,
      );
    }
    // Per-step totals since launch (A/B variants summed).
    const steps = await api.campaignSteps(c.instantly_campaign_id);
    const byStep = new Map<number, { sent: number; opened: number; replied: number; opps: number }>();
    for (const r of steps) {
      // Steps arrive as "0", "1"… (zero-based); skip rows without a usable step.
      const n = parseStep(r.step !== null && r.step !== undefined && !String(r.step).includes("_") ? `0_${r.step}` : r.step);
      if (!n) continue;
      const t = byStep.get(n) ?? { sent: 0, opened: 0, replied: 0, opps: 0 };
      t.sent += r.sent ?? 0;
      t.opened += r.unique_opened ?? 0;
      t.replied += r.unique_replies ?? 0;
      t.opps += r.unique_opportunities ?? 0;
      byStep.set(n, t);
    }
    await tx(async () => {
      await run("DELETE FROM step_stats WHERE campaign_id = ?", c.id);
      for (const [n, t] of byStep) {
        await run("INSERT INTO step_stats (campaign_id, step, sent, opened, replied, opportunities) VALUES (?, ?, ?, ?, ?, ?)", c.id, n, t.sent, t.opened, t.replied, t.opps);
      }
    });
    if (c.status === "active") {
      try {
        const s = await api.sendingStatus(c.instantly_campaign_id);
        const st = s.summary?.status;
        await run("UPDATE campaigns SET not_sending = ? WHERE id = ?", st && st !== "healthy" ? s.summary?.status_message ?? st : null, c.id);
      } catch {
        // Diagnostics are nice-to-have; ignore failures.
      }
    }
  }

  const mailboxes = (await all<{ email: string }>("SELECT email FROM mailboxes WHERE client_id = ?", clientId)).map((m) => m.email);
  // Instantly allows at most 31 days per mailbox-analytics call, so history is fetched in 30-day windows.
  const windows = backfilled ? [[14, 0]] : [[120, 91], [90, 61], [60, 31], [30, 0]];
  for (let i = 0; i < mailboxes.length; i += 100) {
    for (const [start, end] of windows) {
      const daily = await api.accountDaily(mailboxes.slice(i, i + 100), day(start), day(end));
      for (const d of daily) {
        await run(
          `INSERT INTO mailbox_daily (client_id, email, date, sent, bounced, opened, replied) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(client_id, email, date) DO UPDATE SET sent = excluded.sent, bounced = excluded.bounced,
             opened = excluded.opened, replied = excluded.replied`,
          clientId, d.email_account, d.date, d.sent ?? 0, d.bounced ?? 0, d.unique_opened ?? 0, d.unique_replies ?? 0,
        );
      }
    }
  }
  await setSetting(`stats_backfill_${clientId}`, "1");
  await run(
    `UPDATE mailboxes SET
       sent_today = (SELECT COALESCE(SUM(sent),0) FROM mailbox_daily d WHERE d.client_id = mailboxes.client_id AND d.email = mailboxes.email AND d.date = ?),
       sent_7d = (SELECT COALESCE(SUM(sent),0) FROM mailbox_daily d WHERE d.client_id = mailboxes.client_id AND d.email = mailboxes.email AND d.date >= ?),
       bounced_7d = (SELECT COALESCE(SUM(bounced),0) FROM mailbox_daily d WHERE d.client_id = mailboxes.client_id AND d.email = mailboxes.email AND d.date >= ?)
     WHERE client_id = ?`,
    day(0), day(7), day(7), clientId,
  );
}

async function syncLeads(clientId: number, api: InstantlyClient) {
  const campaigns = await all<{ id: number; instantly_campaign_id: string }>(
    "SELECT id, instantly_campaign_id FROM campaigns WHERE client_id = ? AND managed = 1 AND instantly_campaign_id IS NOT NULL AND status IN ('active','paused')",
    clientId,
  );
  for (const c of campaigns) {
    const leads = await api.leadsInCampaign(c.instantly_campaign_id);
    await tx(async () => {
      for (const l of leads) {
        if (!l.email) continue;
        await run(
          `UPDATE leads SET instantly_status = ?, interest_status = COALESCE(?, interest_status), last_open_at = COALESCE(?, last_open_at)
           WHERE client_id = ? AND email = ?`,
          // Instantly omits fields that were never set (e.g. no opens yet); undefined can't be bound.
          l.status ?? null, l.lt_interest_status ?? null, l.timestamp_last_open ?? null, clientId, l.email.toLowerCase(),
        );
      }
    });
  }
}

/** Pause mailboxes that break the health rules (bounce rate, warmup score). Only ever pauses; never auto-resumes. */
async function enforceHealth(clientId: number, api: InstantlyClient) {
  if (await getSetting("health_auto_pause", "1") !== "1") return;
  const rules = await healthRules();
  const boxes = await all<{ email: string; status: number; warmup_score: number | null; sent_7d: number; bounced_7d: number; auto_paused_at: string | null }>(
    "SELECT * FROM mailboxes WHERE client_id = ? AND status = 1",
    clientId,
  );
  for (const b of boxes) {
    let reason = "";
    if (b.sent_7d >= rules.minSent && (b.bounced_7d / b.sent_7d) * 100 > rules.bouncePct) {
      reason = `bounce rate ${((b.bounced_7d / b.sent_7d) * 100).toFixed(1)}% over 7 days (limit ${rules.bouncePct}%)`;
    } else if (b.warmup_score !== null && b.warmup_score < rules.minWarmupScore) {
      reason = `warmup health ${b.warmup_score} (minimum ${rules.minWarmupScore})`;
    }
    if (!reason) continue;
    try {
      await api.pauseAccount(b.email);
      await run(
        "UPDATE mailboxes SET status = 2, auto_paused_at = datetime('now'), auto_paused_reason = ? WHERE client_id = ? AND email = ?",
        reason, clientId, b.email,
      );
      await logActivity(clientId, "auto_pause", `Paused ${b.email}: ${reason}`);
    } catch (e) {
      await logActivity(clientId, "error", `Wanted to pause ${b.email} (${reason}) but Instantly said: ${(e as Error).message}`);
    }
  }
}

export async function syncClient(clientId: number): Promise<{ ok: boolean; message: string }> {
  const client = await requireClient(clientId);
  if (!client.instantly_api_key || client.key_status === "error") return { ok: false, message: "Instantly not connected" };
  // Never sync a shared workspace unless every client in it is tagged, or one client would see another's data.
  const problem = await sharingProblem(client);
  if (problem) {
    await run("UPDATE clients SET key_status = 'error', key_message = ? WHERE id = ?", problem, clientId);
    await logActivity(clientId, "error", problem);
    return { ok: false, message: problem };
  }
  const api = instantly(client.instantly_api_key);
  // Resolve the tag first; if that fails, stop rather than fall back to the whole workspace.
  let tagId: string | null;
  try {
    tagId = await ensureTag(api, client);
  } catch (e) {
    const message = `Couldn't look up tag "${client.instantly_tag_label}": ${(e as Error).message}`;
    await logActivity(clientId, "error", message);
    return { ok: false, message };
  }
  const steps: [string, () => Promise<unknown>][] = [
    ["mailboxes", async () => {
      await upsertMailboxes(clientId, await api.accounts(tagId));
      if (tagId) await pruneForeignEmails(clientId);
    }],
    ["campaigns", async () => {
      const campaigns = await api.campaigns(tagId);
      await upsertCampaigns(clientId, campaigns);
      const boxes = (await get<{ n: number }>("SELECT COUNT(*) n FROM mailboxes WHERE client_id = ?", clientId))?.n ?? 0;
      const scope = tagId ? ` tagged "${client.instantly_tag_label}"` : "";
      await run("UPDATE clients SET key_message = ?, key_checked_at = ? WHERE id = ?", `${boxes} mailboxes, ${campaigns.length} campaigns${scope}`, new Date().toISOString(), clientId);
    }],
    ["emails", () => syncEmails(client, api)],
    ["scheduled", () => syncScheduled(client, api)],
    ["stats", () => syncStats(clientId, api)],
    ["leads", () => syncLeads(clientId, api)],
    ["health", () => enforceHealth(clientId, api)],
    ["replies", () => triageNewReplies(clientId)],
    ["meetings", () => syncMeetings(client)],
    // GHL is the source of truth for contacts: link new leads, pull newly tagged contacts, log emails.
    ["ghl contacts", () => linkPendingLeads(client)],
    ["ghl tags", async () => {
      if (await pullTaggedContacts(client)) void await runWriter();
    }],
    ["ghl conversations", () => logEmailsToGhl(client)],
  ];
  const errors: string[] = [];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
      if ((e as { status?: number }).status === 401) break;
    }
  }
  await setSetting(`last_sync_${clientId}`, new Date().toISOString());
  if (errors.length) {
    const message = errors.join(" | ");
    await logActivity(clientId, "error", `Sync problems — ${message}`);
    return { ok: false, message };
  }
  return { ok: true, message: "Synced" };
}

/** Sync every connected client, then write any queued emails. One run at a time across all server instances. */
export async function syncAll() {
  return withLock("sync", 12 * 60_000, syncEveryClient);
}

async function syncEveryClient() {
  {
    for (const c of await listClients()) {
      if (c.instantly_api_key && c.key_status === "ok") await syncClient(c.id);
    }
    await setSetting("last_sync_all", new Date().toISOString());
    await runWriter(); // pick up any drafting left over from a restart
  }
}
