import { partnerAuth, readJson, respond, setStatus } from "@/lib/nexus";

// Nexus partner API (docs/nexus-partner-api.md): pause or resume sending.
export async function POST(req: Request, { params }: { params: Promise<{ nexusId: string }> }) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  const { nexusId } = await params;
  return respond(async () => setStatus(nexusId, await readJson(req)));
}
