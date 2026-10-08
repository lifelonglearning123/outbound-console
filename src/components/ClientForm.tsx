import { saveClient } from "@/app/clients/actions";
import { mask, type Client } from "@/lib/clients";
import { listCalendars, listPipelines, type GhlCalendar, type GhlPipeline } from "@/lib/ghl";
import { instantly } from "@/lib/instantly";
import { all } from "@/lib/db";

const BRIEF_FIELDS = [
  { key: "offer", label: "Offer", hint: "What the client sells and the one outcome it delivers.", rows: 3 },
  { key: "icp", label: "Who we email (ICP)", hint: "Industry, size, job titles, geography.", rows: 2 },
  { key: "proof", label: "Proof points", hint: "Results, clients, numbers the AI may quote. It will never invent others.", rows: 3 },
  { key: "cta", label: "Call to action", hint: "e.g. 'Worth a 15-minute call next week?'", rows: 1 },
  { key: "tone", label: "Tone", hint: "e.g. plain British English, peer-to-peer, no hype.", rows: 1 },
  { key: "avoid", label: "Never say", hint: "Words, claims or topics to avoid.", rows: 2 },
  { key: "sender_name", label: "Sender first name", hint: "Used to sign off.", rows: 1 },
  { key: "signature", label: "Signature", hint: "Appended under the sign-off.", rows: 2 },
] as const;

