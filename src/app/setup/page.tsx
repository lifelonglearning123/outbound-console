import { redirect } from "next/navigation";
import { get } from "@/lib/db";
import { setupAdmin } from "@/app/auth-actions";
import { AuthForm } from "@/components/AuthForm";

// One-time: the admin chooses their password. Needs the SETUP_TOKEN set in Vercel, and closes once done.
export default async function SetupPage() {
  if (await get<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND password_hash IS NOT NULL")) redirect("/login");
  return (
    <div className="mx-auto mt-24 w-full max-w-sm">
      <div className="card flex flex-col gap-5 p-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Set up the admin account</h1>
          <p className="text-sm text-muted">Enter the setup code from the app&apos;s settings and choose your password. This page closes once it&apos;s done.</p>
        </div>
        <AuthForm
          action={setupAdmin}
          submit="Create admin account"
          fields={[
            { name: "token", label: "Setup code", type: "password", autoComplete: "off" },
            { name: "email", label: "Admin email", type: "email", autoComplete: "username" },
            { name: "password", label: "Password (10+ characters)", type: "password", autoComplete: "new-password" },
            { name: "confirm", label: "Password again", type: "password", autoComplete: "new-password" },
          ]}
        />
      </div>
    </div>
  );
}
