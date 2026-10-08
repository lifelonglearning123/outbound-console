"use client";

/** A form submit button that asks before it goes ahead. For actions that can't be undone. */
export function ConfirmButton({ message, className = "btn", children }: { message: string; className?: string; children: React.ReactNode }) {
  return (
    <button
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
