"use client";

import { useState, useTransition } from "react";
import Papa from "papaparse";
import { addManualLead, importCsvLeads, importGhlLeads, ghlTags } from "@/app/leads/actions";
import type { LeadFields, ImportResult } from "@/lib/leads";

const COLUMNS = [
  { key: "email", label: "Email", required: true },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "company", label: "Company" },
  { key: "title", label: "Job title" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
] as const;

type Col = (typeof COLUMNS)[number]["key"];

const PATTERNS: Record<Col, string[]> = {
  email: ["email", "emailaddress", "workemail", "mail"],
  first_name: ["firstname", "first", "fname", "givenname"],
  last_name: ["lastname", "last", "lname", "surname"],
  company: ["company", "companyname", "organisation", "organization", "account", "business", "businessname"],
  title: ["title", "jobtitle", "position", "role"],
  phone: ["phone", "phonenumber", "mobile", "telephone"],
  website: ["website", "companywebsite", "url", "domain", "companydomain"],
};

function guess(headers: string[]): Partial<Record<Col, string>> {
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");
  const out: Partial<Record<Col, string>> = {};
  for (const c of COLUMNS) {
    const hit = headers.find((h) => PATTERNS[c.key].includes(norm(h)));
    if (hit) out[c.key] = hit;
  }
  return out;
}

