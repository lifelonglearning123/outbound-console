import "server-only";
import { all, get } from "./db";
import { GATEWAY_LABEL, PROVIDER_LABEL, type Gateway, type Provider } from "./mailhost";
import { GHL_TAGS } from "./checkTags";
import { INTEREST_LABELS } from "./triage";
import { contactStatus } from "./stages";

/**
 * Everyone in a campaign (or in all of a client's campaigns) as one row per contact with what has happened to them,
 * so the console counts, breaks down, filters, lists and exports people the same way everywhere. Filters live in
 * the URL (?status=replied&host=google), so a filtered list can be bookmarked, shared or downloaded as it is.
 */

export type PeopleScope = { clientId: number; campaignId: number | null };

type Option = { value: string; label: string };

const NOT_REMOVED = "f.stage <> 'removed'";

/** Where people are, for filtering. Not exclusive: someone who replied was also emailed, and usually opened. */
export const STATUSES: (Option & { where: string })[] = [
  { value: "waiting", label: "Not handed to the sender yet", where: "NOT f.handed AND NOT f.emailed AND f.stage NOT IN ('removed', 'rejected', 'error')" },
  { value: "queued", label: "Queued, not emailed yet", where: `f.handed AND NOT f.emailed AND NOT f.bounced AND ${NOT_REMOVED}` },
  { value: "emailed", label: "Emailed", where: `f.emailed AND ${NOT_REMOVED}` },
  { value: "opened", label: "Opened", where: `f.emailed AND f.last_open_at IS NOT NULL AND ${NOT_REMOVED}` },
  { value: "no_open", label: "Emailed, no open yet", where: `f.emailed AND f.last_open_at IS NULL AND f.replied_at IS NULL AND NOT f.bounced AND ${NOT_REMOVED}` },
  { value: "replied", label: "Replied", where: "f.replied_at IS NOT NULL" },
  { value: "no_reply", label: "Emailed, no reply yet", where: `f.emailed AND f.replied_at IS NULL AND NOT f.bounced AND NOT f.unsubscribed AND ${NOT_REMOVED}` },
  { value: "interested", label: "Interested", where: "f.interested" },
  { value: "interested_no_meeting", label: "Interested, no meeting yet", where: "f.interested AND f.meeting_at IS NULL" },
  { value: "meeting", label: "Meeting booked", where: "f.meeting_at IS NOT NULL" },
  { value: "bounced", label: "Bounced", where: "f.bounced" },
  { value: "unsubscribed", label: "Unsubscribed", where: "f.unsubscribed" },
  { value: "not_sending", label: "Won't be sent (invalid or rejected)", where: "f.stage IN ('rejected', 'error')" },
  { value: "removed", label: "Removed", where: "f.stage = 'removed'" },
];

export const CHECKS: (Option & { tone: string })[] = [
  { value: "verified", label: "Verified", tone: "text-go" },
  { value: "catch_all", label: "Unable to verify", tone: "text-wait" },
  { value: "invalid", label: "Invalid", tone: "text-bad" },
  { value: "checking", label: "Checking", tone: "text-info" },
  { value: "unchecked", label: "Not checked", tone: "text-muted" },
];

const HOSTS: Option[] = [
  ...(["google", "microsoft", "other", "none"] as Provider[]).map((p) => ({ value: p, label: PROVIDER_LABEL[p] })),
  { value: "unknown", label: "Not looked up yet" },
  ...(Object.keys(GATEWAY_LABEL) as Gateway[]).map((g) => ({ value: g, label: `${GATEWAY_LABEL[g]} filter` })),
  { value: "filter", label: "Any mail filter" },
];

const PORTAL_TAGS: Option[] = [
  { value: "verified", label: `Tagged "${GHL_TAGS.verified}"` },
  { value: "catch_all", label: `Tagged "${GHL_TAGS.catch_all}"` },
  { value: "invalid", label: `Tagged "${GHL_TAGS.invalid}"` },
  { value: "queued", label: "Waiting for the Nexus Portal" },
  { value: "deleted", label: "Deleted from the Nexus Portal" },
  { value: "none", label: "No check tag" },
];

