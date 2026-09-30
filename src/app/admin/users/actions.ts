"use server";

import { revalidatePath } from "next/cache";
import { get, run, tx, logActivity } from "@/lib/db";
import { hashPassword, requireAdmin } from "@/lib/auth";

const MIN_PASSWORD = 10;

/** Add a login. Client users are tied to the clients ticked; they change the password after first sign-in. */
export async function createUser(_: string | null, form: FormData): Promise<string | null> {
  const me = await requireAdmin();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const role = form.get("role") === "admin" ? "admin" : "client";
  const password = String(form.get("password") ?? "");
  const clientIds = form.getAll("clients").map(Number).filter(Boolean);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email.";
  if (password.length < MIN_PASSWORD) return `Use a first password of at least ${MIN_PASSWORD} characters.`;
  if (role === "client" && clientIds.length === 0) return "Tick at least one client this person can see.";
  if (await get("SELECT id FROM users WHERE email = ?", email)) return "There's already a login for that email.";
  await tx(async () => {
    const u = await run("INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)", email, await hashPassword(password), role);
    for (const c of clientIds) await run("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)", u.id, c);
  });
  await logActivity(null, "users", `${me.email} added ${role} login ${email}`);
  revalidatePath("/admin/users");
  return `Added ${email}. Give them the first password; they can change it under Account.`;
}

export async function setUserClients(userId: number, form: FormData) {
  await requireAdmin();
  const clientIds = form.getAll("clients").map(Number).filter(Boolean);
  await tx(async () => {
    await run("DELETE FROM user_clients WHERE user_id = ?", userId);
    for (const c of clientIds) await run("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)", userId, c);
  });
  revalidatePath("/admin/users");
}

export async function resetPassword(userId: number, form: FormData) {
  const me = await requireAdmin();
  const password = String(form.get("password") ?? "");
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
  await run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), userId);
  await logActivity(null, "users", `${me.email} reset the password for user ${userId}`);
  revalidatePath("/admin/users");
}

export async function deleteUser(userId: number) {
  const me = await requireAdmin();
  if (userId === me.id) throw new Error("You can't remove your own login.");
  await run("DELETE FROM users WHERE id = ?", userId);
  await logActivity(null, "users", `${me.email} removed user ${userId}`);
  revalidatePath("/admin/users");
}
