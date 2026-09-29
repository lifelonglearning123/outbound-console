// Runs once when the server starts. The server is the background service (it starts with Windows),
// so the Instantly sync loop lives here and keeps going whether or not a browser tab is open.
export async function register() {
  // Written as a single inline check so webpack drops the import from the edge bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSyncLoop } = await import("./lib/scheduler");
    startSyncLoop();
  }
}
