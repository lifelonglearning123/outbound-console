import { syncAll } from "./sync";

declare global {
   
  var __outbound_sync_timer: NodeJS.Timeout | undefined;
}

export function startSyncLoop() {
  if (globalThis.__outbound_sync_timer || process.env.SYNC_DISABLED === "1") return;
  const minutes = Math.max(1, Number(process.env.SYNC_MINUTES || 3));
  const tick = () => syncAll().catch((e) => console.error("[sync]", e));
  globalThis.__outbound_sync_timer = setInterval(tick, minutes * 60_000);
  setTimeout(tick, 15_000); // first run shortly after start-up
  console.log(`[sync] Instantly sync every ${minutes} min`);
}