export async function ClientForm({ client }: { client?: Client }) {
  let pipelines: GhlPipeline[] = [];
  let pipelineError = "";
  if (client?.ghl_location_id && client.ghl_token) {
    try {
      pipelines = await listPipelines({ locationId: client.ghl_location_id, token: client.ghl_token });
    } catch (e) {
      pipelineError = (e as Error).message;
    }
  }
  // Tags that already exist in the workspace, offered as suggestions.
  let tags: string[] = [];
  if (client?.instantly_api_key && client.instantly_workspace_id) {
    try {
      tags = (await instantly(client.instantly_api_key).tags()).map((t) => t.label);
    } catch {}
  }
  const sharedWith = client?.instantly_workspace_id
    ? await all<{ name: string; instantly_tag_label: string | null }>(
        "SELECT name, instantly_tag_label FROM clients WHERE instantly_workspace_id = ? AND id != ? AND archived = 0",
        client.instantly_workspace_id, client.id,
      )
    : [];
  let calendars: GhlCalendar[] = [];
  if (client?.ghl_location_id && client.ghl_token) {
    try {
      calendars = await listCalendars({ locationId: client.ghl_location_id, token: client.ghl_token });
    } catch {}
  }
  let meetingCalendars: string[] = [];
  try {
    meetingCalendars = JSON.parse(client?.ghl_meeting_calendars || "[]");
  } catch {}
  const currentStage = client?.ghl_pipeline_id ? `${client.ghl_pipeline_id}:${client.ghl_stage_id ?? ""}` : "";

  return (
    <form action={saveClient} className="flex max-w-3xl flex-col gap-6">
      {client && <input type="hidden" name="id" value={client.id} />}

      <section className="card flex flex-col gap-4 p-5">
        <h2 className="font-semibold">Client</h2>
        <div>
          <label className="label" htmlFor="name">Name</label>
          <input id="name" name="name" required defaultValue={client?.name} className="field" placeholder="Fruitful" />
        </div>
        <div>
          <label className="label" htmlFor="instantly_api_key">Instantly API v2 key</label>
          <input
            id="instantly_api_key"
            name="instantly_api_key"
            type="password"
            autoComplete="off"
            className="field font-mono"
            placeholder={client?.instantly_api_key ? `${mask(client.instantly_api_key)} — leave blank to keep` : "Paste the key from Instantly → Settings → Integrations → API"}
          />
          <p className="mt-1 text-xs text-muted">
            Create it with the <span className="font-mono">all:all</span> scope. Saving checks it straight away.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="instantly_tag_label">Instantly tag (shared workspace)</label>
          <input
            id="instantly_tag_label"
            name="instantly_tag_label"
            list="instantly-tags"
            defaultValue={client?.instantly_tag_label ?? ""}
            className="field"
            placeholder="Leave blank if this client has its own workspace"
          />
          <datalist id="instantly-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
          <p className="mt-1 text-xs text-muted">
            When several clients share one Instantly workspace, each gets a tag. This client then only sees mailboxes and campaigns
            carrying that tag, and campaigns created here get it automatically. In Instantly, tag this client&apos;s mailboxes (and any
            existing campaigns) with the same tag. The tag is created in Instantly if it doesn&apos;t exist. The blocklist is still shared.
          </p>
          {sharedWith.length > 0 && (
            <p className="mt-1 text-xs text-wait">
              This workspace is shared with {sharedWith.map((s) => `${s.name} (${s.instantly_tag_label ? `tag "${s.instantly_tag_label}"` : "no tag yet"})`).join(", ")}.
            </p>
          )}
        </div>
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <div>
          <h2 className="font-semibold">GoHighLevel</h2>
          <p className="text-sm text-muted">Where leads can be pulled from and where interested replies are sent.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="ghl_location_id">Location (sub-account) ID</label>
            <input id="ghl_location_id" name="ghl_location_id" defaultValue={client?.ghl_location_id ?? ""} className="field font-mono" />
          </div>
          <div>
            <label className="label" htmlFor="ghl_token">Private integration token</label>
            <input
              id="ghl_token"
              name="ghl_token"
              type="password"
              autoComplete="off"
              className="field font-mono"
              placeholder={client?.ghl_token ? `${mask(client.ghl_token)} — leave blank to keep` : "pit-…"}
            />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="ghl_stage">Interested replies go to</label>
          {pipelines.length > 0 ? (
            <select id="ghl_stage" name="ghl_stage" defaultValue={currentStage} className="field">
              <option value="">Contact + note only (no opportunity)</option>
              {pipelines.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {p.stages.map((s) => (
                    <option key={s.id} value={`${p.id}:${s.id}`}>
                      {p.name} → {s.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <>
              <input type="hidden" name="ghl_stage" value={currentStage} />
              <p className="text-sm text-muted">
                {pipelineError
                  ? `Couldn't load pipelines: ${pipelineError}`
                  : client?.ghl_location_id && client.ghl_token
                    ? "This Nexus Portal sub-account has no pipelines yet. Interested replies become a contact with a note; create a pipeline in Nexus Portal to get opportunities too."
                    : "Save the location ID and token first, then pick the pipeline stage here."}
              </p>
            </>
          )}
        </div>
        {client?.ghl_location_id && client.ghl_token && (
          <div className="flex flex-col gap-3 rounded-md border border-line p-3">
            <div>
              <div className="text-sm font-medium">Counting meetings booked</div>
              <p className="text-xs text-muted">
                A lead counts as a booked meeting when they book on one of these calendars after being emailed, or reach the stage below.
              </p>
            </div>
            {calendars.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="label">Calendars</span>
                {calendars.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="meeting_calendars" value={c.id} defaultChecked={meetingCalendars.length === 0 || meetingCalendars.includes(c.id)} />
                    {c.name}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted">No calendars found in this sub-account.</p>
            )}
            <div>
              <label className="label" htmlFor="meeting_stage">Also count opportunities in this stage</label>
              <select id="meeting_stage" name="meeting_stage" defaultValue={client.ghl_meeting_stage ?? ""} className="field">
                <option value="">None</option>
                {pipelines.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    {p.stages.map((s) => (
                      <option key={s.id} value={`${p.id}:${s.id}`}>{p.name} → {s.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        )}
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <div>
          <h2 className="font-semibold">Brief for the AI writer</h2>
          <p className="text-sm text-muted">Every email for this client is written from this brief plus the lead&apos;s own fields.</p>
        </div>
        {BRIEF_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="label" htmlFor={`brief_${f.key}`}>{f.label}</label>
            {f.rows > 1 ? (
              <textarea id={`brief_${f.key}`} name={`brief_${f.key}`} rows={f.rows} defaultValue={client?.brief[f.key] ?? ""} className="field" />
            ) : (
              <input id={`brief_${f.key}`} name={`brief_${f.key}`} defaultValue={client?.brief[f.key] ?? ""} className="field" />
            )}
            <p className="mt-1 text-xs text-muted">{f.hint}</p>
          </div>
        ))}
      </section>

      <div>
        <button type="submit" className="btn-go">{client ? "Save changes" : "Add client"}</button>
      </div>
    </form>
  );
}
