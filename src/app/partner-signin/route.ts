import { redirect } from "next/navigation";
import { get } from "@/lib/db";
import { readToken, startSession } from "@/lib/auth";
import { claimNonce, type SigninToken } from "@/lib/nexus";

// The one-time link Nexus hands a person (POST /api/partner/nexus/signin): signs them in as the client's login and
// opens the campaign's contacts. Works once, within two minutes of being made.
export const dynamic = "force-dynamic";

function refuse(why: string) {
  return new Response(`${why} Open the outbound console from Nexus again for a fresh link.`, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(req: Request) {
  const t = readToken<SigninToken>(new URL(req.url).searchParams.get("token"));
  if (!t || typeof t.uid !== "number" || typeof t.path !== "string" || typeof t.nonce !== "string" || typeof t.exp !== "number") {
    return refuse("This sign-in link isn't valid.");
  }
  if (t.exp < Date.now()) return refuse("This sign-in link has expired.");
  if (!t.path.startsWith("/clients/")) return refuse("This sign-in link isn't valid.");
  if (!(await get("SELECT 1 FROM users WHERE id = ?", t.uid))) return refuse("This sign-in link isn't valid.");
  if (!(await claimNonce(t.nonce, t.exp))) return refuse("This sign-in link has already been used.");
  await startSession(t.uid);
  redirect(t.path);
}
