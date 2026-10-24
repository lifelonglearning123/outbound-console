"use server";

import { requireAdmin, requireClientAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { get, run, logActivity, setSetting } from "@/lib/db";
import { requireClient } from "@/lib/clients";
import { instantly } from "@/lib/instantly";
import { DEFAULT_RULES } from "@/lib/healthLogic";
import {
  bringBack, checkDomains, healthRules, oneMailbox, restMailbox, returnMailbox, startEasing, stopEasing, turnWarmupOn,
} from "@/lib/mailboxHealth";
import { addProblemDomain, clearProblemDomain } from "@/lib/deliverability";

/** A mailbox address the client really has, so an action can't be pointed at someone else's. */
async function ownMailbox(clientId: number, email: string) {
  await requireClientAccess(clientId);
  const m = await get<{ email: string }>("SELECT email FROM mailboxes WHERE client_id = ? AND email = ?", clientId, email);
  if (!m) throw new Error("Mailbox not found");
  return m.email;
}

const done = () => revalidatePath("/", "layout");

/** Pause or resume a mailbox in Instantly. Pausing stops its warmup too, which is why the console itself never does it. */
export async function setMailboxRunning(clientId: number, email: string, running: boolean) {
  await ownMailbox(clientId, email);
  const client = await requireClient(clientId);
  const api = instantly(client.instantly_api_key!);
  const a = running ? await api.resumeAccount(email) : await api.pauseAccount(email);
  await run(
    `UPDATE mailboxes SET status = ?, auto_paused_at = CASE WHEN ? THEN NULL ELSE auto_paused_at END,
       auto_paused_reason = CASE WHEN ? THEN NULL ELSE auto_paused_reason END WHERE client_id = ? AND email = ?`,
    a.status ?? (running ? 1 : 2), running ? 1 : 0, running ? 1 : 0, clientId, email,
  );
  await logActivity(clientId, running ? "resume" : "pause", `${running ? "Resumed" : "Paused"} mailbox ${email}`, { subject: email });
  done();
}

/** Take a mailbox out of its campaigns by hand; warmup keeps running. It comes back when you put it back. */
export async function restNow(clientId: number, email: string) {
  await ownMailbox(clientId, email);
  await restMailbox(clientId, email, "manual", "rested by hand", "you");
  done();
}

/** Put a resting mailbox back into its campaigns now, easing in if that's switched on. */
export async function returnNow(clientId: number, email: string) {
  await ownMailbox(clientId, email);
  await returnMailbox(clientId, email, "you", (await healthRules()).easeIn);
  done();
}

export async function easeIn(clientId: number, email: string) {
  await ownMailbox(clientId, email);
  const m = await oneMailbox(clientId, email);
  await startEasing(clientId, email, m?.ramp?.target ?? m?.dailyLimit ?? 30);
  done();
}

export async function stopEasingNow(clientId: number, email: string) {
  await ownMailbox(clientId, email);
  await stopEasing(clientId, email);
  done();
}

export async function warmupOn(clientId: number, email: string) {
  await ownMailbox(clientId, email);
  await turnWarmupOn(clientId, email);
  done();
}

/** Mailboxes the old rules paused: rest them out of campaigns and resume them so their warmup rebuilds. */
export async function bringBackMailboxes(clientId: number, emails: string[]) {
  for (const e of emails) await ownMailbox(clientId, e);
  await bringBack(clientId, emails);
  done();
}

export async function checkDnsNow(clientId: number) {
  await requireClientAccess(clientId);
  await checkDomains(clientId, { force: true });
  done();
}

export async function addProblemCompany(clientId: number, form: FormData) {
  await requireClientAccess(clientId);
  await addProblemDomain(clientId, String(form.get("domain") ?? ""), String(form.get("reason") ?? ""));
  done();
}

export async function clearProblemCompany(clientId: number, domain: string) {
  await requireClientAccess(clientId);
  await clearProblemDomain(clientId, domain);
  done();
}

/** Undo an automatic (or one-click) action from the Activity list or a mailbox page. */
export async function undoActivity(activityId: number) {
  const a = await get<{ client_id: number | null; subject: string | null; undo: string | null; undone_at: string | null }>(
    "SELECT client_id, subject, undo, undone_at FROM activity WHERE id = ?", activityId,
  );
  if (!a?.client_id || !a.subject || !a.undo || a.undone_at) throw new Error("Nothing to undo");
  await requireClientAccess(a.client_id);
  const clientId = a.client_id;
  if (a.undo === "return") await returnMailbox(clientId, await ownMailbox(clientId, a.subject), "you", (await healthRules()).easeIn);
  else if (a.undo === "rest") await restMailbox(clientId, await ownMailbox(clientId, a.subject), "manual", "undid putting it back", "you");
  else if (a.undo === "stop_easing") await stopEasing(clientId, await ownMailbox(clientId, a.subject));
  else if (a.undo === "clear_domain") await clearProblemDomain(clientId, a.subject);
  else throw new Error("This can't be undone from here");
  await run("UPDATE activity SET undone_at = ? WHERE id = ?", new Date().toISOString(), activityId);
  done();
}

export async function saveHealthRules(form: FormData) {
  await requireAdmin();
  const n = (key: string, fallback: number, min: number) => String(Math.max(min, Number(form.get(key) || fallback)));
  await setSetting("health_bounce_limit", n("bounce", DEFAULT_RULES.bouncePct, 0.5));
  await setSetting("health_min_sends", n("min_sent", DEFAULT_RULES.minSent, 1));
  await setSetting("health_window_days", n("window", DEFAULT_RULES.windowDays, 1));
  await setSetting("health_min_warmup", String(Math.max(0, Number(form.get("warmup") ?? DEFAULT_RULES.minWarmupScore))));
  await setSetting("health_return_days", n("return_days", DEFAULT_RULES.returnDays, 1));
  await setSetting("health_auto_rest", form.get("auto_rest") ? "1" : "0");
  await setSetting("health_auto_return", form.get("auto_return") ? "1" : "0");
  await setSetting("health_ease_in", form.get("ease_in") ? "1" : "0");
  await logActivity(null, "settings", "Updated mailbox health rules");
  revalidatePath("/mailboxes");
}
