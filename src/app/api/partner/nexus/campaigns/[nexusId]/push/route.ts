import { partnerAuth, push, readJson, respond } from "@/lib/nexus";

// Nexus partner API (docs/nexus-partner-api.md): hand every approved person to Instantly, by the console's rules.
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ nexusId: string }> }) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  const { nexusId } = await params;
  return respond(async () => push(nexusId, await readJson(req)));
}
