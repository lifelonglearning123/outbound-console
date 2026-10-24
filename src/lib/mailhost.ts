import "server-only";
import { Resolver } from "node:dns/promises";
import { all, run, withLock } from "./db";

/** Free and personal mail services: two bounces there say nothing about a company, so they're never a problem domain. */
export const FREE_MAIL = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "btinternet.com", "sky.com", "proton.me",
  "protonmail.com", "gmx.com", "gmx.de", "web.de", "mail.com", "zoho.com", "yandex.com",
];

/**
 * Who handles a company's email, read from its domain's MX records, so we know before sending whether a security
 * filter sits in front of it. Mimecast in particular accepts the address check and then refuses cold email from a
 * sending domain it doesn't trust yet, which Instantly counts as a bounce.
 * Results are kept per domain in mail_domains; leads join on the part of their address after the @.
 */

export type Gateway =
  | "mimecast" | "proofpoint" | "barracuda" | "cisco" | "symantec" | "hornetsecurity" | "sophos" | "forcepoint"
  | "trendmicro" | "appriver" | "trellix" | "fortinet";
export type Provider = "google" | "microsoft" | "other" | "none";

export const GATEWAY_LABEL: Record<Gateway, string> = {
  mimecast: "Mimecast", proofpoint: "Proofpoint", barracuda: "Barracuda", cisco: "Cisco", symantec: "Symantec",
  hornetsecurity: "Hornetsecurity", sophos: "Sophos", forcepoint: "Forcepoint", trendmicro: "Trend Micro",
  appriver: "AppRiver", trellix: "Trellix", fortinet: "FortiMail",
};
export const PROVIDER_LABEL: Record<Provider, string> = { google: "Google", microsoft: "Microsoft", other: "Other", none: "No mail server" };

const GATEWAYS: [RegExp, Gateway][] = [
  [/\.mimecast(-offshore)?\.(com|co\.za)$/, "mimecast"],
  [/\.(pphosted|ppe-hosted)\.com$/, "proofpoint"],
  [/\.barracudanetworks\.com$/, "barracuda"],
  [/\.iphmx\.com$/, "cisco"],
  [/\.messagelabs\.com$/, "symantec"], // Symantec / Broadcom Email Security.cloud
  [/\.(hornetsecurity|antispameurope)\.com$/, "hornetsecurity"],
  [/\.hydra\.sophos\.com$/, "sophos"],
  [/\.mailcontrol\.com$/, "forcepoint"],
  [/\.tmes(-[a-z]+)?\.trendmicro\.[a-z.]+$/, "trendmicro"],
  [/\.arsmtp\.com$/, "appriver"],
  [/\.fireeyecloud\.com$/, "trellix"],
  [/\.fortimailcloud\.com$/, "fortinet"],
];

/** Bump when GATEWAYS changes, so domains already looked up are re-filed from their stored MX hosts. */
const CLASSIFIER_VERSION = "2";

/** The domain of an address, as SQL against a lead aliased `a`. */
export const DOMAIN = (a: string) => `split_part(${a}.email, '@', 2)`;

/** SQL with one `?` (a text[] of gateways): the lead's company filters its mail through one of them. */
export const BEHIND_HELD = (a: string) =>
  `EXISTS (SELECT 1 FROM mail_domains md WHERE md.domain = ${DOMAIN(a)} AND md.gateway = ANY(?))`;

/** SQL: the lead's company has any security filter in front of its mail. */
export const BEHIND_GATEWAY = (a: string) =>
  `EXISTS (SELECT 1 FROM mail_domains md WHERE md.domain = ${DOMAIN(a)} AND md.gateway IS NOT NULL)`;

/** SQL: the lead's company is on its client's problem companies list (deliverability.ts). */
export const AT_PROBLEM_DOMAIN = (a: string) =>
  `EXISTS (SELECT 1 FROM problem_domains pd WHERE pd.client_id = ${a}.client_id AND pd.domain = ${DOMAIN(a)} AND pd.cleared_at IS NULL)`;

/** SQL: the lead's domain doesn't exist or can't receive email, so an email to it can only bounce. */
export const NO_MAIL_SERVER = (a: string) =>
  `EXISTS (SELECT 1 FROM mail_domains md WHERE md.domain = ${DOMAIN(a)} AND md.provider = 'none')`;

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
    if (code === "ENOTFOUND") return { provider: "none", gateway: null, mx: [] };
    // No MX record: mail still goes to the domain's own address if it has one, so it's only "none" without that too.
    if (code === "ENODATA") return (await hasAddress(domain)) ? { provider: "other", gateway: null, mx: [] } : { provider: "none", gateway: null, mx: [] };
    return null;
  }
}

async function hasAddress(domain: string): Promise<boolean> {
  for (const resolve of [() => resolver.resolve4(domain), () => resolver.resolve6(domain)]) {
    try {
      if ((await resolve()).length) return true;
    } catch {}
  }
  return false;
}

/**
 * Re-file every domain already looked up when the list of filters grows, from the MX hosts stored with it (no DNS),
 * and look again at domains filed as having no mail server, which used to include ones that only lack an MX record.
 */
export async function reclassifyMailDomains() {
  const done = (await all<{ value: string }>("SELECT value FROM settings WHERE key = 'mailhost_classifier'"))[0]?.value;
  if (done === CLASSIFIER_VERSION) return;
  const rows = await all<{ domain: string; provider: Provider; gateway: Gateway | null; mx: string | null }>(
    "SELECT domain, provider, gateway, mx FROM mail_domains",
  );
  const changed: { domain: string; provider: Provider; gateway: Gateway | null }[] = [];
  for (const r of rows) {
    if (r.provider === "none") {
      const again = await lookup(r.domain);
      if (again && (again.provider !== r.provider || again.gateway !== r.gateway)) changed.push({ domain: r.domain, provider: again.provider, gateway: again.gateway });
      continue;
    }
    // Only the first three MX hosts are stored, so the provider read from them first stays; only the filter is re-read.
    const hosts = (r.mx ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (!hosts.length) continue;
    const gateway = classify(hosts).gateway;
    if (gateway !== r.gateway) changed.push({ domain: r.domain, provider: r.provider, gateway });
  }
  if (changed.length) {
    await run(
      `UPDATE mail_domains md SET provider = x.provider, gateway = x.gateway
       FROM jsonb_to_recordset(?::jsonb) AS x(domain text, provider text, gateway text) WHERE md.domain = x.domain`,
      JSON.stringify(changed),
    );
  }
  await run(
    "INSERT INTO settings (key, value) VALUES ('mailhost_classifier', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    CLASSIFIER_VERSION,
  );
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
