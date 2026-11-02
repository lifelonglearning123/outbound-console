import { cancelSchedule, resumeCampaign, scheduleCampaign } from "@/app/campaigns/actions";
import type { Campaign } from "@/lib/campaigns";
import { nowMs } from "@/lib/format";
import { firstSendAt, startLabel, utcToZoned, zoneLabel } from "@/lib/startTime";
import { SchedulePicker } from "@/components/SchedulePicker";
import { SubmitButton } from "@/components/SubmitButton";

const n = (v: number) => v.toLocaleString("en-GB");

/** Pick when a campaign that hasn't started will start: beside its main button. */
export function ScheduleButton({ c }: { c: Campaign }) {
  return <SchedulePicker action={scheduleCampaign.bind(null, c.id)} hours={c.schedule} now={nowMs()} label="Schedule" submit="Schedule" />;
}

/** A scheduled campaign: when it starts, who will go, and how to change that. Also says why a scheduled start didn't happen. */
export function ScheduleBanner({ c, approved, needApproving, handedOver }: { c: Campaign; approved: number; needApproving: number; handedOver: number }) {
  if (c.start_problem) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 border-bad/40 bg-bad-soft/40 p-4 text-sm">
        <p>This campaign didn&apos;t start as scheduled: {c.start_problem}</p>
        <form action={cancelSchedule.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Dismissing…">Dismiss</SubmitButton></form>
      </div>
    );
  }
  if (!c.start_at) return null;
  const at = new Date(c.start_at);
  const tz = c.schedule.timezone;
  const first = firstSendAt(at, c.schedule);
  const ready = approved + handedOver;
  return (
    <section className="card flex flex-wrap items-center justify-between gap-4 border-info/30 bg-info-soft/50 p-4 text-sm">
      <div className="max-w-2xl">
        <h3 className="font-semibold">Scheduled to start {startLabel(at, tz)}, {zoneLabel(tz)} time</h3>
        <p className="mt-0.5 text-muted">
          {first.getTime() !== at.getTime()
            ? `That's outside its sending days or hours, so the first emails go ${startLabel(first, tz)}. `
            : "It can begin up to 30 minutes after this. "}
          {ready > 0 ? `${n(ready)} approved ${ready === 1 ? "contact is" : "contacts are"} ready to go.` : "No contacts are approved yet, so it won't start unless some are by then."}
          {needApproving > 0 && ` ${n(needApproving)} more still ${needApproving === 1 ? "needs" : "need"} approving; anyone not approved in time can go after it starts.`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SchedulePicker action={scheduleCampaign.bind(null, c.id)} hours={c.schedule} now={nowMs()} value={utcToZoned(at, tz)} label="Change time" submit="Save time" />
        <form action={cancelSchedule.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Cancelling…">Cancel schedule</SubmitButton></form>
        {ready > 0 && <form action={resumeCampaign.bind(null, c.id)}><SubmitButton className="btn" pendingLabel="Starting…">Start now</SubmitButton></form>}
      </div>
    </section>
  );
}