const REPLIES: Option[] = [...Object.entries(INTEREST_LABELS).map(([value, label]) => ({ value, label })), { value: "none", label: "No reply" }];

const SENIORITY: Option[] = [
  { value: "chief", label: "Chief, founder or MD" },
  { value: "director", label: "Director or VP" },
  { value: "head", label: "Head of" },
  { value: "manager", label: "Manager or lead" },
  { value: "other", label: "Other titles" },
  { value: "none", label: "No job title" },
];

// Word-boundary matches (\m \M), most senior first, so "Managing Director" is a chief and "HR Business Partner" isn't.
const SENIORITY_SQL = `CASE
    WHEN NULLIF(trim(l.title), '') IS NULL THEN 'none'
    WHEN l.title ~* '\\m(chief|ceo|cfo|coo|cto|cmo|cpo|chro|founder|owner|president|managing director)\\M' THEN 'chief'
    WHEN l.title ~* '\\m(director|vp|vice president)\\M' THEN 'director'
    WHEN l.title ~* '\\mhead\\M' THEN 'head'
    WHEN l.title ~* '\\m(manager|lead|leader|supervisor)\\M' THEN 'manager'
    ELSE 'other' END`;

const FILTER_KEYS = ["q", "status", "check", "host", "sender", "source", "ptag", "reply", "seniority", "title", "from", "to"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type PeopleFilters = Partial<Record<FilterKey, string>>;

const FILTER_LABEL: Record<FilterKey, string> = {
  q: "Search", status: "Status", check: "Address check", host: "Email host", sender: "Sent from", source: "Came from",
  ptag: "Check tag", reply: "Reply", seniority: "Seniority", title: "Job title", from: "Emailed from", to: "Emailed until",
};
const FIXED: Partial<Record<FilterKey, Option[]>> = { status: STATUSES, check: CHECKS, host: HOSTS, ptag: PORTAL_TAGS, reply: REPLIES, seniority: SENIORITY };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The list filters in a page's search params; anything unknown or malformed is dropped. */
export function readFilters(sp: Record<string, string | string[] | undefined> | URLSearchParams): PeopleFilters {
  const f: PeopleFilters = {};
  for (const k of FILTER_KEYS) {
    const raw = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
    const v = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
    if (!v) continue;
    if (FIXED[k] && !FIXED[k]!.some((o) => o.value === v)) continue;
    if ((k === "from" || k === "to") && !DATE.test(v)) continue;
    f[k] = v;
  }
  return f;
}

export const sourceLabel = (v: string) =>
  v.startsWith("tag: ") ? `Portal tag "${v.slice(5)}"` : v === "typed in" || v === "manual" ? "Typed in" : v === "ghl" ? "Nexus Portal" : v === "csv" ? "CSV file" : v;

/** The filters in words, for confirmations and the activity log. */
export function describeFilters(f: PeopleFilters): string {
  return FILTER_KEYS.filter((k) => f[k])
    .map((k) => `${FILTER_LABEL[k]}: ${FIXED[k]?.find((o) => o.value === f[k])?.label ?? (k === "source" ? sourceLabel(f[k]!) : f[k])}`)
    .join(", ");
}

// ---------- Sorting ----------

const SORTS = {
  recent: { sql: "COALESCE(f.replied_at, f.last_sent, f.created_at)", dir: "desc" },
  name: { sql: "lower(concat_ws(' ', f.first_name, f.last_name, f.email))", dir: "asc" },
  sent: { sql: "f.first_sent", dir: "desc" },
} as const;
export type SortKey = keyof typeof SORTS;
export type Sort = { key: SortKey; dir: "asc" | "desc" };

export function readSort(sp: Record<string, string | string[] | undefined> | URLSearchParams): Sort {
  const read = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) : sp[k]);
  const key = (Object.keys(SORTS) as SortKey[]).find((k) => k === read("sort")) ?? "recent";
  const dir = read("dir");
  return { key, dir: dir === "asc" || dir === "desc" ? dir : SORTS[key].dir };
}

