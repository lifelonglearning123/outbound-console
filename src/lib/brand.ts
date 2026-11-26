/**
 * The sending service is never named to people using the console: it's "the sending platform", the same way GHL is the
 * "Nexus Portal". Messages the console writes itself already say so; this catches text that comes from elsewhere
 * (the service's own error messages) before it's saved or shown.
 */
export function unbrand(text: string): string;
export function unbrand(text: string | null): string | null;
export function unbrand(text: string | null): string | null {
  if (!text || !/instantly/i.test(text)) return text;
  return text
    .replace(/https?:\/\/(app\.)?instantly\.ai\S*/gi, "the sending platform")
    .replace(/\bInstantly(?:&apos;|')s\b/g, "the sending platform's")
    .replace(/\bInstantly\b/g, "the sending platform")
    // A capital where it starts a sentence or the whole text.
    .replace(/(^|[.!?:]\s+|\(\s*)the sending platform/g, (_, before: string) => `${before}The sending platform`);
}
