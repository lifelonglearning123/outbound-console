"use client";

import { useTransition } from "react";
import { syncNow } from "@/app/sync/actions";

export function SyncButton({ clientId = null, lastSync }: { clientId?: number | null; lastSync: string }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span>Synced {lastSync}</span>
      <button className="btn" disabled={pending} onClick={() => start(() => syncNow(clientId))}>
        {pending ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