/** The sort as URL params, empty when it's the default. */
export const sortParams = (s: Sort): Record<string, string> =>
  s.key === "recent" && s.dir === SORTS.recent.dir ? {} : { sort: s.key, ...(s.dir !== SORTS[s.key].dir ? { dir: s.dir } : {}) };

export const defaultDir = (key: SortKey) => SORTS[key].dir;

// ---------- The query ----------

/**
 * One row per contact. Emails and meetings are grouped per contact once and joined, which is several times quicker
 * than looking each contact's up in turn.
 */
function facts(s: PeopleScope): string {
  return `SELECT l.id, l.campaign_id, c.name campaign, l.email, l.first_name, l.last_name, l.company, NULLIF(trim(l.title), '') title,
      l.stage, l.stage_message, l.verification, l.instantly_status, l.created_at, l.last_open_at, l.ghl_contact_id, l.fields,
      COALESCE(l.source_ref, l.source) source, md.provider, md.gateway,
      COALESCE(o.first_sent, l.last_sent_at) first_sent, COALESCE(o.last_sent, l.last_sent_at) last_sent, COALESCE(o.steps_sent, 0) steps_sent, o.sender,
      r.replied_at, r.reply_tag, COALESCE(r.interested, false) interested, mt.meeting_at,
      (l.pushed_at IS NOT NULL OR l.instantly_lead_id IS NOT NULL) handed,
      (o.first_sent IS NOT NULL OR l.last_sent_at IS NOT NULL OR COALESCE(l.instantly_status, 0) IN (3, -1)) emailed,
      COALESCE(l.instantly_status, 0) = -1 bounced,
      (COALESCE(l.instantly_status, 0) = -2 OR COALESCE(r.unsubscribed, false)) unsubscribed,
      CASE WHEN l.verification IN ('queued', 'pending') THEN 'checking' ELSE COALESCE(l.verification, 'unchecked') END check_key,
      COALESCE(md.gateway, md.provider, 'unknown') host,
      CASE WHEN l.ghl_verification_tag = 'done' AND l.verification IN ('verified', 'catch_all', 'invalid') THEN l.verification
           WHEN l.ghl_verification_tag = 'deleted' THEN 'deleted' WHEN l.ghl_verification_tag LIKE 'queued%' THEN 'queued' ELSE 'none' END ptag,
      ${SENIORITY_SQL} seniority
    FROM leads l JOIN campaigns c ON c.id = l.campaign_id
    LEFT JOIN mail_domains md ON md.domain = split_part(l.email, '@', 2)
    LEFT JOIN (SELECT lead_id, MIN(sent_at) first_sent, MAX(sent_at) last_sent, COUNT(DISTINCT step) steps_sent,
        (array_agg(account_email ORDER BY sent_at))[1] sender
      FROM emails WHERE client_id = @clientId AND direction = 'out' AND lead_id IS NOT NULL GROUP BY lead_id) o ON o.lead_id = l.id
    LEFT JOIN (SELECT lead_id, MIN(sent_at) FILTER (WHERE interest IS DISTINCT FROM 'ooo') replied_at,
        (array_agg(COALESCE(interest, 'other') ORDER BY sent_at DESC))[1] reply_tag,
        bool_or(interest = 'interested') interested, bool_or(interest = 'unsubscribe') unsubscribed
      FROM emails WHERE client_id = @clientId AND direction = 'in' AND lead_id IS NOT NULL GROUP BY lead_id) r ON r.lead_id = l.id
    LEFT JOIN (SELECT lead_id, MIN(booked_at) meeting_at FROM meetings WHERE client_id = @clientId GROUP BY lead_id) mt ON mt.lead_id = l.id
    WHERE l.client_id = @clientId ${s.campaignId ? "AND l.campaign_id = @campaignId" : ""}`;
}

