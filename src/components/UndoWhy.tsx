import Link from "next/link";
import { undoActivity } from "@/app/mailboxes/actions";
import { SubmitButton } from "./SubmitButton";
import { mailboxAnchor } from "./MailboxBoard";

/** Beside an automatic action: Undo (when it can be reversed and hasn't been) and Why? (its mailbox or company). */
export function UndoWhy({ a }: { a: { id: number; client_id: number | null; subject: string | null; undo: string | null; undone_at: string | null } }) {
  if (!a.client_id || !a.subject) return null;
  const why = a.subject.includes("@")
    ? `/clients/${a.client_id}/mailboxes#${mailboxAnchor(a.subject)}`
    : `/clients/${a.client_id}/mailboxes#problem-companies`;
  return (
    <span className="flex shrink-0 items-center gap-2">
      <Link href={why} className="text-xs underline">Why?</Link>
      {a.undo && !a.undone_at && (
        <form action={undoActivity.bind(null, a.id)}>
          <SubmitButton className="btn text-xs" pendingLabel="Undoing…">Undo</SubmitButton>
        </form>
      )}
      {a.undone_at && <span className="text-xs text-muted">undone</span>}
    </span>
  );
}
