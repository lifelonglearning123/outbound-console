import "server-only";
import { all, get } from "./db";
import { decrypt } from "./secrets";

export type Brief = {
  offer?: string;
  icp?: string;
  tone?: string;
  proof?: string;
  cta?: string;
  sender_name?: string;
  signature?: string;
  avoid?: string;
};

export type Client = {
  id: number;
  name: string;
  instantly_api_key: string | null;
  instantly_workspace_id: string | null;
  instantly_workspace_name: string | null;
  instantly_tag_id: string | null;
  instantly_tag_label: string | null;
  key_status: "ok" | "error" | null;
  key_message: string | null;
  key_checked_at: string | null;
  ghl_location_id: string | null;
  ghl_token: string | null;
  ghl_pipeline_id: string | null;
  ghl_stage_id: string | null;
  ghl_meeting_calendars: string | null; // JSON array of calendar ids; empty = every calendar
  ghl_meeting_stage: string | null;     // "pipelineId:stageId" that counts as a booked meeting
  ghl_log_since: string | null;         // emails from this time on are copied into Nexus Portal conversations
  brief: Brief;
  archived: number;
  created_at: string;
};

type ClientRow = Omit<Client, "brief"> & { brief: string };

function parse(row: ClientRow): Client {
  let brief: Brief = {};
  try {
    brief = JSON.parse(row.brief || "{}");
  } catch {}
  // Keys are stored encrypted; the rest of the app works with the plain values.
  return { ...row, brief, instantly_api_key: decrypt(row.instantly_api_key), ghl_token: decrypt(row.ghl_token) };
}

export async function listClients(includeArchived = false): Promise<Client[]> {
  return (
    await all<ClientRow>(`SELECT * FROM clients ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY lower(name)`)
  ).map(parse);
}

export async function getClient(id: number): Promise<Client | undefined> {
  const row = await get<ClientRow>("SELECT * FROM clients WHERE id = ?", id);
  return row ? parse(row) : undefined;
}

export async function requireClient(id: number): Promise<Client> {
  const c = await getClient(id);
  if (!c) throw new Error(`Client ${id} not found`);
  return c;
}

/** Last 4 characters only, for showing that a secret is set. */
export function mask(secret: string | null | undefined): string {
  if (!secret) return "";
  return `••••${secret.slice(-4)}`;
}