/** SQL conditions for the filters, leaving one out (a filter's own options are counted without itself applied). */
function conditions(f: PeopleFilters, except?: FilterKey): string[] {
  const on = (k: FilterKey) => f[k] && except !== k;
  const c: string[] = [];
  if (except !== "status") c.push(f.status ? STATUSES.find((s) => s.value === f.status)!.where : NOT_REMOVED);
  if (f.q) c.push("(f.email ILIKE @qLike OR concat_ws(' ', f.first_name, f.last_name) ILIKE @qLike OR f.company ILIKE @qLike OR f.title ILIKE @qLike)");
  if (on("check")) c.push("f.check_key = @check");
  if (on("host")) c.push(f.host === "filter" ? "f.gateway IS NOT NULL" : "f.host = @host");
  if (on("sender")) c.push(f.sender!.startsWith("@") ? "f.sender ILIKE @senderLike" : "f.sender = @sender");
  if (on("source")) c.push("f.source = @source");
  if (on("ptag")) c.push("f.ptag = @ptag");
  if (on("reply")) c.push("COALESCE(f.reply_tag, 'none') = @reply");
  if (on("seniority")) c.push("f.seniority = @seniority");
  if (f.title) c.push("lower(f.title) = lower(@title)");
  if (f.from) c.push("f.first_sent >= @from");
  if (f.to) c.push("f.first_sent < @toNext");
  return c;
}

const where = (c: string[]) => (c.length ? c.join(" AND ") : "TRUE");
const escapeLike = (v: string) => v.replace(/[\\%_]/g, "\\$&");

function params(s: PeopleScope, f: PeopleFilters) {
  return {
    ...f,
    clientId: s.clientId,
    campaignId: s.campaignId ?? 0,
    qLike: f.q ? `%${escapeLike(f.q)}%` : null,
    senderLike: f.sender?.startsWith("@") ? `%${escapeLike(f.sender)}` : null,
    toNext: f.to ? new Date(Date.parse(`${f.to}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10) : null,
  };
}

export type Person = {
  id: number; campaign_id: number; campaign: string; email: string; first_name: string | null; last_name: string | null;
  company: string | null; title: string | null; stage: string; stage_message: string | null; verification: string | null;
  instantly_status: number | null; created_at: string; last_open_at: string | null; ghl_contact_id: string | null; fields: string;
  source: string; provider: Provider | null; gateway: Gateway | null; first_sent: string | null; last_sent: string | null;
  steps_sent: number; sender: string | null; replied_at: string | null; reply_tag: string | null; interested: boolean;
  meeting_at: string | null; handed: boolean; emailed: boolean; bounced: boolean; unsubscribed: boolean; check_key: string;
  host: string; ptag: string; seniority: string;
};

export const personName = (p: Pick<Person, "first_name" | "last_name">) => [p.first_name, p.last_name].filter(Boolean).join(" ");

/** Where one person is, as one label: the furthest thing that happened to them. */
export function personState(p: Person): { label: string; tone: string } {
  if (p.stage === "removed") return { label: "Removed", tone: "text-muted" };
  if (p.meeting_at) return { label: "Meeting booked", tone: "text-go" };
  if (p.interested) return { label: "Interested", tone: "text-go" };
  if (p.unsubscribed) return { label: "Unsubscribed", tone: "text-bad" };
  if (p.replied_at) {
    const tag = p.reply_tag && p.reply_tag !== "other" ? `: ${INTEREST_LABELS[p.reply_tag]?.toLowerCase() ?? p.reply_tag}` : "";
    return { label: `Replied${tag}`, tone: "text-info" };
  }
  if (p.bounced) return { label: p.gateway ? `Bounced (${GATEWAY_LABEL[p.gateway]} filter)` : "Bounced", tone: "text-bad" };
  if (p.emailed) return { label: p.last_open_at ? "Opened" : "Emailed", tone: "text-ink" };
  if (p.handed) return { label: "Queued to send", tone: "text-info" };
  return contactStatus(p.stage, p.verification);
}

export const hostLabel = (host: string) => HOSTS.find((h) => h.value === host)?.label ?? host;
export const checkOption = (key: string) => CHECKS.find((c) => c.value === key);
export const portalTagLabel = (key: string) => PORTAL_TAGS.find((t) => t.value === key)?.label ?? key;
export const seniorityLabel = (key: string) => SENIORITY.find((s) => s.value === key)?.label ?? key;

const ORDER = (s: Sort) => `${SORTS[s.key].sql} ${s.dir === "asc" ? "ASC" : "DESC"} NULLS LAST, f.id DESC`;

/** One page of the people matching the filters, with how many match and how many of those can still be removed. */
export async function listPeople(s: PeopleScope, f: PeopleFilters, sort: Sort, page: number, perPage = 100) {
  const p = params(s, f);
  const w = where(conditions(f));
  const [sum, rows] = await Promise.all([
    get<{ total: number; removable: number }>(
      `WITH f AS (${facts(s)}) SELECT COUNT(*) total, COUNT(*) FILTER (WHERE NOT f.handed AND f.stage <> 'removed') removable FROM f WHERE ${w}`,
      p,
    ),
    all<Person>(`WITH f AS (${facts(s)}) SELECT f.* FROM f WHERE ${w} ORDER BY ${ORDER(sort)} LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, p),
  ]);
  return { rows, total: sum?.total ?? 0, removable: sum?.removable ?? 0 };
}

