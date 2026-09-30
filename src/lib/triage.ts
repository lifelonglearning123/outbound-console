import "server-only";
import OpenAI from "openai";
import { all, get, run, logActivity } from "./db";
import { requireClient } from "./clients";
import { instantly } from "./instantly";
import { addNote, createOpportunity, upsertContact } from "./ghl";
import { toDate } from "./format";

export const INTEREST_LABELS: Record<string, string> = {
  interested: "Interested",
  not_now: "Not now",
  not_interested: "Not interested",
  wrong_person: "Wrong person",
  unsubscribe: "Unsubscribe",
  ooo: "Out of office",
  other: "Other",
};

// Instantly's own interest values, so tagging here also updates the lead there.
const TO_INSTANTLY: Record<string, number | null> = {
  interested: 1,
  not_interested: -1,
  wrong_person: -2,
  ooo: 0,
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["interest", "reason"],
  properties: {
    interest: { type: "string", enum: Object.keys(INTEREST_LABELS) },
    reason: { type: "string", description: "One short sentence for the operator." },
  },
} as const;

async function classify(subject: string, body: string): Promise<{ interest: string; reason: string }> {
  if (!process.env.OPENAI_API_KEY) return { interest: "other", reason: "No OpenAI key; not classified" };
  const res = await new OpenAI().responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5.5",
    reasoning: { effort: "low" },
    instructions:
      "Classify a reply to a cold sales email. interested = wants to talk, asks for info/pricing, suggests a time, or refers to a colleague who should be contacted. " +
      "not_now = open but timing is wrong. not_interested = a no. wrong_person = says they aren't the right contact without pointing to someone. " +
      "unsubscribe = asks to be removed or threatens to report spam. ooo = automatic out-of-office or auto-reply. other = anything else.",
    input: `Subject: ${subject}\n\n${body.slice(0, 4000)}`,
    text: { format: { type: "json_schema", name: "reply_interest", schema: SCHEMA, strict: true } },
  });
  return JSON.parse(res.output_text);
}

/** Send an interested reply to the client's GHL: contact, opportunity (if a stage is set), and a note with the reply. */
export async function pushToGhl(emailId: string): Promise<string> {
  const e = get<{ client_id: number; lead_email: string; lead_id: number | null; subject: string; body_text: string; sent_at: string; campaign_id: number | null }>(
    "SELECT * FROM emails WHERE id = ?",
    emailId,
  );
  if (!e) throw new Error("Email not found");
  const client = requireClient(e.client_id);
  if (!client.ghl_location_id || !client.ghl_token) throw new Error("GHL not set up for this client");
  const creds = { locationId: client.ghl_location_id, token: client.ghl_token };
  const lead = e.lead_id
    ? get<{ first_name: string | null; last_name: string | null; company: string | null; phone: string | null; ghl_contact_id: string | null }>(
        "SELECT * FROM leads WHERE id = ?",
        e.lead_id,
      )
    : undefined;
  const campaign = e.campaign_id ? get<{ name: string }>("SELECT name FROM campaigns WHERE id = ?", e.campaign_id) : undefined;

  const contactId = await upsertContact(creds, {
    email: e.lead_email,
    firstName: lead?.first_name,
    lastName: lead?.last_name,
    companyName: lead?.company,
    phone: lead?.phone,
    tags: ["cold-email-reply", "interested"],
  });
  if (e.lead_id) run("UPDATE leads SET ghl_contact_id = ? WHERE id = ?", contactId, e.lead_id);

  let oppNote = "no pipeline stage set";
  if (client.ghl_pipeline_id && client.ghl_stage_id) {
    const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || e.lead_email;
    try {
      await createOpportunity(creds, {
        contactId,
        pipelineId: client.ghl_pipeline_id,
        stageId: client.ghl_stage_id,
        name: `${name}${lead?.company ? ` (${lead.company})` : ""} — cold email`,
      });
      oppNote = "opportunity created";
    } catch (err) {
      // GHL refuses a second open opportunity for the same contact in a pipeline; the note still lands.
      oppNote = `opportunity not created: ${(err as Error).message}`;
    }
  }
  await addNote(
    creds,
    contactId,
    `Interested reply to cold email${campaign ? ` (campaign: ${campaign.name})` : ""}, received ${e.sent_at}\n\nSubject: ${e.subject}\n\n${e.body_text}`,
  );
  const msg = `Contact + note added, ${oppNote}`;
  run("UPDATE emails SET ghl_pushed_at = datetime('now'), ghl_message = ? WHERE id = ?", msg, emailId);
  logActivity(e.client_id, "ghl", `${e.lead_email}: ${msg}`);
  return msg;
}

