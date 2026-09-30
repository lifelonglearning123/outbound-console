import "server-only";
import { get, run, logActivity } from "./db";
import { requireClient } from "./clients";
import { instantly, type CampaignSchedule } from "./instantly";
import { campaignState } from "./connection";
import { DEFAULT_TIMEZONE } from "./timezones";
import { htmlToText } from "./merge";

// mode "fixed" = the client wrote this email (subject/body with merge fields); otherwise the AI writes it from `instructions`.
export type Step = { delay_days: number; instructions: string; mode?: "ai" | "fixed"; subject?: string; body?: string };
export type Schedule = { days: number[]; from: string; to: string; timezone: string };

export type Campaign = {
  id: number;
  client_id: number;
  instantly_campaign_id: string | null;
  name: string;
  status: string;
  instantly_status: number | null;
  steps: Step[];
  schedule: Schedule;
  daily_limit: number;
  accounts: string[];
  stop_on_reply: number;
  managed: number;
  not_sending: string | null;
  hold_after: number | null;   // steps live in Instantly; later steps are on hold (null = no hold)
  release_to: number | null;   // while releasing a hold: how many steps will be live once applied
  ghl_tag: string | null;      // contacts with this GHL tag join the campaign automatically
  last_synced_at: string | null;
  created_at: string;
};

export const DEFAULT_STEPS: Step[] = [
  { delay_days: 3, instructions: "First touch. One specific observation about them, the problem we solve, one proof point, a soft question as the CTA. Under 90 words." },
  { delay_days: 4, instructions: "Short follow-up in the same thread. Add a different angle or proof point. Under 50 words." },
  { delay_days: 0, instructions: "Final polite break-up email. Offer to close the loop. Under 40 words." },
];

export const DEFAULT_SCHEDULE: Schedule = { days: [1, 2, 3, 4, 5], from: "08:30", to: "17:00", timezone: DEFAULT_TIMEZONE };

type CampaignDbRow = Omit<Campaign, "steps" | "schedule" | "accounts"> & { steps: string; schedule: string; accounts: string };

function parse(row: CampaignDbRow): Campaign {
  const j = <T,>(s: string, fallback: T): T => {
    try {
      return JSON.parse(s) ?? fallback;
    } catch {
      return fallback;
    }
  };
  return {
    ...row,
    steps: j(row.steps, []),
    schedule: { ...DEFAULT_SCHEDULE, ...j(row.schedule, {}) },
    accounts: j(row.accounts, []),
  };
}

export async function getCampaign(id: number): Promise<Campaign | undefined> {
  const row = await get<CampaignDbRow>("SELECT * FROM campaigns WHERE id = ?", id);
  return row ? parse(row) : undefined;
}

export async function requireCampaign(id: number): Promise<Campaign> {
  const c = await getCampaign(id);
  if (!c) throw new Error(`Campaign ${id} not found`);
  return c;
}

/** Custom-variable names the approved copy is delivered through. Follow-ups reuse the thread, so only step 1 has a subject. */
export const subjectVar = (step: number) => `subject_${step}`;
export const bodyVar = (step: number) => `body_${step}`;

export function toInstantlySchedule(s: Schedule): CampaignSchedule {
  const days = Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, s.days.includes(Number(d))]));
  return {
    schedules: [
      { name: "Outbound Console", timing: { from: s.from, to: s.to }, days: days as CampaignSchedule["schedules"][0]["days"], timezone: s.timezone },
    ],
  };
}

/** Steps currently live in Instantly. Steps after a hold are kept here until the hold is released. */
export const liveSteps = (c: Pick<Campaign, "steps" | "hold_after">) => Math.min(c.hold_after ?? c.steps.length, c.steps.length);

/** Steps each lead needs approved copy for right now (includes a release in progress). */
export const writeTarget = (c: Pick<Campaign, "steps" | "hold_after" | "release_to">) =>
  Math.min(c.release_to ?? liveSteps(c), c.steps.length);

