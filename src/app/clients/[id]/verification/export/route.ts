import type { NextRequest } from "next/server";
import { requireClientAccess } from "@/lib/auth";
import { requireClient } from "@/lib/clients";
import { groupLeads, portalStatus, GHL_TAGS, OUTCOMES, OUTCOME_LABEL, type Outcome } from "@/lib/verifyReport";

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote everything; a leading = + - @ would be read as a formula by spreadsheets.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** CSV of one verification group: /clients/2/verification/export?group=verified|catch_all|invalid */
export async function GET(req: NextRequest, ctx: RouteContext<"/clients/[id]/verification/export">) {
  const clientId = Number((await ctx.params).id);
  await requireClientAccess(clientId); // only admins and this client's own logins
  const group = req.nextUrl.searchParams.get("group") as Outcome;
  if (!OUTCOMES.includes(group)) return new Response("Unknown group", { status: 400 });

  const client = await requireClient(clientId);
  const campaignId = Number(req.nextUrl.searchParams.get("campaign")) || null;
  const leads = await groupLeads(clientId, group, campaignId);
  const header = ["Email", "First name", "Last name", "Company", "Campaign", "Result", "Tag", "Nexus Portal", "In Instantly", "Checked at"];
  const lines = leads.map((l) =>
    [l.email, l.first_name, l.last_name, l.company, l.campaign, OUTCOME_LABEL[group], GHL_TAGS[group], portalStatus(l, group), l.in_instantly ? "Yes" : "No", l.verified_at?.slice(0, 16).replace("T", " ")]
      .map(cell)
      .join(","),
  );
  const slug = `${client.name}-${GHL_TAGS[group]}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return new Response("﻿" + [header.map(cell).join(","), ...lines].join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
