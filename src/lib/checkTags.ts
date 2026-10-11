/** Address check results and the Nexus Portal tag each one gets. Free of imports so both import and reporting can use it. */

export type Outcome = "verified" | "catch_all" | "invalid";
/** The exact tag each group gets in the portal. */
export const GHL_TAGS: Record<Outcome, string> = { verified: "Email Verified", catch_all: "Email Unable To Verify", invalid: "Email Invalid" };

/**
 * The check result a portal contact's tags already record, so importing it doesn't pay for another check.
 * The portal lowercases tags, so the match ignores case; if a contact carries more than one, the most cautious wins.
 */
export function portalCheck(tags: unknown): Outcome | null {
  if (!Array.isArray(tags)) return null;
  const have = new Set(tags.map((t) => String(t).trim().toLowerCase()));
  for (const o of ["invalid", "catch_all", "verified"] as const) if (have.has(GHL_TAGS[o].toLowerCase())) return o;
  return null;
}
