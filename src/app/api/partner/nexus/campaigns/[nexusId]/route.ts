import { partnerAuth, putCampaign, readJson, respond } from "@/lib/nexus";

// Nexus partner API (docs/nexus-partner-api.md): create or update a Nexus campaign here and in Instantly.
export const maxDuration = 120;

export async function PUT(req: Request, { params }: { params: Promise<{ nexusId: string }> }) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  const { nexusId } = await params;
  return respond(async () => putCampaign(nexusId, await readJson(req)));
}