/** Everyone matching, for a download. */
export async function allPeople(s: PeopleScope, f: PeopleFilters, sort: Sort): Promise<Person[]> {
  return all<Person>(`WITH f AS (${facts(s)}) SELECT f.* FROM f WHERE ${where(conditions(f))} ORDER BY ${ORDER(sort)}`, params(s, f));
}

/** The matching contacts that haven't been handed to the sender, so can still be taken out of the campaign. */
export async function removableIds(s: PeopleScope, f: PeopleFilters): Promise<number[]> {
  return (await all<{ id: number }>(
    `WITH f AS (${facts(s)}) SELECT f.id FROM f WHERE ${where(conditions(f))} AND NOT f.handed AND f.stage <> 'removed'`,
    params(s, f),
  )).map((r) => r.id);
}

// ---------- Filter options with counts ----------

export type FacetOption = Option & { n: number };
export type Facet = { key: FilterKey; label: string; options: FacetOption[] };

const FACETS: { key: FilterKey; label: string; expr: string }[] = [
  { key: "reply", label: "Reply", expr: "COALESCE(f.reply_tag, 'none')" },
  { key: "check", label: "Address check", expr: "f.check_key" },
  { key: "host", label: "Email host", expr: "f.host" },
  { key: "sender", label: "Sent from", expr: "f.sender" },
  { key: "seniority", label: "Seniority", expr: "f.seniority" },
  { key: "source", label: "Came from", expr: "f.source" },
  { key: "ptag", label: "Check tag", expr: "f.ptag" },
];

/**
 * Every filter's options with how many people each would show, given the other filters. One query: the rows are
 * built once and each filter is counted over them with every other filter applied.
 */
