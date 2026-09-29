"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveLead, rejectLead, rewriteDraft, redraftLead, pushAllApproved } from "@/app/leads/actions";
import type { QueueDraft, QueueLead } from "@/lib/approvals";

type Edits = Record<number, { subject: string; body: string; baseSubject: string; baseBody: string }>;

export function ApprovalQueue({
  leads,
  clientId,
  approvedCount,
  draftingCount,
  showClient,
}: {
  leads: QueueLead[];
  clientId: number | null;
  approvedCount: number;
  draftingCount: number;
  showClient: boolean;
}) {
  const router = useRouter();
  const [done, setDone] = useState<Set<number>>(new Set());
  const queue = useMemo(() => leads.filter((l) => !done.has(l.id)), [leads, done]);
  const [selectedId, setSelectedId] = useState<number | null>(queue[0]?.id ?? null);
  const selected = queue.find((l) => l.id === selectedId) ?? queue[0] ?? null;
  const [edits, setEdits] = useState<Edits>({});
  const [guidance, setGuidance] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string>("");
  const [message, setMessage] = useState("");
  const [, start] = useTransition();

  // A local edit only counts while the server text it was based on is unchanged; an AI rewrite replaces it.
  const current = useCallback(
    (d: QueueDraft) => {
      const e = edits[d.id];
      return e && e.baseSubject === d.subject && e.baseBody === d.body ? e : { subject: d.subject, body: d.body };
    },
    [edits],
  );
  const setEdit = (d: QueueDraft, patch: Partial<{ subject: string; body: string }>) =>
    setEdits({ ...edits, [d.id]: { ...current(d), ...patch, baseSubject: d.subject, baseBody: d.body } });

  const advance = useCallback(
    (fromId: number) => {
      const idx = queue.findIndex((l) => l.id === fromId);
      const next = queue[idx + 1] ?? queue[idx - 1] ?? null;
      setDone((d) => new Set(d).add(fromId));
      setSelectedId(next?.id ?? null);
    },
    [queue],
  );

  const approve = useCallback(() => {
    if (!selected) return;
    const lead = selected;
    const payload = lead.drafts.map((d) => { const c = current(d); return { id: d.id, subject: c.subject, body: c.body }; });
    advance(lead.id);
    start(async () => {
      await approveLead(lead.id, payload);
      router.refresh();
    });
  }, [selected, current, advance, router]);

  const reject = useCallback(() => {
    if (!selected) return;
    const lead = selected;
    advance(lead.id);
    start(async () => {
      await rejectLead(lead.id);
      router.refresh();
    });
  }, [selected, advance, router]);

  const move = useCallback(
    (delta: number) => {
      if (!selected) return;
      const idx = queue.findIndex((l) => l.id === selected.id);
      const next = queue[Math.min(queue.length - 1, Math.max(0, idx + delta))];
      if (next) setSelectedId(next.id);
    },
    [queue, selected],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          approve();
        }
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (e.key === "a") approve();
      else if (e.key === "r") reject();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve, reject, move]);

  const rewrite = (draftId: number) => {
    setBusy(`rewrite-${draftId}`);
    start(async () => {
      try {
        await rewriteDraft(draftId, guidance[draftId] ?? "");
        setGuidance((g) => ({ ...g, [draftId]: "" }));
        router.refresh();
      } catch (e) {
        setMessage((e as Error).message);
      } finally {
        setBusy("");
      }
    });
  };

  const push = () => {
    setBusy("push");
    start(async () => {
      const r = await pushAllApproved(clientId);
      setMessage(
        `Sent ${r.pushed} leads to Instantly.` +
          (r.skipped ? ` ${r.skipped} were skipped by Instantly (see Leads → Error).` : "") +
          (r.errors.length ? ` Problems: ${r.errors.join("; ")}` : ""),
      );
      setBusy("");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 text-sm">
          <span><span className="num font-semibold text-wait">{queue.length}</span> to review</span>
          {draftingCount > 0 && <span className="text-info">AI writing {draftingCount} more…</span>}
          <span className="text-muted">
            Keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> approve · <kbd>r</kbd> reject · <kbd>Ctrl+Enter</kbd> approve while editing
          </span>
        </div>
        <button className="btn-go" disabled={approvedCount === 0 || busy === "push"} onClick={push}>
          {busy === "push" ? "Sending…" : `Send ${approvedCount} approved to Instantly`}
        </button>
      </div>
      {message && <div className="rounded-md border border-line bg-card px-3 py-2 text-sm">{message}</div>}

      {!selected ? (
        <div className="card p-8 text-center text-sm text-muted">Nothing waiting for review.</div>
      ) : (
        <div className="grid grid-cols-[280px_1fr] gap-4">
          <ul className="card max-h-[calc(100vh-220px)] overflow-y-auto">
            {queue.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(l.id)}
                  className={`w-full border-b border-line px-3 py-2 text-left ${l.id === selected.id ? "bg-wait-soft" : "hover:bg-paper"}`}
                >
                  <div className="truncate text-sm font-medium">{[l.first_name, l.last_name].filter(Boolean).join(" ") || l.email}</div>
                  <div className="truncate text-xs text-muted">
                    {showClient ? `${l.client_name} · ` : ""}{l.company ?? l.email}
                  </div>
                  {l.drafts[0]?.flags && <div className="truncate text-xs text-wait">⚑ {l.drafts[0].flags}</div>}
                </button>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-4">
            <div className="card flex items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="font-semibold">
                  {[selected.first_name, selected.last_name].filter(Boolean).join(" ") || "(no name)"}{" "}
                  <span className="font-normal text-muted">{selected.title ? `· ${selected.title}` : ""}</span>
                </div>
                <div className="text-sm">{selected.company} <span className="font-mono text-xs text-muted">{selected.email}</span></div>
                <div className="mt-1 text-xs text-muted">
                  {selected.client_name} → {selected.campaign_name}
                  {selected.website && <> · <a className="underline" href={selected.website.startsWith("http") ? selected.website : `https://${selected.website}`} target="_blank" rel="noreferrer">{selected.website}</a></>}
                </div>
                {Object.keys(selected.fields).length > 0 && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted">Other fields the AI saw</summary>
                    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
                      {Object.entries(selected.fields).map(([k, v]) => (
                        <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="truncate">{v}</dd></Fragment>
                      ))}
                    </dl>
                  </details>
                )}
                {selected.drafts[0]?.flags && <div className="mt-2 rounded bg-wait-soft px-2 py-1 text-xs text-wait">⚑ {selected.drafts[0].flags}</div>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button className="btn-bad" onClick={reject}>Reject</button>
                <button className="btn-go" onClick={approve}>Approve all steps</button>
              </div>
            </div>

            {selected.drafts.map((d) => {
              const e = current(d);
              const words = e.body.trim().split(/\s+/).length;
              return (
                <div key={d.id} className="card flex flex-col gap-2 p-4">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span className="font-medium uppercase tracking-wide">
                      Step {d.step}{d.step > 1 ? " · reply in same thread" : ""}{d.edited ? " · edited" : ""}
                    </span>
                    <span className="num">{words} words</span>
                  </div>
                  {d.step === 1 && (
                    <input
                      className="field font-medium"
                      value={e.subject}
                      onChange={(ev) => setEdit(d, { subject: ev.target.value })}
                    />
                  )}
                  <textarea
                    className="field min-h-40 leading-relaxed"
                    rows={Math.min(16, e.body.split("\n").length + 2)}
                    value={e.body}
                    onChange={(ev) => setEdit(d, { body: ev.target.value })}
                  />
                  <div className="flex gap-2">
                    <input
                      className="field flex-1 text-xs"
                      placeholder="Tell the AI what to change in this step, e.g. 'shorter, mention their Leeds office'"
                      value={guidance[d.id] ?? ""}
                      onChange={(ev) => setGuidance({ ...guidance, [d.id]: ev.target.value })}
                      onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.ctrlKey) { ev.preventDefault(); rewrite(d.id); } }}
                    />
                    <button className="btn text-xs" disabled={busy === `rewrite-${d.id}`} onClick={() => rewrite(d.id)}>
                      {busy === `rewrite-${d.id}` ? "Rewriting…" : "Rewrite"}
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              className="self-start text-xs text-muted underline"
              onClick={() => {
                const id = selected.id;
                advance(id);
                start(async () => { await redraftLead(id); router.refresh(); });
              }}
            >
              Throw these away and write the whole sequence again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