function toInstantlyBody(c: Campaign, live = liveSteps(c)) {
  return {
    name: c.name,
    campaign_schedule: toInstantlySchedule(c.schedule),
    sequences: [
      {
        steps: c.steps.slice(0, live).map((s, i) => ({
          type: "email",
          delay: s.delay_days,
          delay_unit: "days",
          variants: [{ subject: i === 0 ? `{{${subjectVar(1)}}}` : "", body: `{{${bodyVar(i + 1)}}}` }],
        })),
      },
    ],
    email_list: c.accounts,
    daily_limit: c.daily_limit,
    stop_on_reply: c.stop_on_reply === 1,
    stop_on_auto_reply: false,
    link_tracking: false,
    open_tracking: true,
    text_only: false,
    insert_unsubscribe_header: true,
  };
}

/** Create the campaign in Instantly (first time) or push local changes to it. Managed campaigns only. */
export async function syncCampaignToInstantly(id: number) {
  const c = await requireCampaign(id);
  if (!c.managed) throw new Error("This campaign was created in Instantly directly; edit its copy there.");
  const client = await requireClient(c.client_id);
  if (!client.instantly_api_key) throw new Error("Client has no Instantly key");
  const api = instantly(client.instantly_api_key);
  const body = toInstantlyBody(c);

  const remote = c.instantly_campaign_id
    ? await api.patchCampaign(c.instantly_campaign_id, body)
    : await api.createCampaign(body);
  // Remember the id straight away so a later failure can't lead to a duplicate campaign on retry.
  if (!c.instantly_campaign_id) await run("UPDATE campaigns SET instantly_campaign_id = ? WHERE id = ?", remote.id, id);

  // Shared workspace: tag the campaign so it belongs to this client. Re-applied on every save, so a failed
  // attempt is repaired by saving again.
  if (client.instantly_tag_id) await api.tagResources(client.instantly_tag_id, 2, [remote.id]);

  const vars = c.steps.slice(0, liveSteps(c)).flatMap((_, i) => (i === 0 ? [subjectVar(1), bodyVar(1)] : [bodyVar(i + 1)]));
  await api.addVariables(remote.id, vars);

  await run(
    "UPDATE campaigns SET instantly_campaign_id = ?, instantly_status = ?, status = ?, last_synced_at = ? WHERE id = ?",
    remote.id, remote.status, campaignState(remote.status), new Date().toISOString(), id,
  );
  await logActivity(c.client_id, "campaign", `${c.instantly_campaign_id ? "Updated" : "Created"} "${c.name}" in Instantly`);
  return remote;
}

export async function setCampaignRunning(id: number, running: boolean) {
  const c = await requireCampaign(id);
  if (!c.instantly_campaign_id) throw new Error("Campaign isn't in Instantly yet");
  const client = await requireClient(c.client_id);
  const api = instantly(client.instantly_api_key!);
  const remote = running ? await api.activate(c.instantly_campaign_id) : await api.pause(c.instantly_campaign_id);
  await run(
    "UPDATE campaigns SET instantly_status = ?, status = ?, last_synced_at = ? WHERE id = ?",
    remote.status, campaignState(remote.status), new Date().toISOString(), id,
  );
  await logActivity(c.client_id, running ? "resume" : "pause", `${running ? "Started" : "Paused"} "${c.name}"`);
}

/** What's still missing from steps before they can be written or sent (held steps may be unfinished until released). */
export function campaignStepProblems(steps: Step[]): string[] {
  const problems: string[] = [];
  steps.forEach((s, i) => {
    const n = i + 1;
    if (s.mode === "fixed") {
      if (!htmlToText(s.body ?? "")) problems.push(`step ${n} has no email yet`);
      if (n === 1 && !s.subject?.trim()) problems.push("step 1 needs a subject line");
    } else if (!s.instructions.trim()) {
      problems.push(`step ${n} has no instructions for the AI`);
    }
  });
  return problems;
}

/** Leads already in Instantly for this campaign; once there are any, the live steps can only grow via a hold release. */
export async function pushedLeadCount(campaignId: number): Promise<number> {
  return (await get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND instantly_lead_id IS NOT NULL", campaignId))?.n ?? 0;
}
