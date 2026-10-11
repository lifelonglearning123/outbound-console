/** What an import did, shared by the server import and the importer UI (which adds up the chunks of a large import). */

/**
 * skippedExisting: already in this campaign and past 'new'.
 * skippedDoNotContact: replied, bounced, unsubscribed or invalid in an earlier campaign; never added again.
 * reused: kept an earlier check result (from another campaign or the portal's tags) instead of being checked again.
 */
export type ImportResult = {
  added: number;
  updated: number;
  skippedInvalid: number;
  skippedExisting: number;
  skippedDoNotContact: number;
  reused: number;
};

export const NO_IMPORT: ImportResult = { added: 0, updated: 0, skippedInvalid: 0, skippedExisting: 0,skippedDoNotContact: 0, reused: 0 };

export function addImports(a: ImportResult, b: ImportResult): ImportResult {
  return Object.fromEntries(Object.keys(NO_IMPORT).map((k) => [k, a[k as keyof ImportResult] + b[k as keyof ImportResult]])) as ImportResult;
}
