import { originOf, partnerAuth, readJson, respond, signin } from "@/lib/nexus";

// Nexus partner API (docs/nexus-partner-api.md): a one-time link signing a Nexus user in as this client's login.
export async function POST(req: Request) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  return respond(async () => signin(await readJson(req), originOf(req)));
}
