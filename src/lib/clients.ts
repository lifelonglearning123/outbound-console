import "server-only";
import { all, get } from "./db";

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
  return { ...row, brief };
}

export function listClients(includeArchived = false): Client[] {
  return all<ClientRow>(
    `SELECT * FROM clients ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY name COLLATE NOCASE`,
  ).map(parse);
}

export function getClient(id: number): Client | undefined {
  const row = get<ClientRow>("SELECT * FROM clients WHERE id = ?", id);
  return row ? parse(row) : undefined;
}

export function requireClient(id: number): Client {
  const c = getClient(id);
  if (!c) throw new Error(`Client ${id} not found`);
  return c;
}

/** Last 4 characters only, for showing that a secret is set. */
export function mask(secret: string | null | undefined): string {
  if (!secret) return "";
  return `••••${secret.slice(-4)}`;
}
