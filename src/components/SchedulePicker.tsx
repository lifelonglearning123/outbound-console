"use client";

import { useEffect, useRef, useState } from "react";
import { SubmitButton } from "./SubmitButton";
import { dayLabel, firstSendAt, startLabel, timeChoices, utcToZoned, zonedToUtc, zoneLabel } from "@/lib/startTime";

type Hours = { days: number[]; from: string; to: string; timezone: string };

const addDay = (ymd: string) => new Date(Date.parse(`${ymd}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);

/** The next few days it can send on, at the start of its sending hours: the likely choices, one click away. */
function quickPicks(hours: Hours, now: number): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const today = utcToZoned(new Date(now), hours.timezone).split("T")[0];
  const tomorrow = addDay(today);
  let day = tomorrow;
  for (let i = 0; i < 10 && out.length < 3; i++, day = addDay(day)) {
    if (!hours.days.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
    out.push({ value: `${day}T${hours.from}`, label: day === tomorrow ? "Tomorrow" : dayLabel(day) });
  }
  return out;
}

/** Pick a start: one click on a likely day, or a date with an hour and minute. Says in words when sending will really begin. */
export function StartTimeForm({ action, hours, now, value, submit }: { action: (form: FormData) => void; hours: Hours; now: number; value?: string; submit: string }) {
  const picks = quickPicks(hours, now);
  const initial = value ?? picks[0]?.value ?? utcToZoned(new Date(now + 86400_000), hours.timezone);
  const [date, setDate] = useState(initial.split("T")[0]);
  const [hour, setHour] = useState(initial.slice(11, 13));
  const [minute, setMinute] = useState(initial.slice(14, 16));

  const choices = timeChoices(hours.from, hours.to);
  const inChoices = choices.some((c) => c.hour === hour);
  // A start saved outside today's sending hours stays selectable, so opening this never changes it by itself.
  const hourList = inChoices ? choices : [{ hour, minutes: [minute] }, ...choices];
  const minutes = hourList.find((c) => c.hour === hour)?.minutes ?? [];
  const minuteList = minutes.includes(minute) ? minutes : [minute, ...minutes];

  const pickHour = (h: string) => {
    const available = hourList.find((c) => c.hour === h)?.minutes ?? [];
    setHour(h);
    if (!available.includes(minute)) setMinute(available[0] ?? "00");
  };
  const pick = (v: string) => {
    setDate(v.split("T")[0]);
    setHour(v.slice(11, 13));
    setMinute(v.slice(14, 16));
  };

  const local = `${date}T${hour}:${minute}`;
  const at = date ? zonedToUtc(local, hours.timezone) : null;
  const past = !at || at.getTime() <= now;
  const first = at && !past ? firstSendAt(at, hours) : null;
  const zone = zoneLabel(hours.timezone);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="start_at" value={local} />
      {picks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {picks.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => pick(p.value)}
              aria-pressed={local === p.value}
              className={`cursor-pointer rounded-md border px-3 py-1.5 text-[13px] transition-colors motion-reduce:transition-none ${
                local === p.value ? "border-info bg-info-soft font-medium text-info" : "border-line text-ink hover:border-muted hover:bg-paper"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <div>
          <label className="label" htmlFor="start-date">Date</label>
          <input
            id="start-date"
            type="date"
            required
            className="field"
            value={date}
            min={utcToZoned(new Date(now), hours.timezone).split("T")[0]}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="start-hour">Hour</label>
          <select id="start-hour" className="field w-20" value={hour} onChange={(e) => pickHour(e.target.value)}>
            {hourList.map((c) => <option key={c.hour} value={c.hour}>{c.hour}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="start-minute">Minute</label>
          <select id="start-minute" className="field w-20" value={minute} onChange={(e) => setMinute(e.target.value)}>
            {minuteList.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <p className="text-[13px]" role="status">
        {past ? (
          <span className="text-bad">Pick a time in the future.</span>
        ) : first && at && first.getTime() !== at.getTime() ? (
          <>
            <span className="font-medium">First emails go {startLabel(first, hours.timezone)}</span>
            <span className="text-muted">, {zone} time. That day is outside the campaign&apos;s sending days.</span>
          </>
        ) : (
          <>
            <span className="font-medium">Starts {at ? startLabel(at, hours.timezone) : ""}</span>
            <span className="text-muted">, {zone} time. It can begin up to 30 minutes after this.</span>
          </>
        )}
      </p>
      <div className="flex justify-end">
        {past ? <button type="button" className="btn-go" disabled>{submit}</button> : <SubmitButton className="btn-go" pendingLabel="Saving…">{submit}</SubmitButton>}
      </div>
    </form>
  );
}

/** A button that opens the start picker beside it. Clicking away or pressing Escape closes it, and saving closes it too. */
export function SchedulePicker(props: { action: (form: FormData) => void; hours: Hours; now: number; value?: string; label: string; submit: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const save = async (form: FormData) => {
    await props.action(form);
    setOpen(false);
  };
  return (
    <div ref={box} className="relative">
      <button type="button" className="btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>{props.label}</button>
      {open && (
        <div role="dialog" aria-label="Schedule the start" className="popover absolute right-0 z-20 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] p-4">
          <h3 className="mb-3 font-semibold">When should sending start?</h3>
          <StartTimeForm {...props} action={save} />
        </div>
      )}
    </div>
  );
}
