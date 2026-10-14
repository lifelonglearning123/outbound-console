"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pushCampaign } from "@/app/leads/actions";
import { describePush } from "@/lib/pushResult";

const n = (v: number) => v.toLocaleString("en-GB");

/**
 * Approved contacts that haven't gone to the sender yet, split the way the send splits them. The button only
 * promises what it can do; everyone it can't send says why and where that's resolved.
 */
export function SendPanel({
  campaignId,
  contactsHref,
  b,
}: {
  campaignId: number;
  contactsHref: string;
  b: {
    approved: number;
    sendable: number;
    held: { gateway: string; label: string; n: number }[];
    waiting: { campaign: string; n: number }[];
    stopped: number;
  };
}) {
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  if (b.approved === 0 && !message) return null;

  const send = () =>
    start(async () => {
      setMessage(describePush(await pushCampaign(campaignId)));
      router.refresh();
    });

  return (
    <section className="card flex flex-col gap-3 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{n(b.approved)} approved, not yet with the sender</h2>
          <p className="text-muted">
            {b.sendable > 0
              ? `${n(b.sendable)} can go now.`
              : "None of them can go right now. Here's why, and what to do about it."}
          </p>
        </div>
        <button type="button" className="btn-go" disabled={b.sendable === 0 || pending} onClick={send} aria-busy={pending}>
          {pending ? "Sending…" : b.sendable > 0 ? `Send ${n(b.sendable)} now` : "Nothing to send yet"}
        </button>
      </div>

      {(b.held.length > 0 || b.waiting.length > 0 || b.stopped > 0) && (
        <ul className="flex flex-col gap-1.5 border-t border-line pt-3">
          {b.held.map((h) => (
            <li key={h.gateway} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="num font-medium text-wait">{n(h.n)}</span> held: their company uses {h.label}, and this campaign has paused sending to {h.label}.
              </span>
              <Link href={`${contactsHref}#mail-filters`} className="text-xs underline">Change in Mail filters</Link>
            </li>
          ))}
          {b.waiting.map((w) => (
            <li key={w.campaign}>
              <span className="num font-medium text-info">{n(w.n)}</span> waiting: still being emailed by &quot;{w.campaign}&quot;. They go out
              automatically once that sequence ends, so nobody gets two campaigns at once.
            </li>
          ))}
          {b.stopped > 0 && (
            <li>
              <span className="num font-medium text-bad">{n(b.stopped)}</span> won&apos;t be sent: they replied, bounced or unsubscribed in another
              campaign. The next send sets them aside.
            </li>
          )}
        </ul>
      )}

      {message && <p className="rounded-md border border-line bg-paper px-3 py-2" role="status">{message}</p>}
    </section>
  );
}
