"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { all, run, logActivity } from "@/lib/db";
import { requireClient, type Brief } from "@/lib/clients";
import { checkConnection } from "@/lib/connection";

const BRIEF_KEYS: (keyof Brief)[] = ["offer", "icp", "tone", "proof", "cta", "sender_name", "signature", "avoid"];

function text(form: FormData, key: string): string | null {
  const v = String(form.get(key) ?? "").trim();
  return v === "" ? null : v;
}

export async function saveClient(form: FormData) {
  const id = Number(form.get("id") || 0);
  const name = text(form, "name");
  if (!name) throw new Error("Client name is required");

  const brief: Brief = {};
  for (const k of BRIEF_KEYS) {
    const v = text(form, `brief_${k}`);
    if (v) brief[k] = v;
  }

  // Secret fields left blank on edit keep their stored value.
  const apiKey = text(form, "instantly_api_key");
  const tagLabel = text(form, "instantly_tag_label");
  const ghlToken = text(form, "ghl_token");
  // The stage picker posts "pipelineId:stageId".
  const [pipelineId, stageId] = (text(form, "ghl_stage") ?? "").split(":");
  const fields = {
    name,
    ghl_location_id: text(form, "ghl_location_id"),
    ghl_pipeline_id: pipelineId || null,
    ghl_stage_id: stageId || null,
    // Only sent when GHL is connected; otherwise keep what's stored.
    meetingsSent: form.has("meeting_stage") ? 1 : 0,
    ghl_meeting_calendars: JSON.stringify(form.getAll("meeting_calendars").map(String)),
    ghl_meeting_stage: text(form, "meeting_stage"),
    brief: JSON.stringify(brief),
  };

  let clientId = id;
  if (id) {
    const existing = requireClient(id);
    run(
      `UPDATE clients SET name = @name, ghl_location_id = @ghl_location_id, ghl_pipeline_id = @ghl_pipeline_id,
         ghl_stage_id = @ghl_stage_id, brief = @brief, instantly_api_key = @key, ghl_token = @token,
         ghl_meeting_calendars = CASE WHEN @meetingsSent = 1 THEN @ghl_meeting_calendars ELSE ghl_meeting_calendars END,
         ghl_meeting_stage = CASE WHEN @meetingsSent = 1 THEN @ghl_meeting_stage ELSE ghl_meeting_stage END,
         key_status = CASE WHEN @keyChanged = 1 THEN NULL ELSE key_status END,
         instantly_tag_id = CASE WHEN @tagChanged = 1 OR @keyChanged = 1 THEN NULL ELSE instantly_tag_id END,
         instantly_tag_label = @tagLabel
       WHERE id = @id`,
      {
        ...fields,
        id,
        tagLabel,
        tagChanged: (tagLabel ?? "") !== (existing.instantly_tag_label ?? "") ? 1 : 0,
        key: apiKey ?? existing.instantly_api_key,
        token: ghlToken ?? existing.ghl_token,
        keyChanged: apiKey && apiKey !== existing.instantly_api_key ? 1 : 0,
      },
    );
    logActivity(id, "client", `Updated client settings`);
  } else {
    clientId = run(
      `INSERT INTO clients (name, ghl_location_id, ghl_pipeline_id, ghl_stage_id, brief, instantly_api_key, ghl_token, instantly_tag_label)
       VALUES (@name, @ghl_location_id, @ghl_pipeline_id, @ghl_stage_id, @brief, @key, @token, @tagLabel)`,
      { ...fields, key: apiKey, token: ghlToken, tagLabel },
    ).id;
    logActivity(clientId, "client", `Added client ${name}`);
  }

  if (requireClient(clientId).instantly_api_key) await recheckWorkspace(clientId);
  revalidatePath("/", "layout");
  redirect(`/clients/${clientId}`);
}

/** Check this client, then every other client sharing its Instantly workspace, since a tag change affects them all. */
async function recheckWorkspace(clientId: number) {
  await checkConnection(clientId);
  const ws = requireClient(clientId).instantly_workspace_id;
  if (!ws) return;
  const others = all<{ id: number }>("SELECT id FROM clients WHERE instantly_workspace_id = ? AND id != ? AND archived = 0", ws, clientId);
  for (const o of others) await checkConnection(o.id);
}

export async function recheckConnection(clientId: number) {
  await recheckWorkspace(clientId);
  revalidatePath("/", "layout");
}

export async function archiveClient(clientId: number) {
  run("UPDATE clients SET archived = 1 WHERE id = ?", clientId);
  logActivity(clientId, "client", "Archived client");
  revalidatePath("/", "layout");
  redirect("/");
}
