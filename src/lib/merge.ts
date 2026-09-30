// Merge fields for emails written by the client ("My email" steps). Pure, so the campaign form can preview it.
//   {{first_name}}            -> the lead's first name
//   {{first_name|there}}      -> "there" when the lead has no first name
// Keys are case-insensitive; spaces and punctuation count as "_" ({{Company Name}} = {{company_name}}).

export const STANDARD_FIELDS = ["first_name", "last_name", "company", "title", "website", "email", "phone"] as const;

export type MergeLead = {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  website?: string | null;
  phone?: string | null;
  fields?: Record<string, string>;
};

export const normKey = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const ALIASES: Record<string, string> = {
  firstname: "first_name", first: "first_name", name: "first_name",
  lastname: "last_name", surname: "last_name",
  company_name: "company", companyname: "company", organisation: "company", organization: "company",
  job_title: "title", jobtitle: "title", role: "title",
};

function values(lead: MergeLead): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(lead.fields ?? {})) if (val && String(val).trim()) v[normKey(k)] = String(val).trim();
  const put = (k: string, val: string | null | undefined) => {
    if (val && val.trim()) v[k] = val.trim();
  };
  put("first_name", lead.first_name);
  put("last_name", lead.last_name);
  put("company", lead.company);
  put("title", lead.title);
  put("website", lead.website);
  put("phone", lead.phone);
  put("email", lead.email);
  return v;
}

const FIELD_RE = /\{\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}\}/g;
const PLATFORM_TOKENS = /^unsubscribe/;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Fill merge fields. `missing` lists fields that were empty and had no fallback (they render as "").
 * With `html`, values are escaped so a lead's data can't break the email's markup.
 */
export function renderMerge(text: string, lead: MergeLead, html = false): { text: string; missing: string[]; usedFallback: string[] } {
  const v = values(lead);
  const missing: string[] = [];
  const usedFallback: string[] = [];
  const out = text.replace(FIELD_RE, (token: string, rawKey: string, fallback: string | undefined) => {
    // GHL-style {{contact.first_name}} means the same as {{first_name}}.
    const key = normKey(rawKey).replace(/^contact_/, "");
    // Sending-platform placeholders (unsubscribe links) aren't lead data; leave them exactly as written.
    if (PLATFORM_TOKENS.test(key)) return token;
    const value = v[key] ?? v[ALIASES[key] ?? ""];
    if (value) return html ? escapeHtml(value) : value;
    if (fallback !== undefined) {
      usedFallback.push(key);
      return html ? escapeHtml(fallback.trim()) : fallback.trim();
    }
    missing.push(key);
    return "";
  });
  return { text: out, missing, usedFallback };
}

/** Merge field names used in a text, for the form's hints. */
export function fieldsUsed(text: string): string[] {
  return [...text.matchAll(FIELD_RE)].map((m) => normKey(m[1]));
}

/**
 * Clean pasted email HTML without changing how it looks: drop scripts, event handlers, document
 * wrappers and comments; keep inline styles, <style> blocks, tables, links and images.
 */
export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<(meta|link|title)[^>]*>(?:[\s\S]*?<\/title>)?/gi, "")
    .replace(/<\/?(html|head|body|o:p)[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#$2")
    .trim();
}

/** Visible text of an HTML email (word counts, previews, AI context). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Things that make an email look different in the inbox than in the editor, or hurt delivery. */
export function htmlWarnings(html: string): string[] {
  const w: string[] = [];
  if (/<img[^>]+src\s*=\s*["']data:/i.test(html)) w.push("An image is pasted in as data; most inboxes block these. Host the image and link it by URL.");
  if (/<img[^>]+src\s*=\s*["']blob:/i.test(html)) w.push("An image points to a temporary browser link and won't show in the inbox.");
  if (/<img/i.test(html)) w.push("Images in cold emails can hurt deliverability; keep them few and small.");
  const placeholder = html.match(/\[[^\]<]*(required|placeholder|insert|tbc|todo|xxx)[^\]<]*\]/i);
  if (placeholder) w.push(`Unfinished placeholder in the email: "${placeholder[0]}". Replace it before sending.`);
  if (/\{\{\s*unsubscribe/i.test(html)) {
    // Seen on a live send (2026-09-30): Instantly replaces {{unsubscribe_link}} in the body with nothing.
    w.push(
      "Instantly sends {{unsubscribe…}} links in the body out empty. Use a line like \"Reply 'no thanks' and we won't email again\" instead; Instantly adds its own one-click unsubscribe header anyway.",
    );
  }
  return w;
}
