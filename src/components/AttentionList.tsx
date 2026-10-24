import Link from "next/link";
import type { Attention } from "@/lib/attention";
import { bringBackMailboxes, warmupOn } from "@/app/mailboxes/actions";
import { SubmitButton } from "./SubmitButton";

const TONE = {
  bad: "border-bad/30 bg-bad-soft text-bad",
  wait: "border-wait/30 bg-wait-soft text-wait",
  go: "border-go/30 bg-go-soft text-go",
  info: "border-info/30 bg-info-soft text-info",
};

/** Attention items as coloured rows, each with its link or its one-click action. */
export function AttentionList({ clientId, items }: { clientId: number; items: Attention[] }) {
  return (
    <div className="flex flex-col gap-1.5" role="status">
      {items.map((a, i) => (
        <div key={i} className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${TONE[a.tone]}`}>
          <span className="min-w-0 flex-1 break-words">{a.text}</span>
          {a.action?.kind === "bring_back" ? (
            <form action={bringBackMailboxes.bind(null, clientId, a.action.emails)} className="shrink-0">
              <SubmitButton className="btn-go" pendingLabel="Bringing back…">
                Bring back {a.action.emails.length === 1 ? "the mailbox" : `${a.action.emails.length} mailboxes`}
              </SubmitButton>
            </form>
          ) : a.action?.kind === "warmup_on" ? (
            <form action={warmupOn.bind(null, clientId, a.action.email)} className="shrink-0">
              <SubmitButton className="btn" pendingLabel="Turning on…">Turn warmup on</SubmitButton>
            </form>
          ) : a.href ? (
            <Link href={a.href} className="shrink-0 font-medium underline">{a.link ?? "Open"}</Link>
          ) : null}
        </div>
      ))}
    </div>
  );
}
