import "server-only";

const BASE = "https://services.leadconnectorhq.com";

export type GhlCreds = { locationId: string; token: string };

export class GhlError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function ghl<T>(creds: GhlCreds, path: string, init: RequestInit = {}, attempt = 1): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Version: "2021-07-28",
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
  c: { email: string; firstName?: string | null; lastName?: string | null; companyName?: string | null; phone?: string | null; tags?: string[] },
): Promise<string> {
  const body: Record<string, unknown> = { locationId: creds.locationId, email: c.email };
  if (c.firstName) body.firstName = c.firstName;
  if (c.lastName) body.lastName = c.lastName;
  if (c.companyName) body.companyName = c.companyName;
  if (c.phone) body.phone = c.phone;
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
