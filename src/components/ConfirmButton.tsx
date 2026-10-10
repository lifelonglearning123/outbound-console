"use client";

import { useFormStatus } from "react-dom";

/** A form submit button that asks before it goes ahead, then shows it's working. For actions that can't be undone. */
export function ConfirmButton({ message, className = "btn", children }: { message: string; className?: string; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {pending ? "Working…" : children}
    </button>
  );
}
