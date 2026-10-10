"use client";

import { useFormStatus } from "react-dom";

/** A form's submit button that shows it's working and can't be double-clicked while the action runs. */
export function SubmitButton({ className = "btn", pendingLabel = "Working…", children }: { className?: string; pendingLabel?: string; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
