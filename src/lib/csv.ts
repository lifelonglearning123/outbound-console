/** CSV downloads: every cell quoted, and one starting = + - @ defused so spreadsheets don't read it as a formula. */
export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A CSV file response that opens cleanly in Excel (byte-order mark, CRLF) and is never cached. */
export function csvResponse(filename: string, header: string[], rows: unknown[][]): Response {
  return new Response("﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
