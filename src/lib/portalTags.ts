import "server-only";
import { all, get, run, logActivity, withLock } from "./db";
import { requireClient, type Client } from "./clients";
import { ghlCreds, linkLead } from "./ghlsync";
import { addContactTags, GhlError } from "./ghl";
import type { LeadRow } from "./leads";

/**
 * Tags added to contacts in the Nexus Portal from a people list ("tag these 120 'webinar invite'"), so the client can
 * build lists and run workflows on them there. The portal takes tags one contact at a time, so they're queued in
 * lead_tags and applied by a resumable background job: after the request that queued them, on page views while any
 * are waiting, and on each sync. A contact not in the portal yet is added to it first. Tagging never removes anything.
 */

const PORTAL = "Nexus Portal";
const CONCURRENCY = 3; // the portal allows bursts of 100 per 10s; keep well under it
const BUDGET_MS = 240_000;

/** A tag as the portal keeps it: lowercase, single spaces. */
export const cleanTag = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 100);

/** Queue one tag for these contacts. Ones already tagged (or waiting) are left alone; failed ones are tried again. */
export async function queuePortalTag(clientId: number, leadIds: number[], tag: string): Promise<number> {
  if (leadIds.length === 0) return 0;
  return (await run(
    `INSERT INTO lead_tags (client_id, lead_id, tag)
     SELECT ?, id, ? FROM leads WHERE client_id = ? AND id = ANY(?)
     ON CONFLICT (lead_id, tag) DO UPDATE SET status = 'queued', error = NULL, queued_at = EXCLUDED.queued_at WHERE lead_tags.status = 'error'`,
    clientId, tag, clientId, leadIds,
  )).changes;
}

/** Put a client's failed tags back in the queue. */
export async function retryPortalTags(clientId: number): Promise<number> {
  return (await run("UPDATE lead_tags SET status = 'queued', error = NULL WHERE client_id = ? AND status = 'error'", clientId)).changes;
}

export type PortalTagStatus = { queued: number; failed: number; lastError: string | null };

/** How the client's portal tagging is going, for the people list. */
export async function portalTagStatus(clientId: number): Promise<PortalTagStatus> {
  const s = await get<{ queued: number; failed: number; last_error: string | null }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'queued') queued, COUNT(*) FILTER (WHERE status = 'error') failed,
       (SELECT error FROM lead_tags WHERE client_id = @clientId AND status = 'error' ORDER BY id DESC LIMIT 1) last_error
     FROM lead_tags WHERE client_id = @clientId`,
    { clientId },
  );
  return { queued: s?.queued ?? 0, failed: s?.failed ?? 0, lastError: s?.last_error ?? null };
}

export async function runPortalTagging() {
  await withLock("portal_tags", 10 * 60_000, tagAll);
}

type Job = { id: number; client_id: number; lead_id: number; tag: string };

async function tagAll() {
  const deadline = Date.now() + BUDGET_MS;
  const stopped = new Set<number>();
  const clients = new Map<number, Client>();
  const clientFor = async (id: number) => {
    if (!clients.has(id)) clients.set(id, await requireClient(id));
    return clients.get(id)!;
  };
  const tagged = new Map<string, { clientId: number; tag: string; n: number }>();

  while (Date.now() < deadline) {
    const skip = stopped.size ? `AND client_id NOT IN (${[...stopped].join(",")})` : "";
    const batch = await all<Job>(`SELECT id, client_id, lead_id, tag FROM lead_tags WHERE status = 'queued' ${skip} ORDER BY id LIMIT ?`, CONCURRENCY);
    if (batch.length === 0) break;

    const results = await Promise.allSettled(batch.map(async (j) => tagOne(j, await clientFor(j.client_id))));
    for (const [i, r] of results.entries()) {
      const j = batch[i];
      if (r.status === "fulfilled") {
        const key = `${j.client_id}\t${j.tag}`;
        tagged.set(key, { clientId: j.client_id, tag: j.tag, n: (tagged.get(key)?.n ?? 0) + 1 });
        continue;
      }
      const e = r.reason as Error;
      const status = e instanceof GhlError ? e.status : 0;
      if (status === 401 || status === 403) {
        // The token can't tag: stop this client's queue rather than fail every contact one by one.
        if (stopped.has(j.client_id)) continue;
        stopped.add(j.client_id);
        await run("UPDATE lead_tags SET status = 'error', error = ? WHERE client_id = ? AND status = 'queued'", e.message, j.client_id);
        await logActivity(j.client_id, "error", `${PORTAL} tagging stopped: ${e.message}. Check the portal token in Settings, then try again.`);
      } else {
        await run("UPDATE lead_tags SET status = 'error', error = ? WHERE id = ?", e.message, j.id);
      }
    }
    if (results.every((r) => r.status === "rejected")) break;
  }

  for (const t of tagged.values()) await logActivity(t.clientId, "ghl", `Tagged ${t.n} contacts "${t.tag}" in the ${PORTAL}`);
}

async function tagOne(j: Job, client: Client) {
  const creds = ghlCreds(client);
  if (!creds) throw new Error(`the ${PORTAL} isn't connected`);
  const lead = await get<LeadRow>("SELECT * FROM leads WHERE id = ?", j.lead_id);
  if (!lead) throw new Error("the contact is no longer here");
  const contactId = lead.ghl_contact_id ?? (await linkLead(client, lead));
  if (!contactId) throw new Error(`couldn't add the contact to the ${PORTAL}`);
  await addContactTags(creds, contactId, [j.tag]);
  await run("UPDATE lead_tags SET status = 'done', error = NULL, done_at = datetime('now') WHERE id = ?", j.id);
}
