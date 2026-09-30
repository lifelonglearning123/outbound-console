"use server";

import { clientOfEmail, requireClientAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { get, run, logActivity } from "@/lib/db";
import { requireClient } from "@/lib/clients";
import { instantly } from "@/lib/instantly";
import { applyInterest, pushToGhl, INTEREST_LABELS } from "@/lib/triage";
import { toHtml } from "@/lib/push";

export async function tagReply(emailId: string, interest: string) {
  await requireClientAccess(await clientOfEmail(emailId));
  if (!(interest in INTEREST_LABELS)) throw new Error("Unknown tag");
  await applyInterest(emailId, interest, "Set by hand", "manual");
  revalidatePath("/inbox");
}

export async function sendToGhl(emailId: string): Promise<string> {
  await requireClientAccess(await clientOfEmail(emailId));
  try {
    const msg = await pushToGhl(emailId);
    revalidatePath("/inbox");
    return msg;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function markRead(emailId: string) {
  await requireClientAccess(await clientOfEmail(emailId));
  await run("UPDATE emails SET is_unread = 0 WHERE id = ?", emailId);
  revalidatePath("/inbox");
}

export async function replyTo(emailId: string, text: string): Promise<string> {
  await requireClientAccess(await clientOfEmail(emailId));
  const e = await get<{ client_id: number; account_email: string; subject: string; lead_email: string }>("SELECT * FROM emails WHERE id = ?", emailId);
  if (!e) return "Email not found";
  if (!text.trim()) return "Write something first";
  const client = await requireClient(e.client_id);
  try {
    await instantly(client.instantly_api_key!).reply({
      eaccount: e.account_email,
      reply_to_uuid: emailId,
      subject: e.subject?.toLowerCase().startsWith("re:") ? e.subject : `Re: ${e.subject ?? ""}`,
      body: { html: toHtml(text), text },
    });
    await run("UPDATE emails SET is_unread = 0 WHERE id = ?", emailId);
    await logActivity(e.client_id, "reply_sent", `Replied to ${e.lead_email}`);
    revalidatePath("/inbox");
    return "Sent";
  } catch (err) {
    return (err as Error).message;
  }
}
