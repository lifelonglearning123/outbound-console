import "server-only";
import { all, get, run, tx } from "./db";
import type { Client } from "./clients";
import { calendarEvents, contactEmail, listCalendars, opportunitiesInStage, type GhlCreds } from "./ghl";

// A "meeting booked" is a lead from these campaigns who (a) books on one of the client's GHL calendars
// after we first emailed them, or (b) has an opportunity in the client's chosen "meeting" stage.

async function leadIdFor(clientId: number, email: string | null): Promise<{ id: number; pushed_at: string | null } | undefined> {
  if (!email) return undefined;
  return await get<{ id: number; pushed_at: string | null }>(
    "SELECT id, pushed_at FROM leads WHERE client_id = ? AND email = ? AND instantly_lead_id IS NOT NULL",
    clientId, email.toLowerCase(),
  );
}

async function emailForContact(clientId: number, creds: GhlCreds, contactId: string): Promise<string | null> {
  const cached = await get<{ email: string | null }>("SELECT email FROM ghl_contacts WHERE client_id = ? AND contact_id = ?", clientId, contactId);
  if (cached) return cached.email;
  const email = await contactEmail(creds, contactId).catch(() => null);
  await run("INSERT INTO ghl_contacts (client_id, contact_id, email) VALUES (?, ?, ?) ON CONFLICT (client_id, contact_id) DO UPDATE SET email = EXCLUDED.email", clientId, contactId, email);
  return email;
}

/** Pull bookings and meeting-stage opportunities from the client's GHL and match them to leads. */
export async function syncMeetings(client: Client): Promise<number> {
  if (!client.ghl_location_id || !client.ghl_token) return 0;
  // Nothing to match until leads have been sent.
  const anyLead = (await get<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE client_id = ? AND instantly_lead_id IS NOT NULL", client.id))?.n ?? 0;
  if (!anyLead) return 0;
  const creds = { locationId: client.ghl_location_id, token: client.ghl_token };
  const found: { id: string; lead_id: number; source: string; booked_at: string; starts_at: string | null; title: string | null; status: string | null }[] = [];

  // (a) Calendar bookings, from 120 days back to 60 days ahead.
  let calendarIds: string[] = [];
  try {
    calendarIds = JSON.parse(client.ghl_meeting_calendars || "[]");
  } catch {}
  if (calendarIds.length === 0) calendarIds = (await listCalendars(creds)).map((c) => c.id);
  const from = Date.now() - 120 * 86400_000;
  const to = Date.now() + 60 * 86400_000;
  for (const calId of calendarIds) {
    for (const ev of await calendarEvents(creds, calId, from, to)) {
      if (ev.deleted || !ev.contactId) continue;
      if (["cancelled", "invalid"].includes(ev.appointmentStatus ?? "")) continue;
      const lead = await leadIdFor(client.id, await emailForContact(client.id, creds, ev.contactId));
      const bookedAt = ev.dateAdded ?? ev.startTime;
      // Only bookings made after we first emailed the lead count as coming from outbound.
      if (!lead || (lead.pushed_at && bookedAt < lead.pushed_at)) continue;
      found.push({ id: `cal:${ev.id}`, lead_id: lead.id, source: "calendar", booked_at: bookedAt, starts_at: ev.startTime, title: ev.title ?? null, status: ev.appointmentStatus ?? null });
    }
  }

  // (b) Opportunities in the client's "meeting booked" stage.
  const [pipelineId, stageId] = (client.ghl_meeting_stage ?? "").split(":");
  if (pipelineId && stageId) {
    for (const o of await opportunitiesInStage(creds, pipelineId, stageId)) {
      const email = o.contact?.email ?? (await emailForContact(client.id, creds, o.contactId));
      const lead = await leadIdFor(client.id, email ?? null);
      if (!lead) continue;
      found.push({ id: `opp:${o.id}`, lead_id: lead.id, source: "pipeline", booked_at: o.lastStageChangeAt ?? o.createdAt, starts_at: null, title: o.name, status: o.status });
    }
  }

  await tx(async () => {
    // Replace this client's meetings with what GHL says now (cancellations and stage moves drop out).
    await run("DELETE FROM meetings WHERE client_id = ?", client.id);
    for (const m of found) {
      await run(
        `INSERT INTO meetings (id, client_id, lead_id, source, booked_at, starts_at, title, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET lead_id = EXCLUDED.lead_id, booked_at = EXCLUDED.booked_at, starts_at = EXCLUDED.starts_at,
           title = EXCLUDED.title, status = EXCLUDED.status`,
        m.id, client.id, m.lead_id, m.source, m.booked_at, m.starts_at, m.title, m.status,
      );
    }
  });
  return found.length;
}

export async function meetingsFor(clientId: number) {
  return await all<{ id: string; lead_id: number; source: string; booked_at: string; starts_at: string | null }>(
    "SELECT id, lead_id, source, booked_at, starts_at FROM meetings WHERE client_id = ?",
    clientId,
  );
}
