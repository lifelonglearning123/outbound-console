import "server-only";
import { Resolver } from "node:dns/promises";
import { all, run, withLock } from "./db";

/**
 * Who handles a company's email, read from its domain's MX records, so we know before sending whether a security
 * filter sits in front of it. Mimecast in particular accepts the address check and then refuses cold email from a
 * sending domain it doesn't trust yet, which Instantly counts as a bounce.
 * Results are kept per domain in mail_domains; leads join on the part of their address after the @.
 */

export type Gateway = "mimecast" | "proofpoint" | "barracuda" | "cisco";
export type Provider = "google" | "microsoft" | "other" | "none";

export const GATEWAY_LABEL: Record<Gateway, string> = { mimecast: "Mimecast", proofpoint: "Proofpoint", barracuda: "Barracuda", cisco: "Cisco" };
export const PROVIDER_LABEL: Record<Provider, string> = { google: "Google", microsoft: "Microsoft", other: "Other", none: "No mail server" };

const GATEWAYS: [RegExp, Gateway][] = [
  [/\.mimecast\.(com|co\.za)$/, "mimecast"],
  [/\.(pphosted|ppe-hosted)\.com$/, "proofpoint"],
  [/\.barracudanetworks\.com$/, "barracuda"],
  [/\.iphmx\.com$/, "cisco"],
];

/** The domain of an address, as SQL against a lead aliased `a`. */
export const DOMAIN = (a: string) => `split_part(${a}.email, '@', 2)`;

/** SQL: the lead's company filters its mail through Mimecast. */
export const BEHIND_MIMECAST = (a: string) =>
  `EXISTS (SELECT 1 FROM mail_domains md WHERE md.domain = ${DOMAIN(a)} AND md.gateway = 'mimecast')`;

/** SQL: the lead's company has any security filter in front of its mail. */
export const BEHIND_GATEWAY = (a: string) =>
  `EXISTS (SELECT 1 FROM mail_domains md WHERE md.domain = ${DOMAIN(a)} AND md.gateway IS NOT NULL)`;

export function classify(mx: string[]): { provider: Provider; gateway: Gateway | null } {
  if (mx.length === 0) return { provider: "none", gateway: null };
  const hosts = mx.map((h) => h.toLowerCase().replace(/\.$/, ""));
  const gateway = GATEWAYS.find(([re]) => hosts.some((h) => re.test(h)))?.[1] ?? null;
  const provider: Provider = hosts.some((h) => h.endsWith(".mail.protection.outlook.com") || h.endsWith(".outlook.com"))
    ? "microsoft"
    : hosts.some((h) => h.endsWith(".google.com") || h.endsWith(".googlemail.com"))
      ? "google"
      : "other";
  return { provider, gateway };
}

// Public resolvers: some hosts' own resolvers refuse MX queries.
const resolver = new Resolver({ timeout: 3000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

/** Look up one domain. Returns null if DNS didn't answer, so it's tried again later. */
async function lookup(domain: string): Promise<{ provider: Provider; gateway: Gateway | null; mx: string[] } | null> {
  try {
    const mx = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
    return { ...classify(mx), mx };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { provider: "none", gateway: null, mx: [] };
    return null;
  }
}

/** Look up the mail server of every lead domain not seen yet. Safe to call repeatedly; one run at a time. */
export async function detectMailDomains(limit = 400) {
  await withLock("mail-domains", 5 * 60_000, async () => {
    const domains = (await all<{ domain: string }>(
      `SELECT DISTINCT ${DOMAIN("l")} domain FROM leads l
       WHERE NOT EXISTS (SELECT 1 FROM mail_domains md WHERE md.domain = ${DOMAIN("l")}) LIMIT ?`,
      limit,
    )).map((d) => d.domain).filter(Boolean);
    const now = new Date().toISOString();
    for (let i = 0; i < domains.length; i += 20) {
      const batch = domains.slice(i, i + 20);
      const found = await Promise.all(batch.map(async (domain) => ({ domain, r: await lookup(domain) })));
      const rows = found.filter((f) => f.r).map((f) => ({ domain: f.domain, provider: f.r!.provider, gateway: f.r!.gateway, mx: f.r!.mx.slice(0, 3).join(", ") }));
      if (rows.length) {
        await run(
          `INSERT INTO mail_domains (domain, provider, gateway, mx, checked_at)
           SELECT x.domain, x.provider, x.gateway, x.mx, ? FROM jsonb_to_recordset(?::jsonb) AS x(domain text, provider text, gateway text, mx text)
           ON CONFLICT (domain) DO NOTHING`,
          now, JSON.stringify(rows),
        );
      }
    }
  });
}

/** Unchecked domains among a campaign's leads (the contacts page keeps the lookup going while there are some). */
export async function uncheckedDomains(campaignId: number): Promise<number> {
  return (await all<{ n: number }>(
    `SELECT COUNT(DISTINCT ${DOMAIN("l")}) n FROM leads l
     WHERE l.campaign_id = ? AND NOT EXISTS (SELECT 1 FROM mail_domains md WHERE md.domain = ${DOMAIN("l")})`,
    campaignId,
  ))[0]?.n ?? 0;
}
