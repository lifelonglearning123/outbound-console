// Runs once when the server starts. On Vercel, Vercel Cron drives the sync (see vercel.json), so this only
// starts the in-process timer when the app runs on a single machine (npm run dev / start).
export async function register() {
  // Written as a single inline check so webpack drops the import from the edge bundle.
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    const { startSyncLoop } = await import("./lib/scheduler");
    startSyncLoop();
  }
}
