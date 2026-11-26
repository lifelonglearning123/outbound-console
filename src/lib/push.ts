import "server-only";
import { all, get, run, tx, logActivity, withLock } from "./db";
import { requireClient } from "./clients";
import { requireCampaign, subjectVar, bodyVar, liveSteps, hasOwnSubject } from "./campaigns";
import { instantly, type LeadInput } from "./instantly";
import { DO_NOT_CONTACT, IN_SEQUENCE, STOPPED_OUTSIDE, type LeadRow } from "./leads";
import { AT_PROBLEM_DOMAIN, BEHIND_HELD, detectMailDomains, GATEWAY_LABEL, NO_MAIL_SERVER, type Gateway } from "./mailhost";
import { NO_PUSH, type PushResult } from "./pushResult";
import { gapCutoff, gapDays } from "./gap";

export type { PushResult };

import { stripCodeFence, toHtml } from "./merge";
import { ghlCreds, linkLead } from "./ghlsync";

export { toHtml };

/**
 * Where a campaign's approved contacts stand, split exactly the way the send splits them, so the page can say
 * "sendable now" instead of a raw approved count the send button can't honour.
 */
export type ApprovedBreakdown = {
  approved: number;
  sendable: number; // will go on the next send
  held: { gateway: Gateway; n: number }[]; // behind a mail filter this campaign has paused
  blocked: number; // their company is on the client's problem companies list
  // The same person is mid-sequence in another campaign, or was emailed by one within the client's gap (gap.ts).
  waiting: { campaign: string; campaignId: number | null; n: number; why: "sequence" | "gap" }[];
  gapDays: number;
  stopped: number; // replied, bounced or unsubscribed elsewhere: the next send sets them aside
  nomail: number; // their domain has no mail server: the next send sets them aside
};

export async function approvedBreakdown(campaignId: number): Promise<ApprovedBreakdown> {
  const c = await requireCampaign(campaignId);
  const gap = await gapDays(c.client_id);
  const rows = await all<{ kind: string; label: string | null; n: number }>(
    `WITH a AS (
       SELECT l.*,
         (SELECT md.gateway FROM mail_domains md WHERE md.domain = split_part(l.email, '@', 2) AND md.gateway = ANY(?)) held_by,
         ${NO_MAIL_SERVER("l")} nomail,
         ${AT_PROBLEM_DOMAIN("l")} blocked,
         (${STOPPED_OUTSIDE("l")} OR EXISTS (SELECT 1 FROM leads o WHERE o.client_id = l.client_id AND o.email = l.email AND o.id <> l.id AND ${DO_NOT_CONTACT("o")})) stop,
         (SELECT oc.id || ':' || oc.name FROM leads o JOIN campaigns oc ON oc.id = o.campaign_id
           WHERE o.client_id = l.client_id AND o.email = l.email AND o.id <> l.id AND ${IN_SEQUENCE("o")} LIMIT 1) busy_in,
         (SELECT oc.id || ':' || oc.name FROM emails e JOIN campaigns oc ON oc.id = e.campaign_id
           WHERE e.client_id = l.client_id AND e.lead_email = l.email AND e.direction = 'out' AND e.campaign_id <> l.campaign_id AND e.sent_at >= ?
           ORDER BY e.sent_at DESC LIMIT 1) recent_in
       FROM leads l WHERE l.campaign_id = ? AND l.stage = 'approved'
     )
     SELECT CASE WHEN nomail THEN 'nomail' WHEN blocked THEN 'blocked' WHEN held_by IS NOT NULL THEN 'held' WHEN stop THEN 'stopped'
              WHEN busy_in IS NOT NULL THEN 'waiting' WHEN recent_in IS NOT NULL THEN 'gap' ELSE 'sendable' END kind,
       CASE WHEN nomail OR blocked THEN NULL WHEN held_by IS NOT NULL THEN held_by WHEN stop THEN NULL ELSE COALESCE(busy_in, recent_in) END label, COUNT(*) n
     FROM a GROUP BY 1, 2`,
    c.hold_gateways, gapCutoff(gap), campaignId,
  );
  const sum = (k: string) => rows.filter((r) => r.kind === k).reduce((s, r) => s + Number(r.n), 0);
  return {
    approved: rows.reduce((s, r) => s + Number(r.n), 0),
    sendable: sum("sendable"),
    held: rows.filter((r) => r.kind === "held").map((r) => ({ gateway: r.label as Gateway, n: Number(r.n) })),
    blocked: sum("blocked"),
    waiting: rows.filter((r) => r.kind === "waiting" || r.kind === "gap").map((r) => {
      const [id, ...name] = (r.label ?? "").split(":");
      return { campaign: name.join(":") || "another campaign", campaignId: Number(id) || null, n: Number(r.n), why: r.kind === "gap" ? ("gap" as const) : ("sequence" as const) };
    }),
    gapDays: gap,
    stopped: sum("stopped"),
    nomail: sum("nomail"),
  };
}

