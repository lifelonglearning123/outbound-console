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
  mailboxesHref,
  b,
  waitingFor,
}: {
  campaignId: number;
  contactsHref: string;
  /** The client's Mailboxes page, where the problem companies list is. */
  mailboxesHref: string;
  /** The campaign hasn't started: what approved contacts are waiting for, in words. There's nothing to press here. */
  waitingFor?: string;
  b: {
    approved: number;
    sendable: number;
    held: { gateway: string; label: string; n: number }[];
    blocked: number;
    waiting: { campaign: string; campaignId: number | null; n: number; why: "sequence" | "gap" }[];
    gapDays: number;
    stopped: number;
    nomail: number;
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
            {waitingFor
              ? waitingFor
              : b.sendable > 0
                ? `${n(b.sendable)} can go now.`
                : "None of them can go right now. Here's why, and what to do about it."}
          </p>
        </div>
        {!waitingFor && (
          <button type="button" className="btn-go" disabled={b.sendable === 0 || pending} onClick={send} aria-busy={pending}>
            {pending ? "Sending…" : b.sendable > 0 ? `Send ${n(b.sendable)} now` : "Nothing to send yet"}
          </button>
        )}
      </div>

      {(b.held.length > 0 || b.blocked > 0 || b.waiting.length > 0 || b.stopped > 0 || b.nomail > 0) && (
        <ul className="flex flex-col gap-1.5 border-t border-line pt-3">
          {b.held.map((h) => (
            <li key={h.gateway} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="num font-medium text-wait">{n(h.n)}</span> held: their company uses {h.label}, and this campaign has paused sending to {h.label}.
              </span>
              <Link href={`${contactsHref}#mail-filters`} className="text-xs underline">Change in Mail filters</Link>
            </li>
          ))}
          {b.blocked > 0 && (
            <li className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="num font-medium text-wait">{n(b.blocked)}</span> held: their company is on the problem companies list, because
                other addresses there bounced.
              </span>
              <Link href={`${mailboxesHref}#problem-companies`} className="text-xs underline">Problem companies</Link>
            </li>
          )}
          {b.waiting.map((w) => (
            <li key={`${w.why}-${w.campaign}`} className="flex flex-wrap items-baseline justify-between gap-2">
              {w.why === "gap" ? (
                <span>
                  <span className="num font-medium text-info">{n(w.n)}</span> waiting: &quot;{w.campaign}&quot; emailed them in the last {b.gapDays} days, and
                  nobody gets two campaigns that close together. They go out by themselves once the {b.gapDays} days are up. The gap can be changed in
                  Settings.
                </span>
              ) : (
                <span>
                  <span className="num font-medium text-info">{n(w.n)}</span> waiting: still in &quot;{w.campaign}&quot;, and nobody gets two campaigns
                  at once. A paused campaign still holds its contacts. They go out by themselves once that sequence ends, or as soon as you take them
                  out of it.
                </span>
              )}
              {w.why === "sequence" && w.campaignId && (
                <Link href={`${contactsHref.replace(/\/campaigns\/\d+\//, `/campaigns/${w.campaignId}/`)}?status=in_sequence#people`} className="text-xs underline">
                  Take them out of &quot;{w.campaign}&quot;
                </Link>
              )}
            </li>
          ))}
          {b.stopped > 0 && (
            <li>
              <span className="num font-medium text-bad">{n(b.stopped)}</span> won&apos;t be sent: they replied, bounced or unsubscribed in another
              campaign. The next send sets them aside.
            </li>
          )}
          {b.nomail > 0 && (
            <li>
              <span className="num font-medium text-bad">{n(b.nomail)}</span> won&apos;t be sent: their domain has no mail server, so the email
              could only bounce. The next send sets them aside.
            </li>
          )}
        </ul>
      )}

      {message && <p className="rounded-md border border-line bg-paper px-3 py-2" role="status">{message}</p>}
    </section>
  );
}
