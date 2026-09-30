import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { all, get } from "./db";

// Logins. An admin sees and controls everything. A client user sees only the clients linked to them
// (user_clients) and can run their campaigns, but never sees API keys, client settings or other clients.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = "oc_session";
const MAX_AGE = 30 * 86400; // seconds

export type User = { id: number; email: string; role: "admin" | "client"; clientIds: number[] };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored?.startsWith("scrypt:")) return false;
  const [, salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET must be set (32+ random characters)");
  return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export async function startSession(userId: number) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + MAX_AGE * 1000 })).toString("base64url");
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

function readSession(value: string | undefined): number | null {
  if (!value) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  const good = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof uid === "number" && exp > Date.now() ? uid : null;
  } catch {
    return null;
  }
}

/** The signed-in user for this request, or null. */
export const currentUser = cache(async (): Promise<User | null> => {
  const uid = readSession((await cookies()).get(COOKIE)?.value);
  if (!uid) return null;
  const u = await get<{ id: number; email: string; role: string }>("SELECT id, email, role FROM users WHERE id = ?", uid);
  if (!u) return null;
  const clientIds = (await all<{ client_id: number }>("SELECT client_id FROM user_clients WHERE user_id = ?", u.id)).map((r) => r.client_id);
  return { id: u.id, email: u.email, role: u.role === "admin" ? "admin" : "client", clientIds };
});

/** Pages and actions: the signed-in user, or off to the login page. */
export async function requireUser(): Promise<User> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

export async function requireAdmin(): Promise<User> {
  const u = await requireUser();
  // "Not found" rather than "forbidden", so a client login can't tell what exists.
  if (u.role !== "admin") notFound();
  return u;
}

export const canSeeClient = (u: User, clientId: number) => u.role === "admin" || u.clientIds.includes(clientId);

/** Throws unless the user may work with this client. */
export async function requireClientAccess(clientId: number | null | undefined): Promise<User> {
  const u = await requireUser();
  if (!clientId || !canSeeClient(u, Number(clientId))) notFound();
  return u;
}

/**
 * SQL filter for "clients this user can see", for pages that list across clients.
 * Returns "" for admins; otherwise an "AND <col> IN (...)" clause with the ids inlined (they're integers).
 */
export function clientScope(u: User, col = "client_id"): string {
  if (u.role === "admin") return "";
  const ids = u.clientIds.filter((n) => Number.isInteger(n));
  return ids.length ? `AND ${col} IN (${ids.join(",")})` : "AND FALSE";
}

// Resolve the client behind the ids server actions receive, so every action can check access.
export async function clientOfCampaign(id: number) {
  return (await get<{ client_id: number }>("SELECT client_id FROM campaigns WHERE id = ?", id))?.client_id;
}
export async function clientOfLead(id: number) {
  return (await get<{ client_id: number }>("SELECT client_id FROM leads WHERE id = ?", id))?.client_id;
}
export async function clientOfDraft(id: number) {
  return (await get<{ client_id: number }>("SELECT l.client_id FROM drafts d JOIN leads l ON l.id = d.lead_id WHERE d.id = ?", id))?.client_id;
}
export async function clientOfEmail(id: string) {
  return (await get<{ client_id: number }>("SELECT client_id FROM emails WHERE id = ?", id))?.client_id;
}
