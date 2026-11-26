"use client";

import { useEffect, useRef, useState } from "react";
import { SubmitButton } from "./SubmitButton";
import { dayLabel, firstSendAt, startLabel, utcToZoned, zonedToUtc, zoneLabel } from "@/lib/startTime";

type Hours = { days: number[]; from: string; to: string; timezone: string };

const addDay = (ymd: string) => new Date(Date.parse(`${ymd}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);

/** The next few days it can send on: the likely choices, one click away. Today isn't one: "Start sending" does that. */
function quickPicks(hours: Hours, now: number): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const today = utcToZoned(new Date(now), hours.timezone).split("T")[0];
  const tomorrow = addDay(today);
  let day = tomorrow;
  for (let i = 0; i < 10 && out.length < 3; i++, day = addDay(day)) {
    if (!hours.days.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
    out.push({ value: day, label: day === tomorrow ? "Tomorrow" : dayLabel(day) });
  }
  return out;
}

/**
 * Pick the day sending starts: one click on a likely day, or any date. Sending begins when that day's sending hours open,
 * so there's no time to choose. Says in words when the first emails will really go.
 */
export function StartTimeForm({ action, hours, now, value, submit }: { action: (form: FormData) => void; hours: Hours; now: number; value?: string; submit: string }) {
  const picks = quickPicks(hours, now);
  const today = utcToZoned(new Date(now), hours.timezone).split("T")[0];
  const [date, setDate] = useState(value?.split("T")[0] ?? picks[0]?.value ?? addDay(today));

  const at = date ? zonedToUtc(`${date}T${hours.from}`, hours.timezone) : null;
  const past = !at || at.getTime() <= now;
  const first = at && !past ? firstSendAt(at, hours) : null;
  const zone = zoneLabel(hours.timezone);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="start_at" value={date} />
      {picks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {picks.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setDate(p.value)}
              aria-pressed={date === p.value}
              className={`cursor-pointer rounded-md border px-3 py-1.5 text-[13px] transition-colors motion-reduce:transition-none ${
                date === p.value ? "border-info bg-info-soft font-medium text-info" : "border-line text-ink hover:border-muted hover:bg-paper"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div>
        <label className="label" htmlFor="start-date">Or pick a day</label>
        <input id="start-date" type="date" required className="field" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
      </div>
      <p className="text-[13px]" role="status">
        {past ? (
          <span className="text-bad">Pick a day in the future. To start today, use Start sending.</span>
        ) : first && at && first.getTime() !== at.getTime() ? (
          <>
            <span className="font-medium">First emails go {startLabel(first, hours.timezone)}</span>
            <span className="text-muted">, {zone} time. That day isn&apos;t one of the campaign&apos;s sending days.</span>
          </>
        ) : (
          <>
            <span className="font-medium">Starts {dayLabel(date)}</span>
            <span className="text-muted">, as its sending hours open at {hours.from} {zone} time. It can begin up to 30 minutes after that.</span>
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
        <div role="dialog" aria-label="Pick the start day" className="popover absolute right-0 z-20 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] p-4">
          <h3 className="mb-3 font-semibold">Which day should sending start?</h3>
          <StartTimeForm {...props} action={save} />
        </div>
      )}
    </div>
  );
}
