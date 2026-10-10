import "server-only";
import { all, get } from "./db";

export type QueueDraft = { id: number; step: number; subject: string; body: string; edited: number; flags: string | null; format: string };
export type QueueLead = {
  id: number;
  client_id: number;
  client_name: string;
  campaign_id: number;
  campaign_name: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  website: string | null;
  fields: Record<string, string>;
  drafts: QueueDraft[];
  extending: boolean; // already in Instantly; these are its next emails after a hold
};

export async function reviewQueue(clientId: number | null, limit = 200, campaignId: number | null = null): Promise<QueueLead[]> {
  const leads = await all<Omit<QueueLead, "drafts" | "fields" | "extending"> & { fields: string; stage: string; hold_after: number | null }>(
    `SELECT l.id, l.client_id, cl.name client_name, l.campaign_id, c.name campaign_name, l.email, l.first_name, l.last_name,
            l.company, l.title, l.website, l.fields, l.stage, c.hold_after
     FROM leads l JOIN campaigns c ON c.id = l.campaign_id JOIN clients cl ON cl.id = l.client_id
     WHERE l.stage IN ('review', 'extend_review') AND l.verification IN ('verified', 'catch_all')
       ${clientId ? "AND l.client_id = ?" : ""} ${campaignId ? "AND l.campaign_id = ?" : ""}
     ORDER BY l.verification = 'verified' DESC, l.id LIMIT ?`,
    ...(clientId ? [clientId] : []), ...(campaignId ? [campaignId] : []), limit,
  );
  if (leads.length === 0) return [];
  const drafts = await all<QueueDraft & { lead_id: number }>(
    `SELECT id, lead_id, step, subject, body, edited, flags, format FROM drafts WHERE lead_id IN (${leads.map(() => "?").join(",")}) ORDER BY step`,
    ...leads.map((l) => l.id),
  );
  return leads.map((l) => {
    let fields: Record<string, string> = {};
    try {
      fields = JSON.parse(l.fields || "{}");
    } catch {}
    const extending = l.stage === "extend_review";
    // For a lead already in Instantly, only its new (post-hold) emails need a decision.
    const mine = drafts.filter((d) => d.lead_id === l.id && (!extending || d.step > (l.hold_after ?? 0)));
    return { ...l, fields, drafts: mine, extending };
  });
}

export async function approvalCounts(clientId: number | null, campaignId: number | null = null) {
  return (
    await get<{ review: number; approved: number; drafting: number }>(
      `SELECT COUNT(*) FILTER (WHERE stage IN ('review','extend_review') AND verification IN ('verified', 'catch_all')) review, COUNT(*) FILTER (WHERE stage = 'approved') approved,
              COUNT(*) FILTER (WHERE stage IN ('drafting','extending')) drafting
       FROM leads WHERE 1 = 1 ${clientId ? "AND client_id = ?" : ""} ${campaignId ? "AND campaign_id = ?" : ""}`,
      ...(clientId ? [clientId] : []),
    ) ?? { review: 0, approved: 0, drafting: 0 }
  );
}
