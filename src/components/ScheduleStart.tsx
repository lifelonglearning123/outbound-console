import { cancelSchedule, resumeCampaign, scheduleCampaign } from "@/app/campaigns/actions";
import type { Campaign } from "@/lib/campaigns";
import { nowMs } from "@/lib/format";
import { firstSendAt, startLabel, utcToZoned, zonedToUtc, zoneLabel } from "@/lib/startTime";
import { SubmitButton } from "@/components/SubmitButton";

const n = (v: number) => v.toLocaleString("en-GB");

function TimeForm({ c, value, label }: { c: Campaign; value: string; label: string }) {
  return (
    <form action={scheduleCampaign.bind(null, c.id)} className="flex flex-wrap items-center gap-2">
      <input
        type="datetime-local"
        name="start_at"
        required
        defaultValue={value}
        min={utcToZoned(new Date(nowMs()), c.schedule.timezone)}
        aria-label={`Start time, ${zoneLabel(c.schedule.timezone)} time`}
        className="field w-auto"
      />
      <span className="text-xs text-muted">{zoneLabel(c.schedule.timezone)} time</span>
      <SubmitButton className="btn" pendingLabel="Saving…">{label}</SubmitButton>
    </form>
  );
}

/** Pick when a campaign that hasn't started will start: beside "Start sending". */
export function ScheduleButton({ c }: { c: Campaign }) {
  // The next sending day after today, at the start of its sending hours.
  const tomorrow = new Date(nowMs() + 86400_000);
  const dayStart = `${utcToZoned(tomorrow, c.schedule.timezone).split("T")[0]}T00:00`;
  const suggestion = firstSendAt(zonedToUtc(dayStart, c.schedule.timezone), c.schedule);
  return (
    <details className="relative">
      <summary className="btn cursor-pointer list-none [&::-webkit-details-marker]:hidden">Schedule</summary>
      <div className="card absolute right-0 z-10 mt-1 flex w-max max-w-sm flex-col gap-2 p-3 text-sm shadow-sm">
        <p className="text-xs text-muted">
          Pick when sending starts. Approved contacts wait here until then, and are checked again as they go. Emails then go out over the following days,
          within the campaign&apos;s daily limit and sending hours.
        </p>
        <TimeForm c={c} value={utcToZoned(suggestion, c.schedule.timezone)} label="Schedule" />
      </div>
    </details>
  );
}

/** A scheduled campaign: when it starts, who will go, and how to change that. Also says why a scheduled start didn't happen. */
export function ScheduleBanner({ c, approved, needApproving, handedOver }: { c: Campaign; approved: number; needApproving: number; handedOver: number }) {
  if (c.start_problem) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 border-bad/40 bg-bad-soft/40 p-3 text-sm">
        <p>This campaign didn&apos;t start as scheduled: {c.start_problem}</p>
        <form action={cancelSchedule.bind(null, c.id)}><SubmitButton className="btn text-xs" pendingLabel="Dismissing…">Dismiss</SubmitButton></form>
      </div>
    );
  }
  if (!c.start_at) return null;
  const at = new Date(c.start_at);
  const tz = c.schedule.timezone;
  const first = firstSendAt(at, c.schedule);
  const ready = approved + handedOver;
  return (
    <section className="card flex flex-col gap-3 border-info/40 bg-info-soft/40 p-4 text-sm">
      <div>
        <h3 className="font-medium">Scheduled to start {startLabel(at, tz)} ({zoneLabel(tz)} time)</h3>
        <p className="text-muted">
          {first.getTime() !== at.getTime()
            ? `That's outside its sending days or hours, so the first emails go ${startLabel(first, tz)}. `
            : "It can start up to 30 minutes after this. "}
          {ready > 0 ? `${n(ready)} approved ${ready === 1 ? "contact is" : "contacts are"} ready to go.` : "No contacts are approved yet, so it won't start unless some are by then."}
          {needApproving > 0 && ` ${n(needApproving)} more still need approving; anyone not approved in time can go after it starts.`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <TimeForm c={c} value={utcToZoned(at, tz)} label="Change time" />
        <form action={cancelSchedule.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Cancelling…">Cancel schedule</SubmitButton></form>
        <form action={resumeCampaign.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Starting…">Start now</SubmitButton></form>
      </div>
    </section>
  );
}
