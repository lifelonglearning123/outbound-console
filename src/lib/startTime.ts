/** A campaign's start time, which people pick in the campaign's own timezone and the console stores in UTC. */

type Hours = { days: number[]; from: string; to: string; timezone: string };

function wallClock(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
}

const offsetAt = (date: Date, timeZone: string) => {
  const w = wallClock(date, timeZone);
  return Date.UTC(+w.year, +w.month - 1, +w.day, +w.hour, +w.minute, +w.second) - Math.floor(date.getTime() / 1000) * 1000;
};

/** "2026-11-10T09:00" on the clocks in that timezone, as a moment. Read twice because the offset can differ either side of a clock change. */
export function zonedToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) throw new Error("Pick a date and time.");
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const first = wall - offsetAt(new Date(wall), timeZone);
  return new Date(wall - offsetAt(new Date(first), timeZone));
}

/** A moment as the value of a date and time box, on the clocks in that timezone. */
export function utcToZoned(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone);
  return `${w.year}-${w.month}-${w.day}T${w.hour}:${w.minute}`;
}

/** "Tue 10 Nov, 09:00". */
export const startLabel = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date).replace(/,? (\d{2}:\d{2})$/, ", $1");

/** "Wed 4 Nov" from "2026-11-04". */
export const dayLabel = (ymd: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${ymd}T12:00:00Z`)).replace(",", "");

/** "Isle of Man" from "Europe/Isle_of_Man". */
export const zoneLabel = (timeZone: string) => (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");

/**
 * The times a start can be picked from: the hours inside the sending window, each with its quarter hours. Two short
 * lists, rather than one long one to scroll through. A window opening off the quarter (22:12) keeps that exact minute.
 */
export function timeChoices(from: string, to: string): { hour: string; minutes: string[] }[] {
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const pad = (n: number) => String(n).padStart(2, "0");
  const [start, end] = [mins(from), mins(to)];
  const out: { hour: string; minutes: string[] }[] = [];
  for (let h = Math.floor(start / 60); h <= Math.floor(end / 60); h++) {
    const minutes = [0, 15, 30, 45].filter((m) => h * 60 + m >= start && h * 60 + m <= end).map(pad);
    if (h * 60 + (start % 60) === start && !minutes.includes(pad(start % 60))) minutes.unshift(pad(start % 60));
    if (minutes.length) out.push({ hour: pad(h), minutes });
  }
  return out;
}

/** The first moment at or after `from` inside the campaign's sending days and hours: when its first email can really go. */
export function firstSendAt(from: Date, s: Hours): Date {
  if (s.days.length === 0) return from;
  const [y, m, d] = utcToZoned(from, s.timezone).split("T")[0].split("-").map(Number);
  for (let k = 0; k < 8; k++) {
    const day = new Date(Date.UTC(y, m - 1, d + k));
    if (!s.days.includes(day.getUTCDay())) continue;
    const ymd = day.toISOString().slice(0, 10);
    const open = zonedToUtc(`${ymd}T${s.from}`, s.timezone);
    const close = zonedToUtc(`${ymd}T${s.to}`, s.timezone);
    if (from < close) return from > open ? from : open;
  }
  return from;
}
