// Web addresses in plain text, found the way a reader sees them, so an email written as text arrives with
// real links. The same rule as Nexus Portal's src/lib/links.ts: a full stop or a bracket the sentence put
// after a link stays out of it, a link's own brackets stay in, and "www.x.co" is a link opening on https.

export type TextPart = { text: string; href?: string };

const START = /(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", "’", "”", "*", "…"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, char: string) => [...text].filter((c) => c === char).length;

function trimmed(url: string): string {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (!last) return out;
    if (TRAILING.has(last)) {
      out = out.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && count(out, last) > count(out, opener)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

function hasHost(url: string): boolean {
  const rest = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  return /^[^\s/?#]*[\w}]/.test(rest) && (/\./.test(rest.split(/[/?#]/)[0]) || /\{\{/.test(rest));
}

/** The text in pieces, each link with the address it opens. */
export function textParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const match of text.matchAll(START)) {
    const start = match.index ?? 0;
    if (start > 0 && /[\w@./-]/.test(text[start - 1])) continue;
    const url = trimmed(match[0]);
    if (!hasHost(url)) continue;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    at = start + url.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
