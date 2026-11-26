"use client";

import { useEffect, useRef, useState } from "react";
import { SubmitButton } from "./SubmitButton";

/**
 * Pause sending. When contacts have been handed to the sender but not emailed yet, ask what to do with them: a paused
 * campaign still holds them, so no other campaign can email them until it finishes.
 */
export function PauseButton({ unsent, keep, release }: { unsent: number; keep: (form: FormData) => void; release: (form: FormData) => void }) {
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

  if (unsent === 0) {
    return <form action={keep}><SubmitButton className="btn" pendingLabel="Pausing…">Pause sending</SubmitButton></form>;
  }
  const n = unsent.toLocaleString("en-GB");
  return (
    <div ref={box} className="relative">
      <button type="button" className="btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>Pause sending</button>
      {open && (
        <div role="dialog" aria-label="Pause sending" className="popover absolute right-0 z-20 mt-2 flex w-[24rem] max-w-[calc(100vw-2rem)] flex-col gap-3 p-4 text-left text-sm">
          <div>
            <h3 className="font-semibold">{n} {unsent === 1 ? "contact hasn't" : "contacts haven't"} been emailed yet</h3>
            <p className="mt-1 text-muted">
              They&apos;re with the sender, waiting their turn. If they stay here, no other campaign can email them until this one finishes.
              Releasing them takes them out of this campaign, so another one can use them. Nobody who has been emailed is affected.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <form action={release} onSubmit={() => setOpen(false)}>
              <SubmitButton className="btn-go w-full" pendingLabel="Releasing…">Pause and release {n}</SubmitButton>
            </form>
            <form action={keep} onSubmit={() => setOpen(false)}>
              <SubmitButton className="btn w-full" pendingLabel="Pausing…">Pause, keep them here</SubmitButton>
            </form>
            <button type="button" className="btn-quiet" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