/** Record the operator's (or AI's) interest tag, mirror it to Instantly, and act on it. */
export async function applyInterest(emailId: string, interest: string, reason: string | null, source: "ai" | "manual") {
  const e = get<{ client_id: number; lead_email: string; lead_id: number | null; campaign_id: number | null; ghl_pushed_at: string | null; sent_at: string }>(
    "SELECT * FROM emails WHERE id = ?",
    emailId,
  );
  if (!e) return;
  run("UPDATE emails SET interest = ?, interest_reason = ? WHERE id = ?", interest, reason, emailId);
  const client = requireClient(e.client_id);
  const api = client.instantly_api_key ? instantly(client.instantly_api_key) : null;
  const campaign = e.campaign_id ? get<{ instantly_campaign_id: string | null }>("SELECT instantly_campaign_id FROM campaigns WHERE id = ?", e.campaign_id) : undefined;

  if (api && campaign?.instantly_campaign_id && interest in TO_INSTANTLY) {
    try {
      await api.setInterest(e.lead_email, campaign.instantly_campaign_id, TO_INSTANTLY[interest]);
      if (e.lead_id) run("UPDATE leads SET interest_status = ? WHERE id = ?", TO_INSTANTLY[interest], e.lead_id);
    } catch (err) {
      logActivity(e.client_id, "error", `Couldn't set interest in Instantly for ${e.lead_email}: ${(err as Error).message}`);
    }
  }
  if (interest === "unsubscribe" && api) {
    try {
      await api.blockEmail(e.lead_email);
      logActivity(e.client_id, "unsubscribe", `${e.lead_email} asked to be removed; added to the Instantly blocklist`);
    } catch (err) {
      logActivity(e.client_id, "error", `Couldn't blocklist ${e.lead_email}: ${(err as Error).message}`);
    }
  }
  // The first sync imports the workspace's whole history; only replies that arrive after the client
  // was added go to GHL automatically. Older ones can still be sent by hand from the inbox.
  const isNew = toDate(e.sent_at) >= toDate(client.created_at);
  if (interest === "interested" && (source === "manual" || isNew) && !e.ghl_pushed_at && client.ghl_location_id && client.ghl_token) {
    try {
      await pushToGhl(emailId);
    } catch (err) {
      run("UPDATE emails SET ghl_message = ? WHERE id = ?", `GHL failed: ${(err as Error).message}`, emailId);
      logActivity(e.client_id, "error", `GHL push failed for ${e.lead_email}: ${(err as Error).message}`);
    }
  }
  if (source === "manual") logActivity(e.client_id, "tag", `${e.lead_email} tagged ${INTEREST_LABELS[interest] ?? interest}`);
}

/** Classify every inbound email that has no interest tag yet. */
export async function triageNewReplies(clientId: number) {
  const rows = all<{ id: string; subject: string; body_text: string }>(
    "SELECT id, subject, body_text FROM emails WHERE client_id = ? AND direction = 'in' AND interest IS NULL ORDER BY sent_at LIMIT 50",
    clientId,
  );
  for (const r of rows) {
    try {
      const c = await classify(r.subject ?? "", r.body_text ?? "");
      await applyInterest(r.id, c.interest, c.reason, "ai");
    } catch (err) {
      logActivity(clientId, "error", `Couldn't classify a reply: ${(err as Error).message}`);
      break;
    }
  }
}
