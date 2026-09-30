"use server";

import { redirect } from "next/navigation";
import { get, run, logActivity } from "@/lib/db";
import { endSession, hashPassword, requireUser, startSession, verifyPassword } from "@/lib/auth";

const MIN_PASSWORD = 10;

export async function login(_: string | null, form: FormData): Promise<string | null> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const u = await get<{ id: number; password_hash: string | null }>("SELECT id, password_hash FROM users WHERE email = ?", email);
  // Same message whatever went wrong, so the form doesn't reveal which emails have accounts.
  if (!u || !(await verifyPassword(password, u.password_hash))) return "That email and password don't match.";
  await run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", u.id);
  await startSession(u.id);
  redirect("/");
}

export async function logout() {
  await endSession();
  redirect("/login");
}

/**
 * First-time setup: creates the admin (ADMIN_EMAIL) with the chosen password. Needs SETUP_TOKEN, and only
 * works while no admin has a password, so the public URL can't be used to claim the account.
 */
export async function setupAdmin(_: string | null, form: FormData): Promise<string | null> {
  const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const token = process.env.SETUP_TOKEN ?? "";
  if (!adminEmail || token.length < 16) return "Setup isn't configured (ADMIN_EMAIL and SETUP_TOKEN).";
  const existing = await get<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND password_hash IS NOT NULL");
  if (existing) return "Setup has already been done. Sign in instead.";
  if (String(form.get("token") ?? "") !== token) return "That setup code isn't right.";
  if (String(form.get("email") ?? "").trim().toLowerCase() !== adminEmail) return "Use the admin email this app was set up for.";
  const password = String(form.get("password") ?? "");
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password !== String(form.get("confirm") ?? "")) return "The two passwords don't match.";
  const hash = await hashPassword(password);
  const r = await run(
    `INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
    adminEmail, hash,
  );
  await logActivity(null, "users", `Admin account ${adminEmail} set up`);
  await startSession(r.id);
  redirect("/");
}

export async function changePassword(_: string | null, form: FormData): Promise<string | null> {
  const u = await requireUser();
  const row = await get<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = ?", u.id);
  if (!(await verifyPassword(String(form.get("current") ?? ""), row?.password_hash ?? null))) return "Your current password isn't right.";
  const password = String(form.get("password") ?? "");
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password !== String(form.get("confirm") ?? "")) return "The two new passwords don't match.";
  await run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), u.id);
  return "Password changed.";
}
