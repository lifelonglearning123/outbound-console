import "server-only";
import { all, run } from "./db";
import type { Client } from "./clients";
import type { InstantlyClient } from "./instantly";

// Shared-workspace mode: several clients use one Instantly workspace, and each owns only the
// mailboxes and campaigns carrying its Instantly tag. Blocklist and lead dedupe stay workspace-wide.

/** Why this client can't sync safely right now, or null. Every client sharing a workspace needs its own tag. */
export function sharingProblem(client: Client): string | null {
  if (!client.instantly_workspace_id) return null;
  const others = all<{ name: string; instantly_tag_id: string | null; instantly_tag_label: string | null }>(
    "SELECT name, instantly_tag_id, instantly_tag_label FROM clients WHERE instantly_workspace_id = ? AND id != ? AND archived = 0",
    client.instantly_workspace_id,
    client.id,
  );
  if (others.length === 0) return null;
  const names = others.map((o) => o.name).join(", ");
  const untagged = [client, ...others].filter((c) => !c.instantly_tag_label).map((c) => c.name);
  if (untagged.length) {
    return `This Instantly workspace is shared with ${names}. Give every client sharing it a tag in Settings (missing: ${untagged.join(", ")}) so their mailboxes and campaigns stay apart.`;
  }
  const clash = others.find((o) => o.instantly_tag_label?.toLowerCase() === client.instantly_tag_label?.toLowerCase());
  if (clash) return `${clash.name} uses the same tag "${client.instantly_tag_label}". Each client needs its own tag.`;
  return null;
}

/** Resolve the client's tag label to an Instantly tag id, creating the tag if it doesn't exist yet. */
export async function ensureTag(api: InstantlyClient, client: Client): Promise<string | null> {
  const label = client.instantly_tag_label?.trim();
  if (!label) return null;
  if (client.instantly_tag_id) return client.instantly_tag_id;
  const existing = (await api.tags()).find((t) => t.label.trim().toLowerCase() === label.toLowerCase());
  const tag = existing ?? (await api.createTag(label));
  run("UPDATE clients SET instantly_tag_id = ? WHERE id = ?", tag.id, client.id);
  client.instantly_tag_id = tag.id;
  return tag.id;
}

/** In shared mode, the client's own mailboxes: used to filter emails, since Instantly can't filter emails by tag. */
export function scopedMailboxes(client: Client): string[] | undefined {
  if (!client.instantly_tag_id) return undefined;
  return all<{ email: string }>("SELECT email FROM mailboxes WHERE client_id = ?", client.id).map((m) => m.email);
}
