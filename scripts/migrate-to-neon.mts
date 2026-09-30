// One-time copy of the local SQLite database (data/outbound.db) into the Neon Postgres database.
//
//   node --env-file=.env.local scripts/migrate-to-neon.mts
//
// Needs DATABASE_URL and SECRETS_KEY in .env.local. Stop the local app first so nothing changes mid-copy.
// Refuses to run if Neon already has clients, unless you pass --force (which wipes the Neon tables first).
// Instantly and GHL keys are encrypted on the way in, exactly as the app stores them.
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { SCHEMA } from "../src/lib/schema.ts";

const SQLITE = process.env.SQLITE_PATH ?? "data/outbound.db";
const force = process.argv.includes("--force");

// Parents before children, so foreign keys are satisfied.
const TABLES = [
  "clients", "campaigns", "leads", "drafts", "mailboxes", "emails", "daily_stats", "mailbox_daily",
  "scheduled", "step_stats", "meetings", "ghl_contacts", "activity", "settings",
];
const WITH_ID = new Set(["clients", "campaigns", "leads", "drafts", "mailboxes", "activity"]);

function encrypt(plain: string | null): string | null {
  if (!plain || plain.startsWith("enc:v1:")) return plain;
  const key = createHash("sha256").update(process.env.SECRETS_KEY!).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(":");
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing from .env.local");
  if (!process.env.SECRETS_KEY) throw new Error("SECRETS_KEY is missing from .env.local");
  const lite = new DatabaseSync(SQLITE, { readOnly: true });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  try {
    await db.query(SCHEMA);
    const existing = Number((await db.query("SELECT COUNT(*) n FROM clients")).rows[0].n);
    if (existing && !force) throw new Error(`Neon already has ${existing} clients. Re-run with --force to replace everything.`);

    await db.query("BEGIN");
    if (force) await db.query(`TRUNCATE ${[...TABLES].reverse().join(", ")} RESTART IDENTITY CASCADE`);

    for (const table of TABLES) {
      const pgCols = new Set(
        (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [table])).rows.map((r) => r.column_name),
      );
      let rows = lite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      if (table === "settings") rows = rows.filter((r) => !String(r.key).startsWith("lock_"));
      if (table === "clients") {
        rows = rows.map((r) => ({ ...r, instantly_api_key: encrypt(r.instantly_api_key as string), ghl_token: encrypt(r.ghl_token as string) }));
      }
      if (rows.length === 0) {
        console.log(`${table}: 0`);
        continue;
      }
      // Only columns both databases have (the SQLite file may predate some).
      const cols = Object.keys(rows[0]).filter((c) => pgCols.has(c));
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const values: unknown[] = [];
        const tuples = chunk.map((r) => `(${cols.map((c) => { values.push(r[c] ?? null); return `$${values.length}`; }).join(",")})`);
        await db.query(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${tuples.join(",")}`, values);
      }
      if (WITH_ID.has(table)) {
        await db.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table}))`);
      }
      console.log(`${table}: ${rows.length}`);
    }
    await db.query("COMMIT");
    console.log("Done. Your data is in Neon.");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