/**
 * Upload every approved lead of a campaign to Instantly, with its approved copy in custom variables.
 * Only leads whose every step is approved are in stage 'approved', so nothing unapproved can leave.
 * `probeIds` sends just those contacts, past the campaign's held mail filters (a test of a filter).
 * A campaign scheduled to start later keeps its approved contacts here until then (`starting`, scheduling.ts), so
 * they're checked when they go, not weeks before.
 */
export async function pushApproved(campaignId: number, opts: { onlyWaiting?: boolean; probeIds?: number[]; starting?: boolean } = {}): Promise<PushResult> {
  // One send per campaign at a time. A big send takes minutes, so a second press (or the sync) arriving meanwhile would
  // read the same approved contacts, get "duplicates" from Instantly and mark them all as errors. It waits instead:
  // `busy` says another send is already handing this campaign's contacts over.
  const r = await withLock(`push_${campaignId}`, 10 * 60_000, () => pushApprovedNow(campaignId, opts));
  return r ?? { ...NO_PUSH, busy: true };
}

async function pushApprovedNow(campaignId: number, opts: { onlyWaiting?: boolean; probeIds?: number[]; starting?: boolean }): Promise<PushResult> {
  const campaign = await requireCampaign(campaignId);
  if (!campaign.instantly_campaign_id) throw new Error("Create the campaign in the sending platform first");
  if (campaign.start_at && campaign.status === "draft" && !opts.starting) return { ...NO_PUSH };
  const client = await requireClient(campaign.client_id);
  const api = instantly(client.instantly_api_key!);

  const gap = await gapDays(campaign.client_id);
  const cutoff = gapCutoff(gap);
  const holding = opts.probeIds ? [] : campaign.hold_gateways;
  let held = 0;
  let waiting = 0;
  let stopped = 0;
  // A domain with no mail server can only bounce: set those contacts aside before anything else.
  await detectMailDomains();
  const nomail = (await all<{ id: number }>(
    `UPDATE leads l SET stage = 'rejected', stage_message = 'Not sent: their domain has no mail server, so the email could only bounce'
     WHERE l.campaign_id = ? AND l.stage = 'approved' AND ${NO_MAIL_SERVER("l")} RETURNING l.id`,
    campaignId,
  )).map((r) => r.id);
  if (nomail.length) {
    await run("UPDATE drafts SET status = 'rejected', reviewed_at = datetime('now') WHERE lead_id = ANY(?) AND status IN ('pending', 'approved')", nomail);
  }
  // Companies on the client's problem list stay approved and go out if the company is taken off the list.
  const blocked = (await run(
    `UPDATE leads l SET stage_message = ? WHERE l.campaign_id = ? AND l.stage = 'approved' AND ${AT_PROBLEM_DOMAIN("l")}`,
    "Held back: their company is on the problem companies list (see Mailboxes). Sent if it's taken off the list.",
    campaignId,
  )).changes;
  if (holding.length) {
    // Contacts behind a held filter stay approved but aren't sent.
    held = (await run(
      `UPDATE leads l SET stage_message = ? WHERE l.campaign_id = ? AND l.stage = 'approved' AND ${BEHIND_HELD("l")} AND NOT ${AT_PROBLEM_DOMAIN("l")}`,
      "Held back: this campaign isn't sending to their company's email filter (see Mail filters on the Contacts page). Sent when that filter is resumed.",
      campaignId, holding,
    )).changes;
  }
  const leads = await all<LeadRow>(
    `SELECT * FROM leads l WHERE campaign_id = @campaignId AND stage = 'approved' AND NOT ${AT_PROBLEM_DOMAIN("l")}
       ${holding.length ? `AND NOT ${BEHIND_HELD("l").replace("?", "@holding")}` : ""}
       ${opts.onlyWaiting ? "AND l.stage_message LIKE 'Waiting:%'" : ""}
       ${opts.probeIds ? "AND l.id = ANY(@probeIds)" : ""}
     ORDER BY id LIMIT 1000`,
    { campaignId, holding, probeIds: opts.probeIds ?? [] },
  );
  const result = (pushed: number, skipped: number) => ({ pushed, skipped, held, blocked, waiting, stopped, nomail: nomail.length });
  if (leads.length === 0) return result(0, 0);

  const drafts = await all<{ lead_id: number; step: number; subject: string; body: string; status: string; format: string }>(
    `SELECT lead_id, step, subject, body, status, format FROM drafts WHERE lead_id IN (${leads.map(() => "?").join(",")}) ORDER BY step`,
    ...leads.map((l) => l.id),
  );

  const outside = new Set((await all<{ id: number }>(
    `SELECT l.id FROM leads l WHERE l.id = ANY(?) AND ${STOPPED_OUTSIDE("l")}`,
    leads.map((l) => l.id),
  )).map((l) => l.id));

  // The same contacts in the client's other campaigns, looked up once for everyone rather than once per contact (a send
  // of hundreds took minutes). First row per contact wins: someone who replied, bounced or unsubscribed comes first.
  const ids = leads.map((l) => l.id);
  const othersRows = await all<{ lead_id: number; name: string; dnc: boolean }>(
    `SELECT l.id lead_id, c.name, ${DO_NOT_CONTACT("o")} dnc FROM leads l
       JOIN leads o ON o.client_id = l.client_id AND o.email = l.email AND o.id <> l.id
       JOIN campaigns c ON c.id = o.campaign_id
     WHERE l.id = ANY(?) AND (${DO_NOT_CONTACT("o")} OR ${IN_SEQUENCE("o")})
     ORDER BY l.id, 3 DESC`,
    ids,
  );
  const otherBy = new Map<number, { name: string; dnc: boolean }>();
  for (const r of othersRows) if (!otherBy.has(r.lead_id)) otherBy.set(r.lead_id, r);
  // Emailed by another campaign within the client's gap (gap.ts), latest first.
  const recentBy = new Map<number, { name: string; last: string }>();
  if (gap > 0) {
    const recentRows = await all<{ lead_id: number; name: string; last: string }>(
      `SELECT l.id lead_id, c.name, MAX(e.sent_at) last FROM leads l
         JOIN emails e ON e.client_id = l.client_id AND e.lead_email = l.email AND e.direction = 'out' AND e.campaign_id <> l.campaign_id AND e.sent_at >= ?
         JOIN campaigns c ON c.id = e.campaign_id
       WHERE l.id = ANY(?) GROUP BY l.id, c.name ORDER BY l.id, 3 DESC`,
      cutoff, ids,
    );
    for (const r of recentRows) if (!recentBy.has(r.lead_id)) recentBy.set(r.lead_id, r);
  }

  const ready: { lead: LeadRow; input: LeadInput }[] = [];
  const hasGhl = !!ghlCreds(client);
  for (const lead of leads) {
    // GHL is the source of truth: a lead must exist as a GHL contact before anything is sent to it.
    if (hasGhl && !lead.ghl_contact_id) {
      try {
        lead.ghl_contact_id = await linkLead(client, lead);
      } catch (e) {
        await run("UPDATE leads SET stage_message = ? WHERE id = ?", `Not sent: couldn't add to Nexus Portal (${(e as Error).message})`, lead.id);
        continue;
      }
    }
    const live = liveSteps(campaign);
    const mine = drafts.filter((d) => d.lead_id === lead.id && d.step <= live);
    // A hold was released while this lead waited: write the steps it's missing, then it comes back for review.
    if (mine.length < live) {
      // Nexus writes its own campaigns' emails: the contact waits for Nexus to send the rest of its words.
      if (campaign.source === "nexus") {
        await run("UPDATE leads SET stage = 'new', stage_message = 'Waiting for Nexus to send every email for this contact' WHERE id = ?", lead.id);
      } else {
        await run("UPDATE leads SET stage = 'drafting' WHERE id = ?", lead.id);
      }
      continue;
    }
    // Belt and braces: re-check approval at the last moment.
    if (mine.some((d) => d.status !== "approved")) {
      await run("UPDATE leads SET stage = 'review' WHERE id = ?", lead.id);
      continue;
    }
    // An email that should have its own subject but has none (a merge field that came out empty) would go out blank.
    const noSubject = mine.find((d) => hasOwnSubject(campaign.steps[d.step - 1], d.step - 1) && !d.subject.trim());
    if (noSubject) {
      await run("UPDATE leads SET stage = 'review', stage_message = ? WHERE id = ?", `Not sent: email ${noSubject.step} has no subject. Add one, then approve it again.`, lead.id);
      continue;
    }
    // The same contact in other campaigns: never after a reply, bounce or unsubscribe, and never two sequences at once.
    const other = otherBy.get(lead.id);
    if (other?.dnc || outside.has(lead.id)) {
      const where = other?.dnc ? `"${other.name}"` : "an earlier campaign";
      await tx(async () => {
        await run("UPDATE leads SET stage = 'rejected', stage_message = ? WHERE id = ?", `Not sent: replied, bounced or unsubscribed in ${where}`, lead.id);
        await run("UPDATE drafts SET status = 'rejected', reviewed_at = datetime('now') WHERE lead_id = ? AND status IN ('pending', 'approved')", lead.id);
      });
      stopped++;
      continue;
    }
    if (other) {
      // Stays approved; the next send picks it up once the other sequence is over.
      await run("UPDATE leads SET stage_message = ? WHERE id = ?", `Waiting: still being emailed by "${other.name}". Sent once that sequence ends.`, lead.id);
      waiting++;
      continue;
    }
    // Emailed by another campaign lately: wait out the client's gap so nobody gets two campaigns days or hours apart.
    const recent = recentBy.get(lead.id);
    if (recent) {
      const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
      const last = Date.parse(recent.last);
      await run(
        "UPDATE leads SET stage_message = ? WHERE id = ?",
        `Waiting: emailed by "${recent.name}" on ${day(last)}. Sent from ${day(last + gap * 86400_000)}, so nobody gets two campaigns within ${gap} days.`,
        lead.id,
      );
      waiting++;
      continue;
    }
    const vars = copyVars(mine);
    ready.push({
      lead,
      input: {
        email: lead.email,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company_name: lead.company,
        job_title: lead.title,
        phone: lead.phone,
        website: lead.website,
        custom_variables: vars,
      },
    });
  }
  if (ready.length === 0) return result(0, 0);

  const res = await api.addLeads(campaign.instantly_campaign_id, ready.map((r) => r.input));
  const created = new Map((res.created_leads ?? []).map((c) => [c.index, c.id]));
  const now = new Date().toISOString();
  // Recorded in two statements rather than one per contact.
  const added = ready.flatMap((r, i) => (created.get(i) ? [{ id: r.lead.id, iid: created.get(i)! }] : []));
  const refused = ready.filter((_, i) => !created.get(i)).map((r) => r.lead.id);
  const pushed = added.length;
  const skipped = refused.length;
  await tx(async () => {
    if (added.length) {
      await run(
        `UPDATE leads SET stage = 'pushed', instantly_lead_id = x.iid, instantly_status = 1, pushed_at = ?, stage_message = NULL, probe = ?
         FROM jsonb_to_recordset(?::jsonb) AS x(id int, iid text) WHERE leads.id = x.id`,
        now, opts.probeIds ? 1 : 0, JSON.stringify(added),
      );
    }
    if (refused.length) {
      await run(
        "UPDATE leads SET stage = 'error', stage_message = ? WHERE id = ANY(?)",
        "The sending platform didn't add this lead (already in the campaign, on the blocklist, or invalid email)", refused,
      );
    }
  });
  await logActivity(
    client.id,
    "push",
    `Sent ${pushed} approved leads to "${campaign.name}"${opts.probeIds ? " as a test past its held mail filters" : ""}` +
      (skipped ? ` (${skipped} skipped by the sending platform: ${res.duplicated_leads} duplicates, ${res.in_blocklist} blocklisted, ${res.invalid_email_count} invalid)` : ""),
  );
  return result(pushed, skipped);
}

