import { saveClient } from "@/app/clients/actions";
import { mask, type Client } from "@/lib/clients";
import { listPipelines, type GhlPipeline } from "@/lib/ghl";

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
            Create it in the client&apos;s own workspace with the <span className="font-mono">all:all</span> scope. Saving checks it straight away.
          </p>
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
                  : "Save the location ID and token first, then pick the pipeline stage here."}
              </p>
            </>
          )}
        </div>
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
