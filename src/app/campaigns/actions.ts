"use server";

import { clientOfCampaign, requireClientAccess } from "@/lib/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { get, run, tx, logActivity } from "@/lib/db";
import {
  archiveCampaign, campaignStepProblems, deleteEmptyCampaign, hasOwnSubject, isNexus, restoreCampaign, liveSteps, NEXUS_NOTICE, pushedLeadCount, requireCampaign, setCampaignRunning, stepEmailChanged,
  syncCampaignToInstantly, toInstantlySchedule, type Step,
} from "@/lib/campaigns";
import { applyRelease, cancelRelease, prepareRelease, retryFailed } from "@/lib/hold";
import { after } from "next/server";
import { runWriter } from "@/lib/writer";
import { INSTANTLY_TIMEZONES } from "@/lib/timezones";
import { requireClient } from "@/lib/clients";
import { instantly } from "@/lib/instantly";
import { sanitizeEmailHtml } from "@/lib/merge";
import { sendList } from "@/lib/mailboxHealth";
import { cancelStart, scheduleStart, startNow } from "@/lib/scheduling";

export async function pauseCampaign(id: number) {
  await requireClientAccess(await clientOfCampaign(id));
  await setCampaignRunning(id, false);
  revalidatePath("/", "layout");
}

export async function resumeCampaign(id: number) {
  await requireClientAccess(await clientOfCampaign(id));
  const c = await requireCampaign(id);
  // First start of a console campaign: its approved contacts go with it. Otherwise it would say "Sending" with nobody to send to.
  if (c.status === "draft" && c.managed && !isNexus(c)) await startNow(id);
  else await setCampaignRunning(id, true);
  revalidatePath("/", "layout");
}

export async function archive(id: number) {
  await requireClientAccess(await clientOfCampaign(id));
  await archiveCampaign(id);
  revalidatePath("/", "layout");
}

export async function restore(id: number) {
  await requireClientAccess(await clientOfCampaign(id));
  await restoreCampaign(id);
  revalidatePath("/", "layout");
}

export async function deleteEmpty(id: number) {
  await requireClientAccess(await clientOfCampaign(id));
  await deleteEmptyCampaign(id);
  revalidatePath("/", "layout");
}

/** Start this campaign at the time picked, in the campaign's own timezone. */
export async function scheduleCampaign(id: number, form: FormData) {
  await requireClientAccess(await clientOfCampaign(id));
  await scheduleStart(id, String(form.get("start_at") ?? ""));
  revalidatePath("/", "layout");
}

export async function cancelSchedule(id: number) {
  await requireClientAccess(await clientOfCampaign(id));
  await cancelStart(id);
  revalidatePath("/", "layout");
}

function readForm(form: FormData) {
  const name = String(form.get("name") ?? "").trim();
  if (!name) throw new Error("Campaign name is required");

  const steps: Step[] = [];
  for (let i = 1; form.has(`step_${i}_instructions`); i++) {
    const delay_days = Math.max(0, Number(form.get(`step_${i}_delay`) ?? 0));
    if (form.get(`step_${i}_mode`) === "fixed") {
      // The client's own designed email: kept exactly, only cleaned of scripts.
      const body = sanitizeEmailHtml(String(form.get(`step_${i}_body`) ?? ""));
      const subject = String(form.get(`step_${i}_subject`) ?? "").trim();
      steps.push({ delay_days, instructions: "Client's own email", mode: "fixed", subject, body });
    } else {
      steps.push({
        delay_days, instructions: String(form.get(`step_${i}_instructions`) ?? "").trim(), mode: "ai",
        ...(i > 1 && form.get(`step_${i}_new_subject`) ? { new_subject: true } : {}),
      });
    }
  }
  if (steps.length === 0) throw new Error("Add at least one step");
  const holdRaw = Number(form.get("hold_after") || 0);
  const holdAfter = holdRaw > 0 && holdRaw < steps.length ? holdRaw : null;
  // Steps after a hold may be unfinished; everything that will go live must be complete.
  const problems = campaignStepProblems(steps.slice(0, holdAfter ?? steps.length));
  if (problems.length) throw new Error(`Fix before saving: ${problems.join("; ")}`);

  const timezone = String(form.get("timezone"));
  if (!(INSTANTLY_TIMEZONES as readonly string[]).includes(timezone)) throw new Error(`Instantly doesn't accept timezone ${timezone}`);
  const schedule = {
    days: form.getAll("days").map(Number),
    from: String(form.get("from") || "09:00"),
    to: String(form.get("to") || "17:00"),
    timezone,
  };
  if (schedule.days.length === 0) throw new Error("Pick at least one sending day");

  return {
    name,
    steps: JSON.stringify(steps),
    schedule: JSON.stringify(schedule),
    daily_limit: Math.max(1, Number(form.get("daily_limit") || 30)),
    accounts: JSON.stringify(form.getAll("accounts").map(String)),
    stop_on_reply: form.get("stop_on_reply") ? 1 : 0,
    match_esp: form.get("match_esp") ? 1 : 0,
    hold_after: holdAfter,
    list: steps,
    ghl_tag: String(form.get("ghl_tag") ?? "").trim() || null,
  };
}