/**
 * Keep the "Sent once that sequence ends" promise: retry contacts that were approved and sent, but waited because
 * another campaign was still emailing them. Only those; anything newly approved still needs someone to press Send.
 */
export async function sendWaiting(clientId: number): Promise<number> {
  const campaigns = await all<{ id: number }>(
    `SELECT DISTINCT l.campaign_id id FROM leads l JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.client_id = ? AND l.stage = 'approved' AND l.stage_message LIKE 'Waiting:%'
       AND c.managed = 1 AND c.instantly_campaign_id IS NOT NULL AND c.status IN ('active', 'paused', 'draft') AND c.archived_at IS NULL`,
    clientId,
  );
  let pushed = 0;
  for (const c of campaigns) pushed += (await pushApproved(c.id, { onlyWaiting: true })).pushed;
  return pushed;
}

/**
 * Send a test batch past a held mail filter: `n` approved contacts behind it go out, so its bounce rate can be measured
 * before deciding. The rest stay held.
 */
export async function probeFilter(campaignId: number, gateway: Gateway, n = 10): Promise<PushResult> {
  // Only contacts that can go now: not on the problem list, and not stopped or mid-sequence in another campaign.
  const ids = (await all<{ id: number }>(
    `SELECT l.id FROM leads l JOIN mail_domains md ON md.domain = split_part(l.email, '@', 2)
     WHERE l.campaign_id = ? AND l.stage = 'approved' AND md.gateway = ? AND NOT ${AT_PROBLEM_DOMAIN("l")} AND NOT ${STOPPED_OUTSIDE("l")}
       AND NOT EXISTS (SELECT 1 FROM leads o WHERE o.client_id = l.client_id AND o.email = l.email AND o.id <> l.id
         AND (${DO_NOT_CONTACT("o")} OR ${IN_SEQUENCE("o")}))
     ORDER BY l.id LIMIT ?`,
    campaignId, gateway, n,
  )).map((r) => r.id);
  if (ids.length === 0) return { pushed: 0, skipped: 0, held: 0, blocked: 0, waiting: 0, stopped: 0, nomail: 0 };
  return pushApproved(campaignId, { probeIds: ids });
}

