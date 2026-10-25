import { after } from "next/server";
import { addLeads, listLeads, partnerAuth, readJson, respond } from "@/lib/nexus";
import { detectMailDomains } from "@/lib/mailhost";
import { runVerifier } from "@/lib/verify";

// Nexus partner API (docs/nexus-partner-api.md): hand people over for checking, and say where each stands.
export const dynamic = "force-dynamic";
// The address checks run after the answer, inside this function's time (the regular sync picks up any left over).
export const maxDuration = 300;

export async function GET(req: Request, { params }: { params: Promise<{ nexusId: string }> }) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  const { nexusId } = await params;
  const q = new URL(req.url).searchParams;
  return respond(() => listLeads(nexusId, q.get("locationId") ?? "", q.get("page")));
}

export async function POST(req: Request, { params }: { params: Promise<{ nexusId: string }> }) {
  const refused = partnerAuth(req);
  if (refused) return refused;
  const { nexusId } = await params;
  return respond(async () => {
    const r = await addLeads(nexusId, await readJson(req));
    if (r.added + r.updated > 0) {
      after(async () => {
        await detectMailDomains(); // who handles each new company's email (Mimecast and the like)
        await runVerifier(); // every new address is checked before Nexus may hand over its words
      });
    }
    return r;
  });
}
