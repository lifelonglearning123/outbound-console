"use client";

import { useState } from "react";
import type { Schedule, Step } from "@/lib/campaigns";
import { INSTANTLY_TIMEZONES } from "@/lib/timezones";

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
};

export function CampaignForm(p: Props) {
  const [steps, setSteps] = useState<Step[]>(p.steps);
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
              Tell the AI what each email should do. Follow-ups are sent as replies in the same thread. Every email is written per lead and waits for your approval.
            </p>
          </div>
          {steps.map((s, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-md border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Step {i + 1}{i === 0 ? " — opener" : " — follow-up"}</span>
                {steps.length > 1 && (
                  <button type="button" className="text-xs text-muted hover:text-bad" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </div>
              <textarea
                name={`step_${i + 1}_instructions`}
                rows={2}
                className="field"
                value={s.instructions}
                onChange={(e) => update(i, { instructions: e.target.value })}
              />
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
                  days, then send step {i + 2}
                </label>
              ) : (
                <input type="hidden" name={`step_${i + 1}_delay`} value={0} />
              )}
            </div>
          ))}
          {steps.length < 6 && (
            <button type="button" className="btn self-start" onClick={() => setSteps([...steps, { delay_days: 3, instructions: "" }])}>
              + Add follow-up
            </button>
          )}
          <p className="text-xs text-muted">Changing the steps later only affects emails written after the change.</p>
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
            <p className="text-sm text-muted">No mailboxes synced yet. Use &quot;Check&quot; at the top to pull them from Instantly.</p>
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
