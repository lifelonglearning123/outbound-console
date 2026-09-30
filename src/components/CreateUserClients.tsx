"use client";

import { useActionState, useState } from "react";

/** The "add a login" form: email, role, first password, and (for client logins) which clients they see. */
export function CreateUserClients({
  clients,
  action,
}: {
  clients: { id: number; name: string }[];
  action: (prev: string | null, form: FormData) => Promise<string | null>;
}) {
  const [message, formAction, pending] = useActionState(action, null);
  const [role, setRole] = useState("client");
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label" htmlFor="nu-email">Email</label>
          <input id="nu-email" name="email" type="email" required className="field" autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="nu-role">Access</label>
          <select id="nu-role" name="role" className="field" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="client">Client login (chosen clients only)</option>
            <option value="admin">Admin (everything)</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="nu-password">First password (10+ characters)</label>
          <input id="nu-password" name="password" type="password" required minLength={10} className="field" autoComplete="new-password" />
        </div>
      </div>
      {role === "client" && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="label mb-0">Can see</span>
          {clients.map((c) => (
            <label key={c.id} className="flex items-center gap-1">
              <input type="checkbox" name="clients" value={c.id} /> {c.name}
            </label>
          ))}
        </div>
      )}
      <button className="btn-go self-start" disabled={pending}>{pending ? "Adding…" : "Add login"}</button>
      {message && <p className={`text-sm ${message.startsWith("Added") ? "text-go" : "text-bad"}`}>{message}</p>}
    </form>
  );
}
