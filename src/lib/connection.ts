import "server-only";
import { all, run, get, logActivity, tx } from "./db";
import { requireClient } from "./clients";
import { ensureTag, sharingProblem } from "./scope";
import { instantly, type Account, type Campaign } from "./instantly";

export function campaignState(status: number): string {
  if (status === 0) return "draft";
  if (status === 1 || status === 4) return "active";
  if (status === 2) return "paused";
  if (status === 3) return "completed";
  return "error";
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",") || "NULL";

/** Store the client's mailboxes and drop any it no longer owns (e.g. untagged in shared-workspace mode). */
export function upsertMailboxes(clientId: number, accounts: Account[]) {
  const now = new Date().toISOString();
  const emails = accounts.map((a) => a.email);
  run(`DELETE FROM mailboxes WHERE client_id = ? AND email NOT IN (${placeholders(emails.length)})`, clientId, ...emails);
  run(`DELETE FROM mailbox_daily WHERE client_id = ? AND email NOT IN (${placeholders(emails.length)})`, clientId, ...emails);
  for (const a of accounts) {
    run(
      `INSERT INTO mailboxes (client_id, email, status, warmup_status, warmup_score, daily_limit, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id, email) DO UPDATE SET status = excluded.status, warmup_status = excluded.warmup_status,
         warmup_score = excluded.warmup_score, daily_limit = excluded.daily_limit, last_synced_at = excluded.last_synced_at`,
      clientId, a.email, a.status, a.warmup_status, a.stat_warmup_score, a.daily_limit, now,
    );
  }
}

/**
 * Insert campaigns we don't know yet (created directly in Instantly), refresh status on all of them,
 * and forget external campaigns the client no longer owns. Campaigns built here are never dropped.
 */
export function upsertCampaigns(clientId: number, campaigns: Campaign[]) {
  const now = new Date().toISOString();
  const ids = campaigns.map((c) => c.id);
  const gone = all<{ id: number }>(
    `SELECT id FROM campaigns WHERE client_id = ? AND managed = 0 AND instantly_campaign_id NOT IN (${placeholders(ids.length)})`,
    clientId, ...ids,
  );
  for (const g of gone) {
    run("DELETE FROM daily_stats WHERE campaign_id = ?", g.id);
    run("DELETE FROM scheduled WHERE campaign_id = ?", g.id);
    run("UPDATE emails SET campaign_id = NULL WHERE campaign_id = ?", g.id);
    run("DELETE FROM campaigns WHERE id = ?", g.id);
  }
  for (const c of campaigns) {
    const existing = get<{ id: number }>(
      "SELECT id FROM campaigns WHERE client_id = ? AND instantly_campaign_id = ?",
      clientId, c.id,
    );
    if (existing) {
      run(
        `UPDATE campaigns SET name = ?, status = ?, instantly_status = ?, daily_limit = COALESCE(?, daily_limit),
           accounts = ?, last_synced_at = ? WHERE id = ?`,
        c.name, campaignState(c.status), c.status, c.daily_limit, JSON.stringify(c.email_list ?? []), now, existing.id,
      );
    } else {
      const sched = c.campaign_schedule?.schedules?.[0];
      run(
        `INSERT INTO campaigns (client_id, instantly_campaign_id, name, status, instantly_status, daily_limit, accounts,
           schedule, stop_on_reply, managed, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        clientId, c.id, c.name, campaignState(c.status), c.status, c.daily_limit ?? 0,
        JSON.stringify(c.email_list ?? []),
        JSON.stringify(sched ? {
          days: Object.entries(sched.days).filter(([, on]) => on).map(([d]) => Number(d)),
          from: sched.timing.from, to: sched.timing.to, timezone: sched.timezone,
        } : {}),
        c.stop_on_reply === false ? 0 : 1, now,
      );
    }
  }
}

/** Shared mode: drop emails sent or received by mailboxes this client doesn't own. */
export function pruneForeignEmails(clientId: number) {
  run(
    "DELETE FROM emails WHERE client_id = ? AND account_email NOT IN (SELECT email FROM mailboxes WHERE client_id = ?)",
    clientId, clientId,
  );
}

/** Validate a client's Instantly key and pull its workspace, mailboxes and campaigns. */
export async function checkConnection(clientId: number): Promise<{ ok: boolean; message: string }> {
  const client = requireClient(clientId);
  const now = new Date().toISOString();
  if (!client.instantly_api_key) {
    run("UPDATE clients SET key_status = 'error', key_message = ?, key_checked_at = ? WHERE id = ?", "No API key saved", now, clientId);
    return { ok: false, message: "No API key saved" };
  }
  const api = instantly(client.instantly_api_key);
  try {
    const ws = await api.workspace();
    run("UPDATE clients SET instantly_workspace_id = ?, instantly_workspace_name = ? WHERE id = ?", ws.id, ws.name, clientId);
    client.instantly_workspace_id = ws.id;
    const problem = sharingProblem(client);
    if (problem) {
      run("UPDATE clients SET key_status = 'error', key_message = ?, key_checked_at = ? WHERE id = ?", problem, now, clientId);
      logActivity(clientId, "error", problem);
      return { ok: false, message: problem };
    }
    const tagId = await ensureTag(api, client);
    const [accounts, campaigns] = await Promise.all([api.accounts(tagId), api.campaigns(tagId)]);
    const scope = tagId ? ` tagged "${client.instantly_tag_label}"` : "";
    tx(() => {
      run(
        "UPDATE clients SET key_status = 'ok', key_message = ?, key_checked_at = ? WHERE id = ?",
        `${accounts.length} mailboxes, ${campaigns.length} campaigns${scope}`, now, clientId,
      );
      upsertMailboxes(clientId, accounts);
      upsertCampaigns(clientId, campaigns);
      if (tagId) pruneForeignEmails(clientId);
    });
    const message = `Connected to "${ws.name}": ${accounts.length} mailboxes, ${campaigns.length} campaigns${scope}`;
    logActivity(clientId, "connect", message);
    return { ok: true, message };
  } catch (e) {
    const message = (e as Error).message;
    run("UPDATE clients SET key_status = 'error', key_message = ?, key_checked_at = ? WHERE id = ?", message, now, clientId);
    logActivity(clientId, "error", message);
    return { ok: false, message };
  }
}
