import "server-only";
import { all, get, run, logActivity } from "./db";
import { breakdown, crossBreakdown, totals, type BreakdownRow, type PeopleFilters, type PeopleScope } from "./people";
import { FREE_MAIL, GATEWAY_LABEL, PROVIDER_LABEL, type Gateway, type Provider } from "./mailhost";
import { filterAdvice, unconfirmedBatch } from "./healthLogic";
import { pct } from "./format";

/**
 * The recipient side of deliverability: why emails bounced, which mail filters refuse the client's mail, companies
 * that keep bouncing, and how unconfirmed (catch-all) addresses have done. Mailbox health is in mailboxHealth.ts.
 */

// ---------- Why emails bounced ----------

const hostPhrase = (key: string | null) => {
  if (!key || key === "unknown") return "companies whose mail server wasn't looked up yet";
  if (key in GATEWAY_LABEL) return `companies behind a ${GATEWAY_LABEL[key as Gateway]} filter`;
  if (key === "none") return "domains with no mail server";
  if (key === "other") return "companies on other mail servers";
  return `companies on ${PROVIDER_LABEL[key as Provider] ?? key}`;
};

export type BounceStory = { emailed: number; bounced: number; lines: string[]; hosts: BreakdownRow[] };

/** The bounces in a scope, explained in a few sentences: where they went, and how unconfirmed addresses did. */
export async function bounceStory(s: PeopleScope, f: PeopleFilters = {}): Promise<BounceStory> {
  const hosts = await breakdown(s, "host", f);
  const t = totals(hosts);
  if (!t.bounced) return { emailed: t.emailed, bounced: 0, lines: [], hosts };
  const lines = hosts
    .filter((r) => r.bounced > 0)
    .sort((a, b) => b.bounced - a.bounced)
    .slice(0, 3)
    .map((r) => `${r.bounced} of the ${t.bounced} were to ${hostPhrase(r.key)}: ${pct(r.bounced, r.emailed)} of the ${r.emailed} emailed there.`);
  const checks = await breakdown(s, "check", f);
  const unconfirmed = checks.find((r) => r.key === "catch_all");
  if (unconfirmed?.bounced) {
    lines.push(`${unconfirmed.bounced} were unconfirmed (catch-all) addresses: ${pct(unconfirmed.bounced, unconfirmed.emailed)} of the ${unconfirmed.emailed} of those emailed.`);
  }
  return { emailed: t.emailed, bounced: t.bounced, lines, hosts };
}

/** Bounce and reply rates by the recipient's email host and the sending domain that wrote to them. */
export async function hostBySender(s: PeopleScope) {
  const rows = (await crossBreakdown(s, "host", "domain")).filter((r) => r.emailed > 0 && r.b);
  const senders = [...new Set(rows.map((r) => r.b!))].sort();
  const hosts = [...new Set(rows.map((r) => r.a ?? "unknown"))]
    .map((h) => ({ host: h, emailed: rows.filter((r) => (r.a ?? "unknown") === h).reduce((a, r) => a + r.emailed, 0) }))
    .sort((a, b) => b.emailed - a.emailed)
    .map((h) => h.host);
  const cell = (host: string, sender: string) => rows.find((r) => (r.a ?? "unknown") === host && r.b === sender);
  return { senders, hosts, cell };
}

// ---------- Mail filters ----------

export type FilterEvidence = {
  gateway: Gateway;
  contacts: number;
  emailed: number;
  bounced: number;
  replied: number;
  probed: number;
  held: number; // approved and waiting behind it, across campaigns that hold it
  advice: ReturnType<typeof filterAdvice>;
};

/** How contacts behind each mail filter have done across all of a client's campaigns, with advice. */
export async function filterEvidence(clientId: number): Promise<FilterEvidence[]> {
  const rows = await all<Omit<FilterEvidence, "advice">>(
    `SELECT md.gateway, COUNT(*) contacts,
       COUNT(*) FILTER (WHERE l.last_sent_at IS NOT NULL OR l.instantly_status = -1) emailed,
       COUNT(*) FILTER (WHERE l.instantly_status = -1) bounced,
       COUNT(*) FILTER (WHERE l.last_reply_at IS NOT NULL) replied,
       COUNT(*) FILTER (WHERE l.probe = 1) probed,
       COUNT(*) FILTER (WHERE l.stage = 'approved') held
     FROM leads l JOIN mail_domains md ON md.domain = split_part(l.email, '@', 2)
     WHERE l.client_id = ? AND md.gateway IS NOT NULL AND l.stage NOT IN ('rejected', 'removed')
     GROUP BY md.gateway ORDER BY 2 DESC`,
    clientId,
  );
  return rows.map((r) => {
    const x = { ...r, contacts: Number(r.contacts), emailed: Number(r.emailed), bounced: Number(r.bounced), replied: Number(r.replied), probed: Number(r.probed), held: Number(r.held) };
    return { ...x, advice: filterAdvice(x.emailed, x.bounced) };
  });
}

// ---------- Problem companies ----------

export type ProblemDomain = { domain: string; reason: string; auto: number; created_at: string; cleared_at: string | null; waiting: number };

export async function problemDomains(clientId: number, includeCleared = false): Promise<ProblemDomain[]> {
  return all<ProblemDomain>(
    `SELECT pd.*, (SELECT COUNT(*) FROM leads l WHERE l.client_id = pd.client_id AND split_part(l.email, '@', 2) = pd.domain AND l.stage = 'approved') waiting
     FROM problem_domains pd WHERE pd.client_id = ? ${includeCleared ? "" : "AND pd.cleared_at IS NULL"} ORDER BY pd.created_at DESC`,
    clientId,
  );
}

