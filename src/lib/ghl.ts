import "server-only";

const BASE = "https://services.leadconnectorhq.com";

export type GhlCreds = { locationId: string; token: string };

export class GhlError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function ghl<T>(creds: GhlCreds, path: string, init: RequestInit & { version?: string } = {}, attempt = 1): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Version: init.version ?? "2021-07-28", // calendars use 2021-04-15
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "OutboundConsole/1.0",
      ...init.headers,
    },
    cache: "no-store",
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return ghl(creds, path, init, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = Array.isArray(j.message) ? j.message.join("; ") : j.message ?? msg;
    } catch {}
    throw new GhlError(`GHL ${res.status}: ${msg}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type GhlPipeline = { id: string; name: string; stages: { id: string; name: string }[] };

export async function listPipelines(creds: GhlCreds): Promise<GhlPipeline[]> {
  const r = await ghl<{ pipelines: GhlPipeline[] }>(
    creds,
    `/opportunities/pipelines?locationId=${encodeURIComponent(creds.locationId)}`,
  );
  return r.pipelines ?? [];
}

export async function listTags(creds: GhlCreds): Promise<string[]> {
  const r = await ghl<{ tags: { name: string }[] }>(creds, `/locations/${creds.locationId}/tags`);
  return (r.tags ?? []).map((t) => t.name).sort((a, b) => a.localeCompare(b));
}

export type GhlContact = {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  firstNameRaw?: string;
  lastNameRaw?: string;
  companyName?: string;
  phone?: string;
  website?: string;
  tags?: string[];
  customFields?: { id: string; value: unknown }[];
  [k: string]: unknown;
};

/** Every contact carrying `tag`, following pagination. */
export async function contactsWithTag(creds: GhlCreds, tag: string, max = 5000): Promise<GhlContact[]> {
  const out: GhlContact[] = [];
  let page = 1;
  while (out.length < max) {
    const r = await ghl<{ contacts: GhlContact[]; total: number }>(creds, "/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        locationId: creds.locationId,
        page,
        pageLimit: 100,
        filters: [{ field: "tags", operator: "contains", value: tag }],
      }),
    });
    const batch = r.contacts ?? [];
    out.push(...batch);
    if (batch.length < 100 || out.length >= (r.total ?? 0)) break;
    page += 1;
  }
  return out.slice(0, max);
}

export async function upsertContact(
  creds: GhlCreds,
  c: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
    phone?: string | null;
    website?: string | null;
    tags?: string[];
  },
): Promise<string> {
  const body: Record<string, unknown> = { locationId: creds.locationId, email: c.email };
  if (c.firstName) body.firstName = c.firstName;
  if (c.lastName) body.lastName = c.lastName;
  if (c.companyName) body.companyName = c.companyName;
  if (c.phone) body.phone = c.phone;
  if (c.website) body.website = c.website;
  if (c.tags?.length) body.tags = c.tags;
  const r = await ghl<{ contact: { id: string } }>(creds, "/contacts/upsert", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return r.contact.id;
}

export async function createOpportunity(
  creds: GhlCreds,
  o: { contactId: string; pipelineId: string; stageId: string; name: string },
): Promise<string> {
  const r = await ghl<{ opportunity: { id: string } }>(creds, "/opportunities/", {
    method: "POST",
    body: JSON.stringify({
      locationId: creds.locationId,
      contactId: o.contactId,
      pipelineId: o.pipelineId,
      pipelineStageId: o.stageId,
      name: o.name,
      status: "open",
    }),
  });
  return r.opportunity.id;
}

export async function addNote(creds: GhlCreds, contactId: string, body: string) {
  await ghl(creds, `/contacts/${contactId}/notes`, { method: "POST", body: JSON.stringify({ body }) });
}

// ---------- Meetings (for the stats dashboard) ----------

export type GhlCalendar = { id: string; name: string };

export async function listCalendars(creds: GhlCreds): Promise<GhlCalendar[]> {
  const r = await ghl<{ calendars: GhlCalendar[] }>(creds, `/calendars/?locationId=${creds.locationId}`, { version: "2021-04-15" });
  return (r.calendars ?? []).map((c) => ({ id: c.id, name: c.name }));
}

export type GhlEvent = {
  id: string;
  calendarId: string;
  contactId?: string;
  title?: string;
  startTime: string;
  dateAdded?: string;
  appointmentStatus?: string;
  deleted?: boolean;
};

/** Bookings on one calendar between two times (ms since epoch). */
export async function calendarEvents(creds: GhlCreds, calendarId: string, from: number, to: number): Promise<GhlEvent[]> {
  const r = await ghl<{ events: GhlEvent[] }>(
    creds,
    `/calendars/events?locationId=${creds.locationId}&calendarId=${calendarId}&startTime=${from}&endTime=${to}`,
    { version: "2021-04-15" },
  );
  return r.events ?? [];
}

export async function contactEmail(creds: GhlCreds, contactId: string): Promise<string | null> {
  const r = await ghl<{ contact: { email?: string } }>(creds, `/contacts/${contactId}`);
  return r.contact?.email?.toLowerCase() ?? null;
}

export type GhlOpportunity = {
  id: string;
  name: string;
  status: string;
  contactId: string;
  contact?: { email?: string };
  lastStageChangeAt?: string;
  createdAt: string;
};

/** Every opportunity currently in one pipeline stage. */
export async function opportunitiesInStage(creds: GhlCreds, pipelineId: string, stageId: string): Promise<GhlOpportunity[]> {
  const out: GhlOpportunity[] = [];
  let after = "";
  for (let page = 0; page < 50; page++) {
    const r = await ghl<{ opportunities: GhlOpportunity[]; meta?: { startAfter?: number; startAfterId?: string; nextPage?: number | null } }>(
      creds,
      `/opportunities/search?location_id=${creds.locationId}&pipeline_id=${pipelineId}&pipeline_stage_id=${stageId}&limit=100${after}`,
    );
    out.push(...(r.opportunities ?? []));
    if (!r.meta?.nextPage || !r.meta.startAfterId) break;
    after = `&startAfter=${r.meta.startAfter}&startAfterId=${r.meta.startAfterId}`;
  }
  return out;
}

// ---------- GHL as the source of truth for contacts ----------

export type GhlContactFull = GhlContact & {
  dnd?: boolean;
  dndSettings?: { Email?: { status?: string } };
};

export async function getContact(creds: GhlCreds, contactId: string): Promise<GhlContactFull | null> {
  try {
    const r = await ghl<{ contact: GhlContactFull }>(creds, `/contacts/${contactId}`);
    return r.contact ?? null;
  } catch (e) {
    if (e instanceof GhlError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

/** True when the contact has asked not to be emailed (GHL's global or email DND). */
export const emailDnd = (c: GhlContactFull) => c.dnd === true || c.dndSettings?.Email?.status === "active" || c.dndSettings?.Email?.status === "permanent";

/**
 * Record an email in the contact's GHL conversation without sending anything. Works with a private
 * integration token (no conversation provider needed), for both directions.
 */
export async function logEmail(
  creds: GhlCreds,
  m: { contactId: string; direction: "inbound" | "outbound"; subject: string; html: string; text: string; from: string; to: string; date: string },
): Promise<string> {
  const r = await ghl<{ messageId: string }>(creds, "/conversations/messages/inbound", {
    method: "POST",
    version: "2021-04-15",
    body: JSON.stringify({
      type: "Email",
      contactId: m.contactId,
      direction: m.direction,
      subject: m.subject,
      html: m.html,
      message: m.text,
      emailFrom: m.from,
      emailTo: m.to,
      date: m.date,
    }),
  });
  return r.messageId;
}

/** Turn on email Do-Not-Disturb, so no GHL automation emails this contact either. */
/** Add tags to a contact (existing tags are kept). */
export async function addContactTags(creds: GhlCreds, contactId: string, tags: string[]) {
  await ghl(creds, `/contacts/${contactId}/tags`, { method: "POST", body: JSON.stringify({ tags }) });
}

/** Delete a contact from the location. Irreversible. */
export async function deleteContact(creds: GhlCreds, contactId: string) {
  await ghl(creds, `/contacts/${contactId}`, { method: "DELETE" });
}

export async function setEmailDnd(creds: GhlCreds, contactId: string, reason: string) {
  await ghl(creds, `/contacts/${contactId}`, {
    method: "PUT",
    body: JSON.stringify({ dndSettings: { Email: { status: "active", message: reason, code: "" } } }),
  });
}
