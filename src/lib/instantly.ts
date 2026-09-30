import "server-only";

// Thin Instantly API v2 client. Field names and enums: docs/instantly-api.md.
// INSTANTLY_BASE_URL lets scripts/mock-instantly.mjs stand in for Instantly during local testing.
const BASE = process.env.INSTANTLY_BASE_URL || "https://api.instantly.ai/api/v2";

export class InstantlyError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// GET /emails has its own 20 requests/minute limit per workspace, so space those calls out per key.
const lastEmailsCall = new Map<string, number>();
const EMAILS_GAP_MS = 3200;

type Query = Record<string, string | number | boolean | string[] | undefined | null>;

function qs(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function call<T>(
  key: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { query?: Query; body?: unknown } = {},
  attempt = 1,
): Promise<T> {
  if (method === "GET" && path === "/emails") {
    const wait = (lastEmailsCall.get(key) ?? 0) + EMAILS_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastEmailsCall.set(key, Date.now());
  }

  const res = await fetch(`${BASE}${path}${qs(opts.query)}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return call(key, method, path, opts, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.message ?? j.error ?? msg;
    } catch {}
    if (res.status === 401) msg = `Key rejected (${msg}). Check the key, its scopes, and that the plan includes API access.`;
    if (res.status === 403) msg = `Not allowed (${msg}). The key may lack a scope, or the plan may not include API v2.`;
    throw new InstantlyError(`Instantly ${res.status}: ${msg}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

type Page<T> = { items: T[]; next_starting_after?: string | null };

async function paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, max = 10_000): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    out.push(...(page.items ?? []));
    cursor = page.next_starting_after ?? undefined;
  } while (cursor && out.length < max);
  return out;
}

// ---------- Enums ----------

export const CAMPAIGN_STATUS: Record<number, string> = {
  0: "Draft",
  1: "Active",
  2: "Paused",
  3: "Completed",
  4: "Running subsequences",
  [-1]: "Accounts unhealthy",
  [-2]: "Bounce protect",
  [-99]: "Account suspended",
};

export const LEAD_STATUS: Record<number, string> = {
  1: "Active",
  2: "Paused",
  3: "Completed",
  [-1]: "Bounced",
  [-2]: "Unsubscribed",
  [-3]: "Skipped",
};

export const INTEREST_STATUS: Record<number, string> = {
  1: "Interested",
  2: "Meeting booked",
  3: "Meeting completed",
  4: "Won",
  0: "Out of office",
  [-1]: "Not interested",
  [-2]: "Wrong person",
  [-3]: "Lost",
  [-4]: "No show",
};

export const ACCOUNT_STATUS: Record<number, string> = {
  1: "Active",
  2: "Paused",
  3: "Maintenance pause",
  [-1]: "Connection error",
  [-2]: "Soft bounce error",
  [-3]: "Sending error",
};

export const WARMUP_STATUS: Record<number, string> = {
  1: "Warming",
  0: "Warmup paused",
  [-1]: "Banned",
  [-2]: "Spam folder unknown",
  [-3]: "Suspended",
};

// ---------- Types ----------

export type Tag = { id: string; label: string };

export type Workspace = { id: string; name: string; plan_id: string | null };

export type CampaignSchedule = {
  start_date?: string | null;
  end_date?: string | null;
  schedules: {
    name: string;
    timing: { from: string; to: string };
    days: Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", boolean>;
    timezone: string;
  }[];
};

export type SequenceStep = {
  type: "email";
  delay: number;
  delay_unit?: "minutes" | "hours" | "days";
  variants: { subject: string; body: string; v_disabled?: boolean }[];
};

export type Campaign = {
  id: string;
  name: string;
  status: number;
  not_sending_status: number | null;
  campaign_schedule: CampaignSchedule;
  sequences: { steps: SequenceStep[] }[];
  email_list: string[];
  daily_limit: number | null;
  stop_on_reply: boolean | null;
  timestamp_created: string;
};

export type Lead = {
  id: string;
  email: string | null;
  campaign: string | null;
  status: number;
  lt_interest_status: number | null;
  payload: Record<string, unknown> | null;
  email_open_count: number;
  email_reply_count: number;
  email_click_count: number;
  status_summary?: { lastStep?: { from?: string; stepID?: string; timestamp_executed?: string } } | null;
  last_step_timestamp_executed?: string | null;
  timestamp_last_contact: string | null;
  timestamp_last_open: string | null;
  timestamp_last_reply: string | null;
};

export type Account = {
  email: string;
  status: number;
  warmup_status: number;
  stat_warmup_score: number | null;
  daily_limit: number | null;
};

export type Email = {
  id: string;
  thread_id: string | null;
  subject: string;
  body: { text?: string; html?: string } | null;
  content_preview: string | null;
  from_address_email: string | null;
  to_address_email_list: string;
  eaccount: string;
  lead: string | null;
  campaign_id: string | null;
  ue_type: number | null;
  step: string | null;
  is_unread: number | null;
  is_auto_reply: number | null;
  i_status: number | null;
  timestamp_email: string;
  timestamp_created: string;
};

export type CampaignDaily = {
  date: string;
  sent: number;
  unique_opened: number;
  unique_replies: number;
  unique_clicks: number;
  unique_opportunities: number;
};

export type AccountDaily = { date: string; email_account: string; sent: number; bounced: number };

export type LeadInput = {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  job_title?: string | null;
  phone?: string | null;
  website?: string | null;
  custom_variables?: Record<string, string | number | boolean | null>;
};

