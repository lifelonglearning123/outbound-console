import { syncAll } from "@/lib/sync";

// Vercel Cron calls this every 30 minutes (vercel.json), which keeps Neon on its free plan. It syncs every client with Instantly and GHL,
// then writes any queued emails. Protected by CRON_SECRET, which Vercel sends as a bearer token.
export const maxDuration = 800;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const ran = await syncAll();
  return Response.json({ ok: true, skipped: ran === undefined, seconds: Math.round((Date.now() - started) / 1000) });
}
