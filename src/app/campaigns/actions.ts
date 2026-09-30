"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { run, logActivity } from "@/lib/db";
import {
  campaignStepProblems, liveSteps, pushedLeadCount, requireCampaign, setCampaignRunning, syncCampaignToInstantly,
  toInstantlySchedule, type Step,
} from "@/lib/campaigns";
import { applyRelease, cancelRelease, prepareRelease, retryFailed } from "@/lib/hold";
import { after } from "next/server";
import { runWriter } from "@/lib/writer";
import { INSTANTLY_TIMEZONES } from "@/lib/timezones";
import { requireClient } from "@/lib/clients";
import { instantly } from "@/lib/instantly";
import { sanitizeEmailHtml } from "@/lib/merge";

export async function pauseCampaign(id: number) {
  await setCampaignRunning(id, false);
  revalidatePath("/", "layout");
}

export async function resumeCampaign(id: number) {
  await setCampaignRunning(id, true);
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
      steps.push({ delay_days, instructions: String(form.get(`step_${i}_instructions`) ?? "").trim(), mode: "ai" });
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
    hold_after: holdAfter,
    step_count: steps.length,
  };
}

export async function saveCampaign(clientId: number, campaignId: number | null, form: FormData) {
  const { step_count, ...fields } = readForm(form);
  let id = campaignId;
  if (id) {
    const existing = requireCampaign(id);
    if (existing.managed && existing.release_to) throw new Error("A hold release is in progress. Apply or cancel it before editing the steps.");
    if (existing.managed && pushedLeadCount(id) > 0) {
      // Leads are already in Instantly with their copy: the live steps stay as they are, and any steps
      // beyond them are held until released from the campaign page (so nobody gets a step without copy).
      const live = liveSteps(existing);
      if (step_count < live) throw new Error(`Steps 1-${live} are already live in Instantly and can't be removed.`);
      fields.hold_after = step_count > live ? live : existing.hold_after;
    }
    if (!existing.managed) {
      // External campaigns: only the controls we can safely change from here.
      run("UPDATE campaigns SET daily_limit = @daily_limit, accounts = @accounts, schedule = @schedule WHERE id = @id", { ...fields, id });
    } else {
      run(
        `UPDATE campaigns SET name = @name, steps = @steps, schedule = @schedule, daily_limit = @daily_limit,
           accounts = @accounts, stop_on_reply = @stop_on_reply, hold_after = @hold_after WHERE id = @id`,
        { ...fields, id },
      );
    }
  } else {
    id = run(
      `INSERT INTO campaigns (client_id, name, steps, schedule, daily_limit, accounts, stop_on_reply, hold_after)
       VALUES (@clientId, @name, @steps, @schedule, @daily_limit, @accounts, @stop_on_reply, @hold_after)`,
      { ...fields, clientId },
    ).id;
    logActivity(clientId, "campaign", `Created campaign "${fields.name}"`);
  }

  const c = requireCampaign(id);
  if (c.managed) {
    await syncCampaignToInstantly(id);
  } else if (c.instantly_campaign_id) {
    const client = requireClient(clientId);
    await instantly(client.instantly_api_key!).patchCampaign(c.instantly_campaign_id, {
      daily_limit: c.daily_limit,
      email_list: c.accounts,
      campaign_schedule: toInstantlySchedule(c.schedule),
    });
    logActivity(clientId, "campaign", `Updated schedule and limits for "${c.name}"`);
  }

  revalidatePath("/", "layout");
  redirect(`/clients/${clientId}/campaigns/${id}`);
}

// ---------- Hold release ----------

export async function startRelease(campaignId: number, form: FormData) {
  prepareRelease(campaignId, Number(form.get("up_to")));
  after(runWriter);
  revalidatePath("/", "layout");
}

export async function finishRelease(campaignId: number): Promise<string> {
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
  cancelRelease(campaignId);
  revalidatePath("/", "layout");
}

export async function retryRelease(campaignId: number) {
  retryFailed(campaignId);
  after(runWriter);
  revalidatePath("/", "layout");
}