export type AddLeadsResult = {
  leads_uploaded: number;
  in_blocklist: number;
  duplicated_leads: number;
  skipped_count: number;
  invalid_email_count: number;
  created_leads?: { index: number; id: string; email: string }[];
  remaining_in_plan?: number;
};

// ---------- Client ----------

export function instantly(key: string) {
  return {
    workspace: () => call<Workspace>(key, "GET", "/workspaces/current"),

    /** All campaigns, or only those carrying `tagId` (shared-workspace mode). */
    campaigns: (tagId?: string | null) =>
      paginate<Campaign>((c) => call(key, "GET", "/campaigns", { query: { limit: 100, starting_after: c, tag_ids: tagId ?? undefined } })),
    campaign: (id: string) => call<Campaign>(key, "GET", `/campaigns/${id}`),
    createCampaign: (body: Record<string, unknown>) => call<Campaign>(key, "POST", "/campaigns", { body }),
    patchCampaign: (id: string, body: Record<string, unknown>) =>
      call<Campaign>(key, "PATCH", `/campaigns/${id}`, { body }),
    activate: (id: string) => call<Campaign>(key, "POST", `/campaigns/${id}/activate`),
    pause: (id: string) => call<Campaign>(key, "POST", `/campaigns/${id}/pause`),
    addVariables: (id: string, variables: string[]) =>
      call<Campaign>(key, "POST", `/campaigns/${id}/variables`, { body: { variables } }),
    sendingStatus: (id: string) =>
      call<{ summary: { status: string; status_message: string } | null; diagnostics: Record<string, unknown> | null }>(
        key,
        "GET",
        `/campaigns/${id}/sending-status`,
      ),
    campaignDaily: (campaignId: string, start: string, end: string) =>
      call<CampaignDaily[]>(key, "GET", "/campaigns/analytics/daily", {
        query: { campaign_id: campaignId, start_date: start, end_date: end },
      }),

    addLeads: (campaignId: string, leads: LeadInput[]) =>
      call<AddLeadsResult>(key, "POST", "/leads/add", {
        body: { campaign_id: campaignId, leads, skip_if_in_workspace: false, skip_if_in_campaign: false },
      }),
    leadsInCampaign: (campaignId: string) =>
      paginate<Lead>((c) => call(key, "POST", "/leads/list", { body: { campaign: campaignId, limit: 100, starting_after: c } })),
    /** Replace a lead's custom variables (we always send the full set, so merge vs replace doesn't matter). */
    patchLeadVars: (leadId: string, vars: Record<string, string>) =>
      call<Lead>(key, "PATCH", `/leads/${leadId}`, { body: { custom_variables: vars } }),
    deleteLead: (leadId: string) => call(key, "DELETE", `/leads/${leadId}`),
    setInterest: (leadEmail: string, campaignId: string, value: number | null) =>
      call(key, "POST", "/leads/update-interest-status", {
        body: { lead_email: leadEmail, campaign_id: campaignId, interest_value: value },
      }),

    /** All mailboxes, or only those carrying `tagId` (shared-workspace mode). */
    accounts: (tagId?: string | null) =>
      paginate<Account>((c) => call(key, "GET", "/accounts", { query: { limit: 100, starting_after: c, tag_ids: tagId ?? undefined } })),

    tags: () => paginate<Tag>((c) => call(key, "GET", "/custom-tags", { query: { limit: 100, starting_after: c } })),
    createTag: (label: string) => call<Tag>(key, "POST", "/custom-tags", { body: { label } }),
    /** resourceType: 1 = mailbox (id is its email), 2 = campaign. */
    tagResources: (tagId: string, resourceType: 1 | 2, resourceIds: string[], assign = true) =>
      call(key, "POST", "/custom-tags/toggle-resource", {
        body: { tag_ids: [tagId], resource_type: resourceType, resource_ids: resourceIds, assign },
      }),
    pauseAccount: (email: string) => call<Account>(key, "POST", `/accounts/${encodeURIComponent(email)}/pause`),
    resumeAccount: (email: string) => call<Account>(key, "POST", `/accounts/${encodeURIComponent(email)}/resume`),
    accountDaily: (emails: string[], start: string, end: string) =>
      call<AccountDaily[]>(key, "GET", "/accounts/analytics/daily", {
        query: { emails, start_date: start, end_date: end },
      }),

    /** Emails created after `since` (ISO), oldest first, capped by `maxPages` to respect the 20/min limit. */
    emailsSince: async (since: string | null, maxPages = 5, eaccounts?: string[]) => {
      let pages = 0;
      return paginate<Email>((c) => {
        pages += 1;
        if (pages > maxPages) return Promise.resolve({ items: [] });
        return call(key, "GET", "/emails", {
          query: { limit: 100, starting_after: c, min_timestamp_created: since ?? undefined, sort_order: "asc", eaccount: eaccounts?.join(",") },
        });
      });
    },
    scheduledEmails: async (eaccounts?: string[]) =>
      (await call<Page<Email>>(key, "GET", "/emails", {
        query: { limit: 100, scheduled_only: true, sort_order: "asc", eaccount: eaccounts?.join(",") },
      })).items ?? [],
    blockEmail: (email: string) => call(key, "POST", "/block-lists-entries", { body: { bl_value: email } }),
    reply: (body: { eaccount: string; reply_to_uuid: string; subject: string; body: { html?: string; text?: string } }) =>
      call<Email>(key, "POST", "/emails/reply", { body }),
  };
}

export type InstantlyClient = ReturnType<typeof instantly>;
