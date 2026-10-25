import { partnerAuth, respond, status } from "@/lib/nexus";

// Nexus partner API (docs/nexus-partner-api.md): whether a sub-account can send through the console.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  return respond(() => status(new URL(req.url).searchParams.get("locationId") ?? ""));
}