/** SQL with one `?` (a text[] of gateways): leads already in Instantly, behind one of them, not emailed yet (as far as the last sync knows). */
const HELD_NOT_YET_EMAILED = `l.stage = 'pushed' AND l.instantly_lead_id IS NOT NULL AND l.last_sent_at IS NULL
  AND COALESCE(l.instantly_status, 1) = 1 AND ${BEHIND_HELD("l")}`;

/** How many of a campaign's loaded-but-unemailed leads sit behind its held filters (0 when nothing is held). */
export async function heldNotYetEmailed(campaignId: number): Promise<number> {
  const campaign = await requireCampaign(campaignId);
  if (campaign.hold_gateways.length === 0) return 0;
  return (await all<{ n: number }>(
    `SELECT COUNT(*) n FROM leads l WHERE l.campaign_id = ? AND ${HELD_NOT_YET_EMAILED}`,
    campaignId, campaign.hold_gateways,
  ))[0]?.n ?? 0;
}

/**
 * Take contacts behind the campaign's held filters back out of Instantly before it emails them: each is checked with
 * Instantly first (anyone it has already emailed stays), removed there, and goes back to approved and held.
 */
export async function pullBackHeld(campaignId: number): Promise<{ pulled: number; alreadyEmailed: number }> {
  const campaign = await requireCampaign(campaignId);
  const client = await requireClient(campaign.client_id);
  if (campaign.hold_gateways.length === 0) return { pulled: 0, alreadyEmailed: 0 };
  const api = instantly(client.instantly_api_key!);
  const leads = await all<{ id: number; instantly_lead_id: string }>(
    `SELECT l.id, l.instantly_lead_id FROM leads l WHERE l.campaign_id = ? AND ${HELD_NOT_YET_EMAILED} ORDER BY l.id`,
    campaignId, campaign.hold_gateways,
  );
  let pulled = 0;
  let alreadyEmailed = 0;
  for (let i = 0; i < leads.length; i += 5) {
    await Promise.all(leads.slice(i, i + 5).map(async (l) => {
      const live = await api.getLead(l.instantly_lead_id);
      if (live.timestamp_last_contact || live.status !== 1) {
        alreadyEmailed++;
        return;
      }
      await api.deleteLead(l.instantly_lead_id);
      await run(
        `UPDATE leads SET stage = 'approved', pushed_at = NULL, instantly_lead_id = NULL, instantly_status = NULL, stage_message = ?
         WHERE id = ? AND stage = 'pushed'`,
        "Held back: this campaign isn't sending to their company's email filter (see Mail filters on the Contacts page). Taken back out of the sending platform before it was sent.",
        l.id,
      );
      pulled++;
    }));
  }
  await logActivity(
    client.id,
    "push",
    `Took ${pulled} contacts behind ${campaign.hold_gateways.map((g) => GATEWAY_LABEL[g]).join(", ")} back out of "${campaign.name}" before they were emailed` +
      (alreadyEmailed ? ` (${alreadyEmailed} had already been emailed, so they stay)` : ""),
  );
  return { pulled, alreadyEmailed };
}

/**
 * Instantly turns every newline in a body into <br>. In designed HTML the newlines are only layout
 * whitespace (a space when rendered), but as <br>s between table rows browsers hoist them above the
 * table, leaving a big empty band at the top. Newlines become spaces, so the email looks exactly as designed.
 */
export const flattenHtml = (html: string) => stripCodeFence(html).replace(/<!doctype[^>]*>/gi, "").replace(/\s*\r?\n\s*/g, " ").trim();

type DraftCopy = { step: number; subject: string; body: string; format: string };

/** The custom variables that carry a lead's approved copy into Instantly's placeholder steps. */
export function copyVars(drafts: DraftCopy[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const d of drafts) {
    if (d.step === 1 || d.subject) vars[subjectVar(d.step)] = d.subject;
    // Designed emails (html) go out as approved; AI plain text keeps its line breaks.
    vars[bodyVar(d.step)] = d.format === "html" ? flattenHtml(d.body) : toHtml(d.body);
  }
  return vars;
}

