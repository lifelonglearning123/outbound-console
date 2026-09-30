import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { NOW_TEXT, SCHEMA } from "./schema";

export { NOW_TEXT };

// Postgres (Neon) access. Queries are written with ? or @name placeholders and translated to $n here,
// so SQL reads the same everywhere. Inside tx(), every query automatically uses the transaction's connection.

type Row = Record<string, unknown>;
type Params = unknown[];

// Counts and sums come back from Postgres as int8/numeric strings; the app wants numbers.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

declare global {
  var __outbound_pool: pg.Pool | undefined;
  var __outbound_schema: Promise<void> | undefined;
}

function pool(): pg.Pool {
  if (!globalThis.__outbound_pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    globalThis.__outbound_pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 10_000 });
  }
  return globalThis.__outbound_pool;
}

const txClient = new AsyncLocalStorage<pg.PoolClient>();

async function ensureSchema() {
  globalThis.__outbound_schema ??= pool()
    .query(SCHEMA)
    .then(() => undefined)
    .catch((e) => {
      globalThis.__outbound_schema = undefined;
      throw e;
    });
  return globalThis.__outbound_schema;
}

/**
 * Turn ? / @name placeholders into $1, $2… (outside quoted strings), and SQLite's datetime('now') into
 * Postgres. A single plain-object argument means named parameters.
 */
export function translate(sql: string, params: Params): { text: string; values: unknown[] } {
  const first = params[0];
  const named = params.length === 1 && first !== null && typeof first === "object" && !Array.isArray(first) && !(first instanceof Date);
  const obj = named ? (first as Record<string, unknown>) : null;
  const values: unknown[] = [];
  const index = new Map<string, number>();
  let out = "";
  let inQuote = false;
  let positional = 0;
  const src = sql.replace(/datetime\('now'\)/g, NOW_TEXT);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'") {
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (!inQuote && ch === "?" && !obj) {
      values.push(params[positional++]);
      out += `$${values.length}`;
      continue;
    }
    if (!inQuote && ch === "@" && obj && /[A-Za-z_]/.test(src[i + 1] ?? "")) {
      const name = /^@([A-Za-z_]\w*)/.exec(src.slice(i))![1];
      if (!index.has(name)) {
        values.push(obj[name] ?? null);
        index.set(name, values.length);
      }
      out += `$${index.get(name)}`;
      i += name.length;
      continue;
    }
    out += ch;
  }
  // Callers read the new row's id from run(); Postgres only returns it when asked.
  if (/^\s*INSERT\b/i.test(out) && !/\bRETURNING\b/i.test(out)) out += " RETURNING *";
  return { text: out, values: values.map((v) => (v === undefined ? null : v)) };
}

async function query(sql: string, params: Params): Promise<pg.QueryResult> {
  await ensureSchema();
  const { text, values } = translate(sql, params);
  return (txClient.getStore() ?? pool()).query(text, values);
}

export async function all<T = Row>(sql: string, ...params: Params): Promise<T[]> {
  return (await query(sql, params)).rows as T[];
}

export async function get<T = Row>(sql: string, ...params: Params): Promise<T | undefined> {
  return (await query(sql, params)).rows[0] as T | undefined;
}

export async function run(sql: string, ...params: Params): Promise<{ changes: number; id: number }> {
  const r = await query(sql, params);
  return { changes: r.rowCount ?? 0, id: Number(r.rows[0]?.id ?? 0) };
}

/** Run fn in a transaction; queries inside it (at any depth) use the same connection. Nested calls join the outer one. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txClient.getStore()) return fn();
  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await txClient.run(client, fn);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function logActivity(clientId: number | null, kind: string, message: string) {
  await run("INSERT INTO activity (client_id, kind, message) VALUES (?, ?, ?)", clientId, kind, message);
}

export async function getSetting(key: string, fallback: string): Promise<string> {
  return (await get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key))?.value ?? fallback;
}

export async function setSetting(key: string, value: string) {
  await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", key, value);
}

/**
 * A lock that works across serverless instances, so only one sync or writer runs at a time. It expires
 * after ttlMs in case a run dies without releasing it.
 */
export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
  const now = Date.now();
  const got = await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE settings.value::bigint < ?`,
    `lock_${name}`, String(now + ttlMs), now,
  );
  if (!got.changes) return undefined;
  try {
    return await fn();
  } finally {
    await run("DELETE FROM settings WHERE key = ?", `lock_${name}`);
  }
}
