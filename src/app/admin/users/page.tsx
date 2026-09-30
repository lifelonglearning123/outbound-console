import { all } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { listClients } from "@/lib/clients";
import { ago } from "@/lib/format";
import { createUser, deleteUser, resetPassword, setUserClients } from "./actions";
import { CreateUserClients } from "@/components/CreateUserClients";

export default async function UsersPage() {
  const me = await requireAdmin();
  const clients = await listClients();
  const users = await all<{ id: number; email: string; role: string; last_login_at: string | null; client_ids: string | null }>(
    `SELECT u.id, u.email, u.role, u.last_login_at, string_agg(uc.client_id::text, ',') client_ids
     FROM users u LEFT JOIN user_clients uc ON uc.user_id = u.id GROUP BY u.id ORDER BY u.role, u.email`,
  );

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted">
          Admins see everything. Client logins see only the clients ticked for them, and can review, approve and run those campaigns, but never
          see API keys, client settings or other clients.
        </p>
      </header>

      <section className="card overflow-hidden">
        <table className="w-full text-sm [&_td]:px-3 [&_th]:px-3">
          <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="py-2 font-medium">Login</th><th className="font-medium">Access</th><th className="font-medium">Last sign-in</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const ids = (u.client_ids ?? "").split(",").filter(Boolean).map(Number);
              return (
                <tr key={u.id} className="border-t border-line align-top">
                  <td className="py-2">
                    <div className="font-medium">{u.email}</div>
                    <div className="text-xs text-muted">{u.role === "admin" ? "Admin" : "Client login"}{u.id === me.id ? " · you" : ""}</div>
                  </td>
                  <td className="py-2">
                    {u.role === "admin" ? (
                      <span className="text-muted">All clients</span>
                    ) : (
                      <form action={setUserClients.bind(null, u.id)} className="flex flex-wrap items-center gap-2">
                        {clients.map((c) => (
                          <label key={c.id} className="flex items-center gap-1">
                            <input type="checkbox" name="clients" value={c.id} defaultChecked={ids.includes(c.id)} /> {c.name}
                          </label>
                        ))}
                        <button className="btn text-xs">Save</button>
                      </form>
                    )}
                  </td>
                  <td className="py-2 text-xs text-muted">{u.last_login_at ? ago(u.last_login_at) : "never"}</td>
                  <td className="py-2">
                    {u.id !== me.id && (
                      <div className="flex flex-col items-end gap-1">
                        <form action={resetPassword.bind(null, u.id)} className="flex gap-1">
                          <input name="password" type="password" placeholder="New password" autoComplete="new-password" className="field w-36 py-1 text-xs" required minLength={10} />
                          <button className="btn text-xs">Reset</button>
                        </form>
                        <form action={deleteUser.bind(null, u.id)}><button className="text-xs text-bad hover:underline">Remove login</button></form>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card flex flex-col gap-3 p-5">
        <h2 className="font-semibold">Add a login</h2>
        <CreateUserClients clients={clients.map((c) => ({ id: c.id, name: c.name }))} action={createUser} />
      </section>
    </div>
  );
}
