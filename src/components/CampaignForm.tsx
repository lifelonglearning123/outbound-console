"use client";

import { useState } from "react";
import type { Schedule, Step } from "@/lib/campaigns";
import { INSTANTLY_TIMEZONES } from "@/lib/timezones";
import { EmailEditor } from "./EmailEditor";

const DAYS = [
  { v: 1, l: "Mon" }, { v: 2, l: "Tue" }, { v: 3, l: "Wed" }, { v: 4, l: "Thu" },
  { v: 5, l: "Fri" }, { v: 6, l: "Sat" }, { v: 0, l: "Sun" },
];

type Props = {
  action: (form: FormData) => void;
  name: string;
  steps: Step[];
  schedule: Schedule;
  dailyLimit: number;
  accounts: string[];
  stopOnReply: boolean;
  mailboxes: { email: string; healthy: boolean }[];
  managed: boolean;
  submitLabel: string;
  holdAfter: number | null;
  /** Steps already live in Instantly with leads in them; the hold can then only move via "Release hold". */
  lockedLive: number;
  ghlTag: string | null;
  ghlTags: string[] | null; // null = client has no Nexus Portal connection
};

export function CampaignForm(p: Props) {
  // uid keeps each step's editor attached to the right step when steps are removed.
  const [steps, setSteps] = useState<(Step & { uid: number })[]>(() => p.steps.map((s, i) => ({ ...s, uid: i })));
  const [hold, setHold] = useState<number>(p.holdAfter ?? 0);
  const effectiveHold = p.lockedLive ? (steps.length > p.lockedLive ? p.lockedLive : 0) : hold && hold < steps.length ? hold : 0;
  const update = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <form action={p.action} className="flex max-w-3xl flex-col gap-6">
      <section className="card flex flex-col gap-4 p-5">
        <div>
          <label className="label" htmlFor="name">Campaign name</label>
          <input id="name" name="name" required defaultValue={p.name} readOnly={!p.managed} className="field" />
        </div>
      </section>

      {p.managed && (
        <section className="card flex flex-col gap-4 p-5">
          <div>
            <h2 className="font-semibold">Sequence</h2>
            <p className="text-sm text-muted">
              Each email is either your own, sent exactly as designed, or written by the AI for each contact. Follow-ups are sent as replies in the same
              thread. Every email waits for your approval.
            </p>
          </div>
          {steps.map((s, i) => (
            <div key={s.uid} className="flex flex-col gap-2 rounded-md border border-line p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">
                  {i === 0 ? "Email 1" : `Follow-up ${i + 1}`}
                  {effectiveHold > 0 && i >= effectiveHold && (
                    <span className="ml-2 rounded bg-wait-soft px-1.5 py-0.5 text-xs font-medium text-wait">on hold</span>
                  )}
                </span>
                <div className="flex items-center gap-3">
                  <div className="flex rounded-md border border-line p-0.5 text-xs">
                    {(["fixed", "ai"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => update(i, { mode: m })}
                        className={`rounded px-2.5 py-1 ${(s.mode ?? "ai") === m ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
                      >
                        {m === "fixed" ? "My email" : "AI writes"}
                      </button>
                    ))}
                  </div>
                  {steps.length > 1 && (
                    <button type="button" className="text-xs text-muted hover:text-bad" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
              <input type="hidden" name={`step_${i + 1}_mode`} value={s.mode ?? "ai"} />
              {s.mode === "fixed" ? (
                <>
                  {i === 0 ? (
                    <input
                      name={`step_${i + 1}_subject`}
                      className="field font-medium"
                      placeholder="Subject line (merge fields work here too)"
                      required
                      value={s.subject ?? ""}
                      onChange={(e) => update(i, { subject: e.target.value })}
                    />
                  ) : (
                    <p className="text-xs text-muted">No subject: this follow-up is sent as a reply in the same thread.</p>
                  )}
                  <EmailEditor name={`step_${i + 1}_body`} initial={s.body ?? ""} />
                  <input type="hidden" name={`step_${i + 1}_instructions`} value={s.instructions || "Client's own email"} />
                </>
              ) : (
                <textarea
                  name={`step_${i + 1}_instructions`}
                  rows={2}
                  className="field"
                  placeholder="What should this email do?"
                  value={s.instructions}
                  onChange={(e) => update(i, { instructions: e.target.value })}
                />
              )}
              {i < steps.length - 1 ? (
                <label className="flex items-center gap-2 text-sm text-muted">
                  Wait
                  <input
                    type="number"
                    min={0}
                    name={`step_${i + 1}_delay`}
                    value={s.delay_days}
                    onChange={(e) => update(i, { delay_days: Number(e.target.value) })}
                    className="field w-20"
                  />
                  days, then send follow-up {i + 2}
                </label>
              ) : (
                <input type="hidden" name={`step_${i + 1}_delay`} value={0} />
              )}
            </div>
          ))}
          {steps.length < 6 && (
            <button type="button" className="btn self-start" onClick={() => setSteps([...steps, { delay_days: 3, instructions: "", mode: "ai", uid: Math.max(0, ...steps.map((x) => x.uid)) + 1 }])}>
              + Add follow-up
            </button>
          )}
          <div className="flex flex-col gap-1 rounded-md border border-dashed border-wait/50 bg-wait-soft/40 p-3">
            <input type="hidden" name="hold_after" value={effectiveHold} />
            {p.lockedLive ? (
              <p className="text-sm">
                {steps.length > p.lockedLive ? (
                  <>Emails 1-{p.lockedLive} are already being sent. Emails {p.lockedLive + 1}-{steps.length} are <strong>on hold</strong> until you release them from the campaign page.</>
                ) : (
                  <>All {p.lockedLive} emails are already being sent. Add one here and it&apos;s held until you release it from the campaign page.</>
                )}
              </p>
            ) : (
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">Hold</span>
                <select className="field" style={{ width: "auto" }} value={effectiveHold} onChange={(e) => setHold(Number(e.target.value))}>
                  <option value={0}>No hold: send every step automatically</option>
                  {steps.slice(0, -1).map((_, i) => (
                    <option key={i} value={i + 1}>After email {i + 1}: wait for my next emails</option>
                  ))}
                </select>
              </label>
            )}
            <p className="text-xs text-muted">
              A hold stops the sequence after that step. Leads get the steps before it; the steps after it can stay unfinished until your
              client has written them. Then use <strong>Release hold</strong> on the campaign page: the next emails are written for every
              lead still in play, you approve them, and they&apos;re added to Instantly.
            </p>
          </div>
          <p className="text-xs text-muted">Changing the sequence later only affects emails prepared after the change.</p>
        </section>
      )}

      {p.managed && (
        <section className="card flex flex-col gap-3 p-5">
          <div>
            <h2 className="font-semibold">Contacts from Nexus Portal</h2>
            <p className="text-sm text-muted">
              Link this campaign to a Nexus Portal tag. Every 30 minutes (or when you click Sync now), contacts who have the tag (and aren&apos;t on Do-Not-Disturb) join the
              campaign, their emails are prepared, and they wait on the Approve tab.
            </p>
          </div>
          {p.ghlTags === null ? (
            <p className="text-sm text-muted">Connect this client&apos;s Nexus Portal in Settings first.</p>
          ) : (
            <div>
              <label className="label" htmlFor="ghl_tag">Nexus Portal tag</label>
              <input id="ghl_tag" name="ghl_tag" list="ghl-tags" defaultValue={p.ghlTag ?? ""} className="field" placeholder="e.g. cold-email-q4 (leave blank to add leads by hand)" />
              <datalist id="ghl-tags">{p.ghlTags.map((t) => <option key={t} value={t} />)}</datalist>
            </div>
          )}
        </section>
      )}

      <section className="card flex flex-col gap-4 p-5">
        <h2 className="font-semibold">Sending</h2>
        <div>
          <span className="label">Days</span>
          <div className="flex gap-2">
            {DAYS.map((d) => (
              <label key={d.v} className="flex items-center gap-1 text-sm">
                <input type="checkbox" name="days" value={d.v} defaultChecked={p.schedule.days.includes(d.v)} />
                {d.l}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="label" htmlFor="from">From</label>
            <input id="from" name="from" type="time" defaultValue={p.schedule.from} className="field" />
          </div>
          <div>
            <label className="label" htmlFor="to">To</label>
            <input id="to" name="to" type="time" defaultValue={p.schedule.to} className="field" />
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="timezone">Timezone</label>
            <select id="timezone" name="timezone" defaultValue={p.schedule.timezone} className="field">
              {INSTANTLY_TIMEZONES.map((t) => (
                <option key={t} value={t}>{t === "Europe/Isle_of_Man" ? "UK time (Europe/Isle_of_Man)" : t}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="label" htmlFor="daily_limit">Daily cap</label>
            <input id="daily_limit" name="daily_limit" type="number" min={1} defaultValue={p.dailyLimit} className="field" />
          </div>
          <label className="col-span-3 flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" name="stop_on_reply" defaultChecked={p.stopOnReply} disabled={!p.managed} />
            Stop the sequence for a lead when they reply
          </label>
        </div>
        <div>
          <span className="label">Send from</span>
          {p.mailboxes.length === 0 ? (
            <p className="text-sm text-muted">No mailboxes yet. Use &quot;Check&quot; in Settings to pull them from Instantly.</p>
          ) : (
            <div className="grid grid-cols-2 gap-1">
              {p.mailboxes.map((m) => (
                <label key={m.email} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="accounts" value={m.email} defaultChecked={p.accounts.includes(m.email)} />
                  <span className="font-mono text-xs">{m.email}</span>
                  {!m.healthy && <span className="text-xs text-bad">unhealthy</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      </section>

      <div>
        <button type="submit" className="btn-go">{p.submitLabel}</button>
      </div>
    </form>
  );
}
