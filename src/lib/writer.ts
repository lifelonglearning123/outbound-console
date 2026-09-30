import "server-only";
import OpenAI from "openai";
import { all, get, run, tx, logActivity } from "./db";
import { requireClient, type Brief } from "./clients";
import { requireCampaign, type Step } from "./campaigns";
import type { LeadRow } from "./leads";
import { htmlToText, renderMerge } from "./merge";

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const CONCURRENCY = 4;

let openai: OpenAI | null = null;
function ai(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set in .env.local");
  openai ??= new OpenAI();
  return openai;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["emails", "flags"],
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "subject", "body"],
        properties: {
          step: { type: "integer" },
          subject: { type: "string", description: "Only for step 1; empty string for follow-ups." },
          body: { type: "string", description: "Plain text. Greeting + body only; no sign-off or signature." },
        },
      },
    },
    flags: {
      type: "array",
      items: { type: "string" },
      description: "Short notes for the human reviewer about anything uncertain (missing name, odd data, weak fit). Empty if none.",
    },
  },
} as const;

function systemPrompt(brief: Brief): string {
  return [
    "You write cold outbound emails that a human will review before they are sent. Write like a busy, thoughtful person, not a marketer.",
    "",
    "Rules:",
    "- Plain text only. No links, no images, no bullet lists, no emojis, no bold.",
    "- Short sentences. Short paragraphs separated by one blank line.",
    "- Step 1 subject: 2-5 words, lowercase except names, no punctuation tricks, no clickbait.",
    "- Follow-up steps are replies in the same thread: subject must be an empty string, and they must make sense after the previous emails.",
    "- Open with the person's first name if known (e.g. 'Hi Sam,'). If no first name, use 'Hi there,' and add a flag.",
    "- Use ONLY facts in the lead record and the brief. Never invent numbers, clients, results, mutual connections, or things you 'noticed'.",
    "- If a lead field looks like junk (placeholder, all caps, generic mailbox like info@), work around it and add a flag.",
    "- End each body with the call to action or a simple closing line. Do NOT add a sign-off or signature; it is appended automatically.",
    "- Avoid spam-trigger phrasing: 'free', 'guarantee', 'act now', 'limited time', '100%', excessive exclamation marks.",
    "",
    "Client brief:",
    `Offer: ${brief.offer ?? "(not given)"}`,
    `Ideal customer: ${brief.icp ?? "(not given)"}`,
    `Proof points you may use: ${brief.proof ?? "(none — do not claim any results)"}`,
    `Call to action: ${brief.cta ?? "a soft question asking if it's worth a short call"}`,
    `Tone: ${brief.tone ?? "plain British English, peer to peer, warm but brief"}`,
    `Never say: ${brief.avoid ?? "(nothing extra)"}`,
  ].join("\n");
}

function leadRecord(l: LeadRow): string {
  let extra: Record<string, string> = {};
  try {
    extra = JSON.parse(l.fields || "{}");
  } catch {}
  const rec: Record<string, string> = {};
  const put = (k: string, v: string | null) => {
    if (v && v.trim()) rec[k] = v.trim();
  };
  put("first_name", l.first_name);
  put("last_name", l.last_name);
  put("company", l.company);
  put("job_title", l.title);
  put("website", l.website);
  for (const [k, v] of Object.entries(extra)) put(k, String(v ?? ""));
  rec.email_domain = l.email.split("@")[1] ?? "";
  return JSON.stringify(rec, null, 2);
}

type Rendered = { subject: string; body: string };

function stepsPrompt(steps: Step[], fixed: (Rendered | null)[]): string {
  return steps
    .map((s, i) => {
      const head = `Step ${i + 1}${i === 0 ? " (opener)" : ` (follow-up, sent ${steps[i - 1].delay_days} days after step ${i})`}`;
      const f = fixed[i];
      if (f) {
        return `${head}: ALREADY WRITTEN by the client and sent exactly as below. Do not return it; make your emails fit after it without repeating it.\n---\n${f.subject ? `Subject: ${f.subject}\n` : ""}${htmlToText(f.body)}\n---`;
      }
      return `${head}: ${s.instructions}`;
    })
    .join("\n");
}

/** Fill a "My text" step for one lead. */
function renderFixed(step: Step, lead: LeadRow): Rendered & { notes: string[] } {
  let fields: Record<string, string> = {};
  try {
    fields = JSON.parse(lead.fields || "{}");
  } catch {}
  const mergeLead = { ...lead, fields };
  const s = renderMerge(step.subject ?? "", mergeLead);
  // The client's email is HTML, sent exactly as designed; only the merge fields change.
  const b = renderMerge(step.body ?? "", mergeLead, true);
  const missing = [...new Set([...s.missing, ...b.missing])];
  const fallback = [...new Set([...s.usedFallback, ...b.usedFallback])];
  const placeholder = b.text.match(/\[[^\]<]*(required|placeholder|insert|tbc|todo|xxx)[^\]<]*\]/i);
  const notes = [
    ...(placeholder ? [`Unfinished placeholder in your email: ${placeholder[0]}`] : []),
    ...(missing.length ? [`Missing ${missing.join(", ")}: left blank in your text, check the wording`] : []),
    ...(fallback.length ? [`No ${fallback.join(", ")}: used your fallback`] : []),
  ];
  return { subject: s.text.trim(), body: b.text.trim(), notes };
}

function signOff(brief: Brief): string {
  // Skip the bare first name when the signature already starts with it ("Sam" + "Sam Patel ...").
  const name = brief.sender_name && !brief.signature?.startsWith(brief.sender_name) ? brief.sender_name : null;
  return [name, brief.signature].filter(Boolean).join("\n");
}

