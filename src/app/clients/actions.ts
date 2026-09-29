"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { run, logActivity } from "@/lib/db";
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
  const ghlToken = text(form, "ghl_token");
  // The stage picker posts "pipelineId:stageId".
  const [pipelineId, stageId] = (text(form, "ghl_stage") ?? "").split(":");
  const fields = {
    name,
    ghl_location_id: text(form, "ghl_location_id"),
    ghl_pipeline_id: pipelineId || null,
    ghl_stage_id: stageId || null,
    brief: JSON.stringify(brief),
  };

  let clientId = id;
  if (id) {
    const existing = requireClient(id);
    run(
      `UPDATE clients SET name = @name, ghl_location_id = @ghl_location_id, ghl_pipeline_id = @ghl_pipeline_id,
         ghl_stage_id = @ghl_stage_id, brief = @brief, instantly_api_key = @key, ghl_token = @token,
         key_status = CASE WHEN @keyChanged = 1 THEN NULL ELSE key_status END
       WHERE id = @id`,
      {
        ...fields,
        id,
        key: apiKey ?? existing.instantly_api_key,
        token: ghlToken ?? existing.ghl_token,
        keyChanged: apiKey && apiKey !== existing.instantly_api_key ? 1 : 0,
      },
    );
    logActivity(id, "client", `Updated client settings`);
  } else {
    clientId = run(
      `INSERT INTO clients (name, ghl_location_id, ghl_pipeline_id, ghl_stage_id, brief, instantly_api_key, ghl_token)
       VALUES (@name, @ghl_location_id, @ghl_pipeline_id, @ghl_stage_id, @brief, @key, @token)`,
      { ...fields, key: apiKey, token: ghlToken },
    ).id;
    logActivity(clientId, "client", `Added client ${name}`);
  }

  if (apiKey) await checkConnection(clientId);
  revalidatePath("/", "layout");
  redirect(`/clients/${clientId}`);
}

export async function recheckConnection(clientId: number) {
  await checkConnection(clientId);
  revalidatePath("/", "layout");
}

export async function archiveClient(clientId: number) {
  run("UPDATE clients SET archived = 1 WHERE id = ?", clientId);
  logActivity(clientId, "client", "Archived client");
  revalidatePath("/", "layout");
  redirect("/");
}
