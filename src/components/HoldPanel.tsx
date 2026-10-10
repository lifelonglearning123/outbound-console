"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { abandonRelease, finishRelease, retryRelease, startRelease } from "@/app/campaigns/actions";
import type { HoldStatus } from "@/lib/hold";

/** Campaign-page panel for a sequence with a hold: shows what's held and walks through releasing it. */
export function HoldPanel({
  campaignId,
  clientId,
  status,
  stepProblems,
}: {
  campaignId: number;
  clientId: number;
  status: HoldStatus;
  stepProblems: Record<number, string[]>; // problems per "release up to" option
}) {
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const options = Array.from({ length: status.total - status.live }, (_, i) => status.live + i + 1);
  const [upTo, setUpTo] = useState(options.at(-1) ?? status.total);
  const s = status;

  if (!s.releaseTo) {
    const problems = stepProblems[upTo] ?? [];
    return (
      <section className="card flex flex-col gap-3 border-wait/40 p-4">
        <div>
          <h3 className="font-semibold">
            On hold after step {s.live}
            <span className="ml-2 text-sm font-normal text-muted">
              {s.total > s.live ? `steps ${s.live + 1}–${s.total} waiting` : "no held steps yet"}
            </span>
          </h3>
          <p className="text-sm text-muted">
            Leads get {s.live === 1 ? "step 1" : `steps 1–${s.live}`} and then wait. {s.waitingOnHold} leads are still in play and will get the next emails when you release the hold
            (leads who replied, bounced or unsubscribed won&apos;t).
          </p>
        </div>
        {s.total === s.live ? (
          <p className="text-sm">Add the next emails to the sequence below (Edit sequence), then release them here.</p>
        ) : (
          <form
            action={(form) =>
              start(async () => {
                try {
                  await startRelease(campaignId, form);
                  setMessage("");
                } catch (e) {
                  setMessage((e as Error).message);
                }
              })
            }
            className="flex flex-wrap items-center gap-2"
          >
            <label className="text-sm">Release up to</label>
            <select name="up_to" className="field" style={{ width: "auto" }} value={upTo} onChange={(e) => setUpTo(Number(e.target.value))}>
              {options.map((n) => (
                <option key={n} value={n}>step {n}{n === s.total ? " (all)" : ""}</option>
              ))}
            </select>
            <button className="btn-go" disabled={pending || problems.length > 0}>
              {pending ? "Starting…" : "Write the next emails"}
            </button>
            {problems.length > 0 && <span className="text-sm text-wait">Finish first: {problems.join("; ")}</span>}
          </form>
        )}
        {message && <p className="text-sm text-bad">{message}</p>}
      </section>
    );
  }

  const ready = !s.writing && !s.review && !s.failed;
  return (
    <section className="card flex flex-col gap-3 border-wait/40 p-4">
      <div>
        <h3 className="font-semibold">Releasing the hold: steps {s.live + 1}–{s.releaseTo}</h3>
        <p className="text-sm text-muted">Nothing changes in Instantly until you apply it.</p>
      </div>
      <ol className="flex flex-col gap-1 text-sm">
        <li>
          1. Writing the next emails:{" "}
          {s.writing ? <span className="text-info">{s.writing} to go…</span> : <span className="text-go">done</span>}
          {s.failed > 0 && (
            <span className="ml-2 text-bad">
              {s.failed} failed{" "}
              <button className="underline" onClick={() => start(() => retryRelease(campaignId))}>retry</button>
            </span>
          )}
        </li>
        <li>
          2. Your review:{" "}
          {s.review ? (
            <Link className="text-wait underline" href={`/clients/${clientId}/campaigns/${campaignId}/approve`}>{s.review} ready to send</Link>
          ) : (
            <span className="text-go">done</span>
          )}
          <span className="text-muted"> · {s.approved} approved · {s.rejected} rejected (they&apos;ll be removed from the campaign)</span>
        </li>
        <li>
          3. Apply: pause the campaign, give each approved lead its new emails, add the steps, resume sending.
        </li>
      </ol>
      <div className="flex items-center gap-2">
        <button
          className="btn-go"
          disabled={!ready || pending}
          onClick={() => start(async () => setMessage(await finishRelease(campaignId)))}
        >
          {pending ? "Applying…" : "Apply to Instantly"}
        </button>
        <button className="btn" disabled={pending} onClick={() => start(() => abandonRelease(campaignId))}>
          Cancel release
        </button>
      </div>
      <p className="text-xs text-muted">
        Instantly times each new step from when the previous one was sent, so leads whose last email went out a while ago get the next one
        straight away (within your daily cap and sending hours).
      </p>
      {message && <p className="text-sm">{message}</p>}
    </section>
  );
}