/**
 * When two addresses at the same company have bounced, stop sending to the rest of that company: the company's mail
 * server or filter is refusing the client. Free mail services never count. A company cleared by hand isn't added again.
 */
export async function flagProblemDomains(clientId: number): Promise<number> {
  const rows = await all<{ domain: string; n: number; emails: string }>(
    `SELECT split_part(l.email, '@', 2) domain, COUNT(DISTINCT l.email) n, string_agg(DISTINCT l.email, ', ') emails
     FROM leads l WHERE l.client_id = ? AND l.instantly_status = -1
       AND NOT EXISTS (SELECT 1 FROM problem_domains pd WHERE pd.client_id = l.client_id AND pd.domain = split_part(l.email, '@', 2))
       AND NOT (split_part(l.email, '@', 2) = ANY(?))
     GROUP BY 1 HAVING COUNT(DISTINCT l.email) >= 2`,
    clientId, FREE_MAIL,
  );
  for (const r of rows) {
    const reason = `${r.n} addresses there bounced (${r.emails})`;
    await run("INSERT INTO problem_domains (client_id, domain, reason, auto) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING", clientId, r.domain, reason);
    await logActivity(
      clientId, "domain",
      `Stopped sending to ${r.domain}: ${reason}. Its other contacts are held, in every campaign, until you take it off the problem companies list.`,
      { subject: r.domain, undo: "clear_domain" },
    );
  }
  return rows.length;
}

export async function addProblemDomain(clientId: number, domain: string, reason: string) {
  const d = domain.trim().toLowerCase().replace(/^.*@/, "").replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error("Enter a domain such as example.com");
  await run(
    `INSERT INTO problem_domains (client_id, domain, reason, auto) VALUES (?, ?, ?, 0)
     ON CONFLICT (client_id, domain) DO UPDATE SET reason = EXCLUDED.reason, cleared_at = NULL, auto = 0`,
    clientId, d, reason.trim() || "Added by hand",
  );
  await logActivity(clientId, "domain", `Added ${d} to the problem companies list: ${reason.trim() || "added by hand"}`, { subject: d, undo: "clear_domain" });
}

/** Take a company off the list; its held contacts go out on the next send. Kept (cleared) so the sync doesn't add it back. */
export async function clearProblemDomain(clientId: number, domain: string) {
  const r = await run("UPDATE problem_domains SET cleared_at = ? WHERE client_id = ? AND domain = ? AND cleared_at IS NULL", new Date().toISOString(), clientId, domain);
  if (r.changes) await logActivity(clientId, "domain", `Took ${domain} off the problem companies list; its contacts can be sent to again.`, { subject: domain });
}

// ---------- Address checks ----------

export type CheckEvidence = {
  verified: { emailed: number; bounced: number };
  unconfirmed: { emailed: number; bounced: number };
  weeks: { week: string; verifiedEmailed: number; verifiedBounced: number; unconfirmedEmailed: number; unconfirmedBounced: number }[];
};

/** How verified and unconfirmed (catch-all) addresses have bounced across the client, overall and by week first emailed. */
export async function checkEvidence(clientId: number): Promise<CheckEvidence> {
  const emailed = "(l.last_sent_at IS NOT NULL OR l.instantly_status = -1)";
  const rows = await all<{ week: string | null; verification: string; emailed: number; bounced: number }>(
    `SELECT to_char(date_trunc('week', l.last_sent_at::timestamptz), 'YYYY-MM-DD') week, l.verification,
       COUNT(*) FILTER (WHERE ${emailed}) emailed, COUNT(*) FILTER (WHERE l.instantly_status = -1) bounced
     FROM leads l WHERE l.client_id = ? AND l.verification IN ('verified', 'catch_all') AND ${emailed}
     GROUP BY 1, 2`,
    clientId,
  );
  const sum = (v: string, k: "emailed" | "bounced") => rows.filter((r) => r.verification === v).reduce((a, r) => a + Number(r[k]), 0);
  const weeks = [...new Set(rows.map((r) => r.week).filter(Boolean) as string[])].sort().slice(-8).map((week) => {
    const at = (v: string) => rows.find((r) => r.week === week && r.verification === v);
    return {
      week,
      verifiedEmailed: Number(at("verified")?.emailed ?? 0),
      verifiedBounced: Number(at("verified")?.bounced ?? 0),
      unconfirmedEmailed: Number(at("catch_all")?.emailed ?? 0),
      unconfirmedBounced: Number(at("catch_all")?.bounced ?? 0),
    };
  });
  return {
    verified: { emailed: sum("verified", "emailed"), bounced: sum("verified", "bounced") },
    unconfirmed: { emailed: sum("catch_all", "emailed"), bounced: sum("catch_all", "bounced") },
    weeks,
  };
}

/** The suggested batch for a campaign's waiting unconfirmed contacts, from how the client's earlier ones did. */
export async function unconfirmedSuggestion(clientId: number, waiting: number) {
  const e = await checkEvidence(clientId);
  return { ...unconfirmedBatch(e.unconfirmed.emailed, e.unconfirmed.bounced, waiting), evidence: e };
}

/** Problem companies the client has, for the Today list. */
export async function problemDomainCount(clientId: number): Promise<number> {
  return (await get<{ n: number }>("SELECT COUNT(*) n FROM problem_domains WHERE client_id = ? AND cleared_at IS NULL", clientId))?.n ?? 0;
}