export async function peopleFacets(s: PeopleScope, f: PeopleFilters): Promise<Facet[]> {
  const parts = [
    `SELECT 'status' facet, st.val, COUNT(*) n FROM f
       CROSS JOIN LATERAL (VALUES ${STATUSES.map((x) => `('${x.value}', ${x.where})`).join(", ")}) st(val, hit)
     WHERE st.hit AND ${where(conditions(f, "status"))} GROUP BY 2`,
    ...FACETS.map((x) => `SELECT '${x.key}' facet, ${x.expr} val, COUNT(*) n FROM f WHERE ${where(conditions(f, x.key))} GROUP BY 2`),
  ];
  const rows = await all<{ facet: FilterKey; val: string | null; n: number }>(
    `WITH f AS MATERIALIZED (${facts(s)}) ${parts.join(" UNION ALL ")}`,
    params(s, f),
  );
  const counts = (k: FilterKey) => new Map(rows.filter((r) => r.facet === k && r.val !== null).map((r) => [r.val!, r.n]));
  const fixed = (opts: Option[], m: Map<string, number>) => opts.map((o) => ({ ...o, n: m.get(o.value) ?? 0 }));
  const byCount = (m: Map<string, number>, label: (v: string) => string) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, label: label(value), n }));

  const hosts = counts("host");
  const anyFilter = [...hosts.entries()].filter(([k]) => k in GATEWAY_LABEL).reduce((a, [, n]) => a + n, 0);
  const senders = counts("sender");
  const domains = new Map<string, number>();
  for (const [email, n] of senders) domains.set(`@${email.split("@")[1]}`, (domains.get(`@${email.split("@")[1]}`) ?? 0) + n);

  return [
    { key: "status", label: "Status", options: fixed(STATUSES, counts("status")) },
    { key: "reply", label: "Reply", options: fixed(REPLIES, counts("reply")) },
    { key: "check", label: "Address check", options: fixed(CHECKS, counts("check")) },
    { key: "host", label: "Email host", options: fixed(HOSTS, new Map([...hosts, ["filter", anyFilter]])) },
    {
      key: "sender", label: "Sent from",
      options: [...byCount(domains, (d) => `Any mailbox ${d}`), ...byCount(senders, (e) => e)],
    },
    { key: "seniority", label: "Seniority", options: fixed(SENIORITY, counts("seniority")) },
    { key: "source", label: "Came from", options: byCount(counts("source"), sourceLabel) },
    { key: "ptag", label: "Check tag", options: fixed(PORTAL_TAGS, counts("ptag")) },
  ];
}

// ---------- Breakdowns ----------

export type Counts = {
  contacts: number; handed: number; queued: number; emailed: number; opened: number; replied: number; interested: number;
  meetings: number; bounced: number; unsubscribed: number;
};
export type BreakdownRow = Counts & { key: string | null; label: string; filter: PeopleFilters | null };

export const DIMENSIONS = [
  { key: "host", label: "Their email host" },
  { key: "domain", label: "Sending domain" },
  { key: "sender", label: "Sending mailbox" },
  { key: "check", label: "Address check" },
  { key: "seniority", label: "Seniority" },
  { key: "title", label: "Job title" },
  { key: "source", label: "Came from" },
  { key: "week", label: "Week first emailed" },
] as const;
export type Dimension = (typeof DIMENSIONS)[number]["key"];

const DIMENSION_SQL: Record<Dimension, string> = {
  host: "f.host",
  domain: "'@' || split_part(f.sender, '@', 2)",
  sender: "f.sender",
  check: "f.check_key",
  seniority: "f.seniority",
  title: "lower(f.title)",
  source: "f.source",
  week: "to_char(date_trunc('week', f.first_sent::timestamptz), 'YYYY-MM-DD')",
};

const COUNTS = `COUNT(*) contacts, COUNT(*) FILTER (WHERE f.handed) handed,
  COUNT(*) FILTER (WHERE f.handed AND NOT f.emailed AND NOT f.bounced) queued, COUNT(*) FILTER (WHERE f.emailed) emailed,
  COUNT(*) FILTER (WHERE f.emailed AND f.last_open_at IS NOT NULL) opened, COUNT(*) FILTER (WHERE f.replied_at IS NOT NULL) replied,
  COUNT(*) FILTER (WHERE f.interested) interested, COUNT(*) FILTER (WHERE f.meeting_at IS NOT NULL) meetings,
  COUNT(*) FILTER (WHERE f.bounced) bounced, COUNT(*) FILTER (WHERE f.unsubscribed) unsubscribed`;

const ZERO: Counts = { contacts: 0, handed: 0, queued: 0, emailed: 0, opened: 0, replied: 0, interested: 0, meetings: 0, bounced: 0, unsubscribed: 0 };
const COUNT_KEYS = Object.keys(ZERO) as (keyof Counts)[];
const add = (a: Counts, b: Counts): Counts => Object.fromEntries(COUNT_KEYS.map((k) => [k, a[k] + b[k]])) as Counts;

