import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { get } from "@/lib/db";
import { login } from "@/app/auth-actions";
import { AuthForm } from "@/components/AuthForm";

export default async function LoginPage() {
  if (await currentUser()) redirect("/");
  const needsSetup = !(await get<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND password_hash IS NOT NULL"));
  return (
    <div className="mx-auto mt-24 w-full max-w-sm">
      <div className="card flex flex-col gap-5 p-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Outbound Console</h1>
          <p className="text-sm text-muted">Sign in to continue.</p>
        </div>
        <AuthForm
          action={login}
          submit="Sign in"
          fields={[
            { name: "email", label: "Email", type: "email", autoComplete: "username" },
            { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
          ]}
        />
        {needsSetup && (
          <p className="text-xs text-muted">
            First time here? <Link href="/setup" className="underline">Set up the admin account</Link>.
          </p>
        )}
      </div>
    </div>
  );
}
