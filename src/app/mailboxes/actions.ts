"use server";

import { requireAdmin, requireClientAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { run, logActivity, setSetting } from "@/lib/db";
import { requireClient } from "@/lib/clients";
import { instantly } from "@/lib/instantly";

export async function setMailboxRunning(clientId: number, email: string, running: boolean) {
  await requireClientAccess(clientId);
  const client = await requireClient(clientId);
  const api = instantly(client.instantly_api_key!);
  const a = running ? await api.resumeAccount(email) : await api.pauseAccount(email);
  await run(
    `UPDATE mailboxes SET status = ?, auto_paused_at = CASE WHEN ? THEN NULL ELSE auto_paused_at END,
       auto_paused_reason = CASE WHEN ? THEN NULL ELSE auto_paused_reason END WHERE client_id = ? AND email = ?`,
    a.status ?? (running ? 1 : 2), running ? 1 : 0, running ? 1 : 0, clientId, email,
  );
  await logActivity(clientId, running ? "resume" : "pause", `${running ? "Resumed" : "Paused"} mailbox ${email}`);
  revalidatePath("/", "layout");
}

export async function saveHealthRules(form: FormData) {
  await requireAdmin();
  await setSetting("health_auto_pause", form.get("auto") ? "1" : "0");
  await setSetting("health_bounce_pct", String(Math.max(0.5, Number(form.get("bounce") || 3))));
  await setSetting("health_min_sent", String(Math.max(1, Number(form.get("min_sent") || 20))));
  await setSetting("health_min_warmup", String(Math.max(0, Number(form.get("warmup") || 70))));
  await logActivity(null, "settings", "Updated mailbox health rules");
  revalidatePath("/mailboxes");
}