export async function saveCampaign(clientId: number, campaignId: number | null, form: FormData) {
  await requireClientAccess(clientId);
  if (campaignId && (await clientOfCampaign(campaignId)) !== clientId) throw new Error("Campaign not found");
  if (campaignId && isNexus(await requireCampaign(campaignId))) throw new Error(NEXUS_NOTICE);
  const { list, ...fields } = readForm(form);
  let id = campaignId;
  if (id) {
    const existing = await requireCampaign(id);
    if (existing.managed && existing.release_to) throw new Error("A hold release is in progress. Apply or cancel it before editing the steps.");
    // Follow-ups that have gained or lost their own subject.
    const subjectChanged = existing.managed
      ? list.flatMap((s, i) => (existing.steps[i] && hasOwnSubject(s, i) !== hasOwnSubject(existing.steps[i], i) ? [i + 1] : []))
      : [];
    if (existing.managed && await pushedLeadCount(id) > 0) {
      // Leads are already in Instantly with their copy: the live steps stay as they are, and any steps
      // beyond them are held until released from the campaign page (so nobody gets a step without copy).
      const live = liveSteps(existing);
      if (list.length < live) throw new Error(`Steps 1-${live} are already live in Instantly and can't be removed.`);
      // Those contacts' copy has no subject for a step that didn't have one, so it would go out blank.
      const locked = subjectChanged.find((n) => n <= live);
      if (locked) throw new Error(`Follow-up ${locked} is already being sent, so its subject can't be added or removed. Change it on a follow-up that isn't live yet.`);
      fields.hold_after = list.length > live ? live : existing.hold_after;
    }
    if (existing.managed) {
      // Emails already prepared for anyone not yet sent would still go out in their old wording. Those steps are
      // prepared again and need approving again; a step that didn't change keeps its email and its approval.
      const changed = list.flatMap((s, i) => (existing.steps[i] && stepEmailChanged(s, existing.steps[i]) ? [i + 1] : []));
      const prepared = "SELECT id FROM leads WHERE campaign_id = ? AND pushed_at IS NULL AND instantly_lead_id IS NULL AND stage IN ('drafting', 'review', 'approved', 'error')";
      const again = await tx(async () => {
        await run(`DELETE FROM drafts WHERE (step = ANY(?) OR step > ?) AND lead_id IN (${prepared})`, changed, list.length, id);
        if (changed.length === 0) return 0;
        return (await run(`UPDATE leads SET stage = 'drafting', stage_message = NULL WHERE id IN (${prepared}) AND stage IN ('review', 'approved')`, id)).changes;
      });
      if (again) {
        await logActivity(clientId, "write", `The email changed in "${existing.name}", so ${again} ${again === 1 ? "contact's emails are" : "contacts' emails are"} being prepared again and need approving again`);
        after(runWriter);
      }
    }
    if (!existing.managed) {
      // External campaigns: only the controls we can safely change from here.
      await run(
        "UPDATE campaigns SET daily_limit = @daily_limit, accounts = @accounts, schedule = @schedule, match_esp = @match_esp WHERE id = @id",
        { ...fields, id },
      );
    } else {
      await run(
        `UPDATE campaigns SET name = @name, steps = @steps, schedule = @schedule, daily_limit = @daily_limit,
           accounts = @accounts, stop_on_reply = @stop_on_reply, hold_after = @hold_after, ghl_tag = @ghl_tag, match_esp = @match_esp WHERE id = @id`,
        { ...fields, id },
      );
    }
  } else {
    // The same campaign created again within a minute is a repeated click, not a new one: open the first.
    const repeat = await get<{ id: number }>(
      "SELECT id FROM campaigns WHERE client_id = ? AND name = ? AND created_at >= to_char(now() AT TIME ZONE 'utc' - interval '60 seconds', 'YYYY-MM-DD HH24:MI:SS') ORDER BY id LIMIT 1",
      clientId, fields.name,
    );
    if (repeat) redirect(`/clients/${clientId}/campaigns/${repeat.id}/contacts`);
    id = (await run(
      `INSERT INTO campaigns (client_id, name, steps, schedule, daily_limit, accounts, stop_on_reply, hold_after, ghl_tag, match_esp)
       VALUES (@clientId, @name, @steps, @schedule, @daily_limit, @accounts, @stop_on_reply, @hold_after, @ghl_tag, @match_esp)`,
      { ...fields, clientId },
    )).id;
    await logActivity(clientId, "campaign", `Created campaign "${fields.name}"`);
  }

  const c = await requireCampaign(id);
  if (c.managed) {
    await syncCampaignToInstantly(id);
  } else if (c.instantly_campaign_id) {
    const client = await requireClient(clientId);
    await instantly(client.instantly_api_key!).patchCampaign(c.instantly_campaign_id, {
      daily_limit: c.daily_limit,
      email_list: await sendList(clientId, c.id, c.accounts),
      campaign_schedule: toInstantlySchedule(c.schedule),
      match_lead_esp: c.match_esp === 1,
    });
    await logActivity(clientId, "campaign", `Updated schedule and limits for "${c.name}"`);
  }

  revalidatePath("/", "layout");
  // A new campaign has no contacts yet, so that's the next step; an edited one goes back to its email.
  redirect(`/clients/${clientId}/campaigns/${id}${campaignId ? "/email" : "/contacts"}`);
}

// ---------- Hold release ----------

export async function startRelease(campaignId: number, form: FormData) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  await prepareRelease(campaignId, Number(form.get("up_to")));
  after(runWriter);
  revalidatePath("/", "layout");
}

export async function finishRelease(campaignId: number): Promise<string> {
  await requireClientAccess(await clientOfCampaign(campaignId));
  try {
    const msg = await applyRelease(campaignId);
    revalidatePath("/", "layout");
    return msg;
  } catch (e) {
    revalidatePath("/", "layout");
    return `Couldn't finish: ${(e as Error).message}`;
  }
}

export async function abandonRelease(campaignId: number) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  await cancelRelease(campaignId);
  revalidatePath("/", "layout");
}

export async function retryRelease(campaignId: number) {
  await requireClientAccess(await clientOfCampaign(campaignId));
  await retryFailed(campaignId);
  after(runWriter);
  revalidatePath("/", "layout");
}