export function LeadImporter({
  clientId, campaigns, hasGhl, campaignId: fixedCampaignId,
}: {
  clientId: number;
  campaigns: { id: number; name: string }[];
  hasGhl: boolean;
  /** When given, contacts always go into this campaign and the campaign picker is hidden. */
  campaignId?: number;
}) {
  const [mode, setMode] = useState<"manual" | "csv" | "ghl">("manual");
  const [manual, setManual] = useState({ email: "", first_name: "", last_name: "", company: "", title: "", website: "" });
  const writeNow = true; // the address check decides; a contact that passes is prepared automatically
  const [campaignId, setCampaignId] = useState<number>(fixedCampaignId ?? campaigns[0]?.id ?? 0);
  const [file, setFile] = useState<{ name: string; headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [map, setMap] = useState<Partial<Record<Col, string>>>({});
  const [tags, setTags] = useState<string[] | null>(null);
  const [tag, setTag] = useState("");
  const [result, setResult] = useState<string>("");
  const [pending, start] = useTransition();

  if (campaigns.length === 0) {
    return <div className="card p-4 text-sm text-muted">Create a campaign first; contacts are added to a campaign.</div>;
  }

  const onFile = (f: File) => {
    Papa.parse<Record<string, string>>(f, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = res.meta.fields ?? [];
        setFile({ name: f.name, headers, rows: res.data });
        setMap(guess(headers));
        setResult("");
      },
    });
  };

  const summary = (r: ImportResult & { error?: string }) =>
    r.error ??
    `${r.added} added${r.updated ? `, ${r.updated} refreshed` : ""}${r.skippedExisting ? `, ${r.skippedExisting} already in progress` : ""}${r.skippedInvalid ? `, ${r.skippedInvalid} without a valid email` : ""}.`;

  const importCsv = () => {
    if (!file || !map.email) return;
    const mapped = new Set(Object.values(map));
    const leads: LeadFields[] = file.rows.map((row) => ({
      email: row[map.email!] ?? "",
      first_name: map.first_name ? row[map.first_name] : null,
      last_name: map.last_name ? row[map.last_name] : null,
      company: map.company ? row[map.company] : null,
      title: map.title ? row[map.title] : null,
      phone: map.phone ? row[map.phone] : null,
      website: map.website ? row[map.website] : null,
      // Every unmapped column is still available to the AI writer.
      fields: Object.fromEntries(Object.entries(row).filter(([k, v]) => !mapped.has(k) && v && String(v).trim())),
    }));
    start(async () => {
      const r = await importCsvLeads(clientId, campaignId, file.name, leads);
      setResult(summary(r));
      setFile(null);
    });
  };

  const loadTags = () =>
    start(async () => {
      const r = await ghlTags(clientId);
      setTags(r.tags);
      if (r.error) setResult(r.error);
    });

  const importGhl = () =>
    start(async () => {
      const r = await importGhlLeads(clientId, campaignId, tag);
      setResult(summary(r));
    });

  return (
    <div className="card flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Add contacts</h2>
        <div className="flex rounded-md border border-line p-0.5 text-sm">
          {(["manual", "csv", "ghl"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setResult(""); if (m === "ghl" && tags === null && hasGhl) loadTags(); }}
              className={`rounded px-3 py-1 ${mode === m ? "bg-ink text-paper" : "text-muted"}`}
            >
              {m === "manual" ? "Type it in" : m === "csv" ? "CSV file" : "From Nexus Portal"}
            </button>
          ))}
        </div>
      </div>

      {!fixedCampaignId && (
        <div>
          <label className="label" htmlFor="imp-campaign">Into campaign</label>
          <select id="imp-campaign" className="field" value={campaignId} onChange={(e) => setCampaignId(Number(e.target.value))}>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}

      {mode === "manual" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await addManualLead(clientId, campaignId, manual, writeNow);
              if (r.added || r.updated) {
                setResult(`Added ${manual.email}${writeNow ? "; the AI is writing its emails now, then it'll be in Approvals" : ""}.`);
                setManual({ email: "", first_name: "", last_name: "", company: "", title: "", website: "" });
              } else {
                setResult(r.error ?? (r.skippedExisting ? `${manual.email} is already in progress for this client.` : "That email address doesn't look valid."));
              }
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            {([
              ["email", "Email *", "email"],
              ["first_name", "First name", "text"],
              ["last_name", "Last name", "text"],
              ["company", "Company", "text"],
              ["title", "Job title", "text"],
              ["website", "Website", "text"],
            ] as const).map(([k, label, type]) => (
              <div key={k}>
                <label className="label" htmlFor={`m-${k}`}>{label}</label>
                <input
                  id={`m-${k}`}
                  type={type}
                  required={k === "email"}
                  className="field"
                  value={manual[k]}
                  onChange={(e) => setManual({ ...manual, [k]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">The address is checked first; if it passes, the email is prepared and the contact appears as ready to send.</p>
          <button className="btn-go self-start" disabled={pending || !manual.email}>
            {pending ? "Adding…" : "Add contact"}
          </button>
        </form>
      ) : mode === "csv" ? (
        <>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} className="text-sm" />
          {file && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">
                {file.rows.length} rows in <span className="font-medium text-ink">{file.name}</span>. Check the column matches; unmatched columns are still given to the AI.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {COLUMNS.map((c) => (
                  <div key={c.key}>
                    <label className="label">{c.label}{"required" in c ? " *" : ""}</label>
                    <select
                      className="field"
                      value={map[c.key] ?? ""}
                      onChange={(e) => setMap({ ...map, [c.key]: e.target.value || undefined })}
                    >
                      <option value="">— not in file —</option>
                      {file.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <button type="button" className="btn-go self-start" disabled={!map.email || pending} onClick={importCsv}>
                {pending ? "Importing…" : `Add ${file.rows.length} contacts`}
              </button>
            </div>
          )}
        </>
      ) : !hasGhl ? (
        <p className="text-sm text-muted">Add this client&apos;s Nexus Portal location ID and token in Settings first.</p>
      ) : (
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="label" htmlFor="imp-tag">Contacts with tag</label>
            {tags && tags.length > 0 ? (
              <select id="imp-tag" className="field" value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">Pick a tag…</option>
                {tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : (
              <input id="imp-tag" className="field" value={tag} onChange={(e) => setTag(e.target.value)} placeholder={pending ? "Loading tags…" : "tag name"} />
            )}
          </div>
          <button type="button" className="btn-go" disabled={!tag || pending} onClick={importGhl}>
            {pending ? "Importing…" : "Import"}
          </button>
        </div>
      )}

      {result && <p className="text-sm">{result}</p>}
    </div>
  );
}
