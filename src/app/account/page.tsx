import { requireUser } from "@/lib/auth";
import { changePassword, logout } from "@/app/auth-actions";
import { AuthForm } from "@/components/AuthForm";

export default async function AccountPage() {
  const u = await requireUser();
  return (
    <div className="flex max-w-md flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
        <p className="text-sm text-muted">{u.email} · {u.role === "admin" ? "admin" : "client access"}</p>
      </header>
      <section className="card flex flex-col gap-3 p-5">
        <h2 className="font-semibold">Change password</h2>
        <AuthForm
          action={changePassword}
          submit="Change password"
          fields={[
            { name: "current", label: "Current password", type: "password", autoComplete: "current-password" },
            { name: "password", label: "New password (10+ characters)", type: "password", autoComplete: "new-password" },
            { name: "confirm", label: "New password again", type: "password", autoComplete: "new-password" },
          ]}
        />
      </section>
      <form action={logout}><button className="btn">Sign out</button></form>
    </div>
  );
}
