"use client";

import { useActionState } from "react";

type Field = { name: string; label: string; type?: string; autoComplete?: string; defaultValue?: string };

/** Small form for sign-in, setup and password changes; shows the action's message underneath. */
export function AuthForm({
  action,
  fields,
  submit,
}: {
  action: (prev: string | null, form: FormData) => Promise<string | null>;
  fields: Field[];
  submit: string;
}) {
  const [message, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      {fields.map((f) => (
        <div key={f.name}>
          <label className="label" htmlFor={f.name}>{f.label}</label>
          <input
            id={f.name}
            name={f.name}
            type={f.type ?? "text"}
            autoComplete={f.autoComplete}
            defaultValue={f.defaultValue}
            required
            className="field"
          />
        </div>
      ))}
      <button className="btn-go justify-center" disabled={pending}>{pending ? "…" : submit}</button>
      {message && <p className={`text-sm ${message.endsWith("changed.") ? "text-go" : "text-bad"}`}>{message}</p>}
    </form>
  );
}
