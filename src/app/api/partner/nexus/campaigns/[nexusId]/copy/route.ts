import { partnerAuth, putCopy, readJson, respond } from "@/lib/nexus";

// Nexus partner API (docs/nexus-partner-api.md): the approved words for people whose address passed.
export async function PUT(req: Request, { params }: { params: Promise<{ nexusId: string }> }) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  const { nexusId } = await params;
  return respond(async () => putCopy(nexusId, await readJson(req)));
}