/** Everyone across a breakdown's rows (each person is in exactly one row). */
export const totals = (rows: Counts[]): Counts => rows.reduce(add, ZERO);

const fmtWeek = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const TOP_TITLES = 12;

/** What happened to people, split by one dimension. Each row carries the filter that lists its people. */
export async function breakdown(s: PeopleScope, dim: Dimension, f: PeopleFilters = {}): Promise<BreakdownRow[]> {
  const rows = await all<Counts & { key: string | null; sample: string | null }>(
    `WITH f AS (${facts(s)}) SELECT ${DIMENSION_SQL[dim]} key, MIN(f.title) sample, ${COUNTS} FROM f WHERE ${where(conditions(f))} GROUP BY 1`,
    params(s, f),
  );
  const counts = (r: Counts): Counts => Object.fromEntries(COUNT_KEYS.map((k) => [k, r[k]])) as Counts;
  const byVolume = (a: Counts, b: Counts) => b.emailed - a.emailed || b.contacts - a.contacts;
  const keyed = rows.filter((r) => r.key !== null);
  const none = rows.find((r) => r.key === null);
  const notEmailed = (label: string) => (none ? [{ ...counts(none), key: null, label, filter: null }] : []);

  switch (dim) {
    case "check":
    case "seniority": {
      const opts = dim === "check" ? CHECKS : SENIORITY;
      return opts.flatMap((o) => {
        const r = keyed.find((x) => x.key === o.value);
        return r ? [{ ...counts(r), key: o.value, label: o.label, filter: { [dim]: o.value } }] : [];
      });
    }
    case "host":
      return keyed.sort(byVolume).map((r) => ({ ...counts(r), key: r.key, label: hostLabel(r.key!), filter: { host: r.key! } }));
    case "sender":
    case "domain":
      return [
        ...keyed.sort(byVolume).map((r) => ({ ...counts(r), key: r.key, label: dim === "domain" ? r.key!.slice(1) : r.key!, filter: { sender: r.key! } })),
        ...notEmailed("Not emailed yet"),
      ];
    case "source":
      return keyed.sort(byVolume).map((r) => ({ ...counts(r), key: r.key, label: sourceLabel(r.key!), filter: { source: r.key! } }));
    case "week":
      return [
        ...keyed.sort((a, b) => a.key!.localeCompare(b.key!)).map((r) => ({
          ...counts(r), key: r.key, label: `Week of ${fmtWeek(r.key!)}`, filter: { from: r.key!, to: plusDays(r.key!, 6) },
        })),
        ...notEmailed("Not emailed yet"),
      ];
    case "title": {
      const sorted = keyed.sort((a, b) => b.contacts - a.contacts || byVolume(a, b));
      const top = sorted.slice(0, TOP_TITLES).map((r) => ({ ...counts(r), key: r.key, label: r.sample ?? r.key!, filter: { title: r.sample ?? r.key! } }));
      const rest = sorted.slice(TOP_TITLES);
      return [
        ...top,
        ...(rest.length ? [{ ...totals(rest.map(counts)), key: null, label: `${rest.length} other titles`, filter: null }] : []),
        ...(none ? [{ ...counts(none), key: null, label: "No job title", filter: { seniority: "none" } }] : []),
      ];
    }
  }
}

// ---------- Links ----------

/** A link to a people list showing these filters, carrying the page's own params (Stats' range and campaign). */
export function peopleHref(base: string, keep: Record<string, string>, f: PeopleFilters): string {
  const q = new URLSearchParams(keep);
  for (const k of FILTER_KEYS) if (f[k]) q.set(k, f[k]!);
  const s = q.toString();
  return `${base}${s ? `?${s}` : ""}#people`;
}

/** The page's own search params, without the people list's (so a filter change keeps the rest of the page as it was). */
export function nonPeopleParams(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const own = new Set<string>([...FILTER_KEYS, "sort", "dir", "page"]);
  return Object.fromEntries(Object.entries(sp).filter(([k, v]) => typeof v === "string" && v && !own.has(k)) as [string, string][]);
}
