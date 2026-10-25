import { partnerAuth, readJson, respond, stopLead } from "@/lib/nexus";

// Nexus partner API (docs/nexus-partner-api.md): take one person out of the campaign, and block them if asked.
export async function POST(req: Request, { params }: { params: Promise<{ nexusId: string }> }) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  const { nexusId } = await params;
  return respond(async () => stopLead(nexusId, await readJson(req)));
}
