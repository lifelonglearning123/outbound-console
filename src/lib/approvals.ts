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
};

export function reviewQueue(clientId: number | null, limit = 200): QueueLead[] {
  const leads = all<Omit<QueueLead, "drafts" | "fields"> & { fields: string }>(
    `SELECT l.id, l.client_id, cl.name client_name, l.campaign_id, c.name campaign_name, l.email, l.first_name, l.last_name,
            l.company, l.title, l.website, l.fields
     FROM leads l JOIN campaigns c ON c.id = l.campaign_id JOIN clients cl ON cl.id = l.client_id
     WHERE l.stage = 'review' ${clientId ? "AND l.client_id = ?" : ""}
     ORDER BY l.id LIMIT ?`,
    ...(clientId ? [clientId, limit] : [limit]),
  );
  if (leads.length === 0) return [];
  const drafts = all<QueueDraft & { lead_id: number }>(
    `SELECT id, lead_id, step, subject, body, edited, flags, format FROM drafts WHERE lead_id IN (${leads.map(() => "?").join(",")}) ORDER BY step`,
    ...leads.map((l) => l.id),
  );
  return leads.map((l) => {
    let fields: Record<string, string> = {};
    try {
      fields = JSON.parse(l.fields || "{}");
    } catch {}
    return { ...l, fields, drafts: drafts.filter((d) => d.lead_id === l.id) };
  });
}

export function approvalCounts(clientId: number | null) {
  return (
    get<{ review: number; approved: number; drafting: number }>(
      `SELECT COALESCE(SUM(stage = 'review'),0) review, COALESCE(SUM(stage = 'approved'),0) approved,
              COALESCE(SUM(stage = 'drafting'),0) drafting
       FROM leads ${clientId ? "WHERE client_id = ?" : ""}`,
      ...(clientId ? [clientId] : []),
    ) ?? { review: 0, approved: 0, drafting: 0 }
  );
}
