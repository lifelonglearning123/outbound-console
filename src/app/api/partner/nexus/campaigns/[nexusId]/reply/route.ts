import { partnerAuth, readJson, reply, respond } from "@/lib/nexus";

// Nexus partner API (docs/nexus-partner-api.md): an email in the person's thread, from the mailbox writing to them.
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ nexusId: string }> }) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  const { nexusId } = await params;
  return respond(async () => reply(nexusId, await readJson(req)));
}
