"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { run, logActivity } from "@/lib/db";
import { requireCampaign, setCampaignRunning, syncCampaignToInstantly, toInstantlySchedule, type Step } from "@/lib/campaigns";
import { INSTANTLY_TIMEZONES } from "@/lib/timezones";
import { requireClient } from "@/lib/clients";
import { instantly } from "@/lib/instantly";

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
    const instructions = String(form.get(`step_${i}_instructions`) ?? "").trim();
    if (!instructions) continue;
    steps.push({ delay_days: Math.max(0, Number(form.get(`step_${i}_delay`) ?? 0)), instructions });
  }
  if (steps.length === 0) throw new Error("Add at least one step");

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
  };
}

export async function saveCampaign(clientId: number, campaignId: number | null, form: FormData) {
  const fields = readForm(form);
  let id = campaignId;
  if (id) {
    const existing = requireCampaign(id);
    if (!existing.managed) {
      // External campaigns: only the controls we can safely change from here.
      run("UPDATE campaigns SET daily_limit = @daily_limit, accounts = @accounts, schedule = @schedule WHERE id = @id", { ...fields, id });
    } else {
      run(
        `UPDATE campaigns SET name = @name, steps = @steps, schedule = @schedule, daily_limit = @daily_limit,
           accounts = @accounts, stop_on_reply = @stop_on_reply WHERE id = @id`,
        { ...fields, id },
      );
    }
  } else {
    id = run(
      `INSERT INTO campaigns (client_id, name, steps, schedule, daily_limit, accounts, stop_on_reply)
       VALUES (@clientId, @name, @steps, @schedule, @daily_limit, @accounts, @stop_on_reply)`,
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