async function writeForLead(leadId: number) {
  const lead = get<LeadRow>("SELECT * FROM leads WHERE id = ?", leadId);
  if (!lead || lead.stage !== "drafting" || !lead.campaign_id) return;
  const client = requireClient(lead.client_id);
  const campaign = requireCampaign(lead.campaign_id);

  // "My text" steps are filled in with merge fields, no AI. The AI only writes the other steps.
  const fixed = campaign.steps.map((s) => (s.mode === "fixed" ? renderFixed(s, lead) : null));
  const aiSteps = campaign.steps.map((_, i) => i + 1).filter((n) => !fixed[n - 1]);

  let out: { emails: { step: number; subject: string; body: string }[]; flags: string[] } = { emails: [], flags: [] };
  if (aiSteps.length) {
    const res = await ai().responses.create({
      model: MODEL,
      reasoning: { effort: "low" },
      instructions: systemPrompt(client.brief),
      input:
        `Sequence (${campaign.steps.length} emails). Write ONLY step(s) ${aiSteps.join(", ")}.\n${stepsPrompt(campaign.steps, fixed)}` +
        `\n\nLead record:\n${leadRecord(lead)}`,
      text: { format: { type: "json_schema", name: "cold_sequence", schema: SCHEMA, strict: true } },
    });
    out = JSON.parse(res.output_text);
  }

  const sig = signOff(client.brief);
  const byStep = new Map(out.emails.map((e) => [e.step, e]));
  const flags = [...fixed.flatMap((f) => f?.notes ?? []), ...out.flags];
  tx(() => {
    run("DELETE FROM drafts WHERE lead_id = ?", leadId);
    campaign.steps.forEach((_, i) => {
      const f = fixed[i];
      const e = f ?? byStep.get(i + 1);
      if (!e) throw new Error(`Writer skipped step ${i + 1}`);
      // The client's own text already has its sign-off; AI-written steps get the brief's.
      const body = f ? f.body : sig ? `${e.body.trim()}\n\n${sig}` : e.body.trim();
      run(
        "INSERT INTO drafts (lead_id, step, subject, body, flags, format) VALUES (?, ?, ?, ?, ?, ?)",
        leadId, i + 1, i === 0 ? e.subject.trim() : "", body,
        i === 0 && flags.length ? [...new Set(flags)].join(" · ") : null,
        f ? "html" : "text",
      );
    });
    run("UPDATE leads SET stage = 'review', stage_message = NULL WHERE id = ?", leadId);
  });
}

declare global {
   
  var __outbound_writer_running: boolean | undefined;
}

/** Write drafts for every lead in stage 'drafting'. Safe to call repeatedly; only one run at a time. */
export async function runWriter() {
  if (globalThis.__outbound_writer_running) return;
  globalThis.__outbound_writer_running = true;
  try {
    for (;;) {
      const batch = all<{ id: number; client_id: number }>("SELECT id, client_id FROM leads WHERE stage = 'drafting' ORDER BY id LIMIT ?", CONCURRENCY);
      if (batch.length === 0) break;
      const results = await Promise.allSettled(batch.map((l) => writeForLead(l.id)));
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          const msg = (r.reason as Error).message ?? String(r.reason);
          run("UPDATE leads SET stage = 'error', stage_message = ? WHERE id = ?", `Writer: ${msg}`, batch[i].id);
          logActivity(batch[i].client_id, "error", `Couldn't write emails for lead ${batch[i].id}: ${msg}`);
        }
      });
      // If the key is missing every lead would fail; stop rather than churn.
      if (results.every((r) => r.status === "rejected")) break;
    }
  } finally {
    globalThis.__outbound_writer_running = false;
  }
}

/** Rewrite one step with extra guidance from the reviewer. Returns the new draft text. */
export async function rewriteStep(draftId: number, guidance: string) {
  const d = get<{ lead_id: number; step: number; subject: string; body: string }>("SELECT * FROM drafts WHERE id = ?", draftId);
  if (!d) throw new Error("Draft not found");
  const lead = get<LeadRow>("SELECT * FROM leads WHERE id = ?", d.lead_id)!;
  const client = requireClient(lead.client_id);
  const campaign = requireCampaign(lead.campaign_id!);
  const others = all<{ step: number; subject: string; body: string }>("SELECT step, subject, body FROM drafts WHERE lead_id = ? AND step != ? ORDER BY step", d.lead_id, d.step);

  const res = await ai().responses.create({
    model: MODEL,
    reasoning: { effort: "low" },
    instructions: systemPrompt(client.brief),
    input:
      `Rewrite step ${d.step} only. Step instructions: ${campaign.steps[d.step - 1]?.instructions ?? ""}\n\n` +
      `Reviewer's guidance: ${guidance || "make it better"}\n\n` +
      `Current version:\nSubject: ${d.subject}\n${d.body}\n\nThe other emails in the sequence (for context, do not repeat them):\n` +
      others.map((o) => `Step ${o.step}: ${o.body}`).join("\n---\n") +
      `\n\nLead record:\n${leadRecord(lead)}\n\nReturn emails with exactly one item for step ${d.step}. The body should not include the sign-off.`,
    text: { format: { type: "json_schema", name: "cold_sequence", schema: SCHEMA, strict: true } },
  });
  const out = JSON.parse(res.output_text) as { emails: { step: number; subject: string; body: string }[] };
  const e = out.emails[0];
  if (!e) throw new Error("Writer returned nothing");
  const sig = signOff(client.brief);
  run(
    "UPDATE drafts SET subject = ?, body = ?, edited = 1, status = 'pending' WHERE id = ?",
    d.step === 1 ? e.subject.trim() : "", sig ? `${e.body.trim()}\n\n${sig}` : e.body.trim(), draftId,
  );
}
