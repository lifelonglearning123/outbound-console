import "server-only";
import { getSetting, setSetting } from "./db";

/**
 * The least time between two campaigns emailing the same person. Someone who finished one campaign's sequence this
 * morning shouldn't get a different campaign's email this afternoon. Waiting contacts go by themselves once it's over.
 * Per client; 0 turns it off.
 */
export const DEFAULT_GAP_DAYS = 7;

export async function gapDays(clientId: number): Promise<number> {
  const n = Number(await getSetting(`campaign_gap_days_${clientId}`, String(DEFAULT_GAP_DAYS)));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_GAP_DAYS;
}

export async function saveGapDays(clientId: number, days: number) {
  await setSetting(`campaign_gap_days_${clientId}`, String(Math.min(365, Math.max(0, Math.floor(days) || 0))));
}

/** Emails sent before this moment are far enough back. With no gap nothing is recent, so the cutoff is after every email. */
export const gapCutoff = (days: number) => (days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : "9999");
