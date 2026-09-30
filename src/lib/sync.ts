import "server-only";
import { all, get, run, tx, logActivity, getSetting, setSetting } from "./db";
import { listClients, requireClient } from "./clients";
import { instantly, type Email, type InstantlyClient } from "./instantly";
import { upsertCampaigns, upsertMailboxes } from "./connection";
import { triageNewReplies } from "./triage";
import { runWriter } from "./writer";

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

export function healthRules(): HealthRules {
  return {
    bouncePct: Number(getSetting("health_bounce_pct", "3")),
    minSent: Number(getSetting("health_min_sent", "20")),
    minWarmupScore: Number(getSetting("health_min_warmup", "70")),
  };
}

async function syncEmails(clientId: number, api: InstantlyClient) {
  const cursorKey = `emails_cursor_${clientId}`;
  const since = getSetting(cursorKey, "") || null;
  const emails = await api.emailsSince(since);
  if (emails.length === 0) return 0;

  const campaigns = new Map(
    all<{ id: number; instantly_campaign_id: string }>("SELECT id, instantly_campaign_id FROM campaigns WHERE client_id = ?", clientId).map((c) => [
      c.instantly_campaign_id,
      c.id,
    ]),
  );
  const leadId = (email: string | null) =>
    email ? get<{ id: number }>("SELECT id FROM leads WHERE client_id = ? AND email = ?", clientId, email.toLowerCase())?.id ?? null : null;

  let newest = since ?? "";
  let inbound = 0;
  tx(() => {
    for (const e of emails as Email[]) {
      if (e.timestamp_created > newest) newest = e.timestamp_created;
      if (e.ue_type === 4) continue; // scheduled: handled by syncScheduled
      const direction = e.ue_type === 2 ? "in" : "out";
      const text = e.body?.text || (e.body?.html ? stripHtml(e.body.html) : e.content_preview ?? "");
      const lead = e.lead?.toLowerCase() ?? null;
      const r = run(
        `INSERT OR IGNORE INTO emails (id, client_id, campaign_id, lead_id, lead_email, direction, step, account_email, subject,
           body_text, thread_id, sent_at, is_unread, interest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.id, clientId, e.campaign_id ? campaigns.get(e.campaign_id) ?? null : null, leadId(lead), lead, direction,
        e.step ? Number(e.step) || null : null, e.eaccount, e.subject,
        direction === "in" ? newestPart(text) : text,
        e.thread_id, e.timestamp_email, e.is_unread ? 1 : 0,
        direction === "in" && e.is_auto_reply ? "ooo" : null,
      );
      if (!r.changes) continue;
      const lid = leadId(lead);
      if (lid && direction === "out") run("UPDATE leads SET last_sent_at = MAX(COALESCE(last_sent_at, ''), ?) WHERE id = ?", e.timestamp_email, lid);
      if (lid && direction === "in") run("UPDATE leads SET last_reply_at = MAX(COALESCE(last_reply_at, ''), ?) WHERE id = ?", e.timestamp_email, lid);
      if (direction === "in") inbound++;
    }
  });
  setSetting(cursorKey, newest);
  if (inbound) logActivity(clientId, "reply", `${inbound} new ${inbound === 1 ? "reply" : "replies"}`);
  return emails.length;
}

async function syncScheduled(clientId: number, api: InstantlyClient) {
  // One page is plenty at this scale; it's a preview of what goes out next.
  const res = await api.scheduledEmails();
  const campaigns = new Map(
    all<{ id: number; instantly_campaign_id: string }>("SELECT id, instantly_campaign_id FROM campaigns WHERE client_id = ?", clientId).map((c) => [
      c.instantly_campaign_id,
      c.id,
    ]),
  );
  tx(() => {
    run("DELETE FROM scheduled WHERE client_id = ?", clientId);
    for (const e of res) {
      run(
        "INSERT OR REPLACE INTO scheduled (id, client_id, campaign_id, lead_email, account_email, step, subject, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        e.id, clientId, e.campaign_id ? campaigns.get(e.campaign_id) ?? null : null, e.lead, e.eaccount,
        e.step ? Number(e.step) || null : null, e.subject, e.timestamp_email,
      );
    }
  });
}

async function syncStats(clientId: number, api: InstantlyClient) {
  const campaigns = all<{ id: number; instantly_campaign_id: string; status: string }>(
    "SELECT id, instantly_campaign_id, status FROM campaigns WHERE client_id = ? AND instantly_campaign_id IS NOT NULL",
    clientId,
  );
  for (const c of campaigns) {
    const daily = await api.campaignDaily(c.instantly_campaign_id, day(30), day(0));
    for (const d of daily) {
      run(
        `INSERT INTO daily_stats (client_id, campaign_id, date, sent, opened, replied, clicked, opportunities)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id, date) DO UPDATE SET sent = excluded.sent, opened = excluded.opened, replied = excluded.replied,
           clicked = excluded.clicked, opportunities = excluded.opportunities`,
        clientId, c.id, d.date, d.sent ?? 0, d.unique_opened ?? 0, d.unique_replies ?? 0, d.unique_clicks ?? 0, d.unique_opportunities ?? 0,
      );
    }
    if (c.status === "active") {
      try {
        const s = await api.sendingStatus(c.instantly_campaign_id);
        const st = s.summary?.status;
        run("UPDATE campaigns SET not_sending = ? WHERE id = ?", st && st !== "healthy" ? s.summary?.status_message ?? st : null, c.id);
      } catch {
        // Diagnostics are nice-to-have; ignore failures.
      }
    }
  }

  const mailboxes = all<{ email: string }>("SELECT email FROM mailboxes WHERE client_id = ?", clientId).map((m) => m.email);
  for (let i = 0; i < mailboxes.length; i += 100) {
    const daily = await api.accountDaily(mailboxes.slice(i, i + 100), day(14), day(0));
    for (const d of daily) {
      run(
        `INSERT INTO mailbox_daily (client_id, email, date, sent, bounced) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(client_id, email, date) DO UPDATE SET sent = excluded.sent, bounced = excluded.bounced`,
        clientId, d.email_account, d.date, d.sent ?? 0, d.bounced ?? 0,
      );
    }
  }
  run(
    `UPDATE mailboxes SET
       sent_today = (SELECT COALESCE(SUM(sent),0) FROM mailbox_daily d WHERE d.client_id = mailboxes.client_id AND d.email = mailboxes.email AND d.date = ?),
       sent_7d = (SELECT COALESCE(SUM(sent),0) FROM mailbox_daily d WHERE d.client_id = mailboxes.client_id AND d.email = mailboxes.email AND d.date >= ?),
       bounced_7d = (SELECT COALESCE(SUM(bounced),0) FROM mailbox_daily d WHERE d.client_id = mailboxes.client_id AND d.email = mailboxes.email AND d.date >= ?)
     WHERE client_id = ?`,
    day(0), day(7), day(7), clientId,
  );
}

async function syncLeads(clientId: number, api: InstantlyClient) {
  const campaigns = all<{ id: number; instantly_campaign_id: string }>(
    "SELECT id, instantly_campaign_id FROM campaigns WHERE client_id = ? AND managed = 1 AND instantly_campaign_id IS NOT NULL AND status IN ('active','paused')",
    clientId,
  );
  for (const c of campaigns) {
    const leads = await api.leadsInCampaign(c.instantly_campaign_id);
    tx(() => {
      for (const l of leads) {
        if (!l.email) continue;
        run(
          `UPDATE leads SET instantly_status = ?, interest_status = COALESCE(?, interest_status), last_open_at = COALESCE(?, last_open_at)
           WHERE client_id = ? AND email = ?`,
          l.status, l.lt_interest_status ?? null, l.timestamp_last_open, clientId, l.email.toLowerCase(),
        );
      }
    });
  }
}

/** Pause mailboxes that break the health rules (bounce rate, warmup score). Only ever pauses; never auto-resumes. */
async function enforceHealth(clientId: number, api: InstantlyClient) {
  if (getSetting("health_auto_pause", "1") !== "1") return;
  const rules = healthRules();
  const boxes = all<{ email: string; status: number; warmup_score: number | null; sent_7d: number; bounced_7d: number; auto_paused_at: string | null }>(
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
      run(
        "UPDATE mailboxes SET status = 2, auto_paused_at = datetime('now'), auto_paused_reason = ? WHERE client_id = ? AND email = ?",
        reason, clientId, b.email,
      );
      logActivity(clientId, "auto_pause", `Paused ${b.email}: ${reason}`);
    } catch (e) {
      logActivity(clientId, "error", `Wanted to pause ${b.email} (${reason}) but Instantly said: ${(e as Error).message}`);
    }
  }
}

export async function syncClient(clientId: number): Promise<{ ok: boolean; message: string }> {
  const client = requireClient(clientId);
  if (!client.instantly_api_key || client.key_status === "error") return { ok: false, message: "Instantly not connected" };
  const api = instantly(client.instantly_api_key);
  const steps: [string, () => Promise<unknown>][] = [
    ["mailboxes", async () => upsertMailboxes(clientId, await api.accounts())],
    ["campaigns", async () => {
      const campaigns = await api.campaigns();
      upsertCampaigns(clientId, campaigns);
      const boxes = get<{ n: number }>("SELECT COUNT(*) n FROM mailboxes WHERE client_id = ?", clientId)?.n ?? 0;
      run("UPDATE clients SET key_message = ?, key_checked_at = ? WHERE id = ?", `${boxes} mailboxes, ${campaigns.length} campaigns`, new Date().toISOString(), clientId);
    }],
    ["emails", () => syncEmails(clientId, api)],
    ["scheduled", () => syncScheduled(clientId, api)],
    ["stats", () => syncStats(clientId, api)],
    ["leads", () => syncLeads(clientId, api)],
    ["health", () => enforceHealth(clientId, api)],
    ["replies", () => triageNewReplies(clientId)],
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
  setSetting(`last_sync_${clientId}`, new Date().toISOString());
  if (errors.length) {
    const message = errors.join(" | ");
    logActivity(clientId, "error", `Sync problems — ${message}`);
    return { ok: false, message };
  }
  return { ok: true, message: "Synced" };
}

declare global {
   
  var __outbound_sync_running: boolean | undefined;
}

export async function syncAll() {
  if (globalThis.__outbound_sync_running) return;
  globalThis.__outbound_sync_running = true;
  try {
    for (const c of listClients()) {
      if (c.instantly_api_key && c.key_status === "ok") await syncClient(c.id);
    }
    setSetting("last_sync_all", new Date().toISOString());
    await runWriter(); // pick up any drafting left over from a restart
  } finally {
    globalThis.__outbound_sync_running = false;
  }
}
