import "server-only";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), "data");

type Row = Record<string, unknown>;
type Param = string | number | bigint | null | Uint8Array;
type Params = Param[] | [Record<string, Param>];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  instantly_api_key TEXT,
  instantly_workspace_id TEXT,
  instantly_workspace_name TEXT,
  instantly_tag_id TEXT,           -- shared-workspace mode: only resources with this Instantly tag belong to the client
  instantly_tag_label TEXT,
  key_status TEXT,                 -- ok | error | null (unchecked)
  key_message TEXT,
  key_checked_at TEXT,
  ghl_location_id TEXT,
  ghl_token TEXT,
  ghl_pipeline_id TEXT,
  ghl_stage_id TEXT,
  brief TEXT NOT NULL DEFAULT '{}', -- JSON: offer, icp, tone, proof, cta, sender_name, signature, avoid
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  instantly_campaign_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | active | paused | completed | error (mirrors Instantly)
  instantly_status INTEGER,
  steps TEXT NOT NULL DEFAULT '[]',     -- JSON: [{ delay_days, instructions }]
  schedule TEXT NOT NULL DEFAULT '{}',  -- JSON: { days: number[], from: "09:00", to: "17:00", timezone }
  daily_limit INTEGER NOT NULL DEFAULT 30,
  accounts TEXT NOT NULL DEFAULT '[]',  -- JSON: sending mailbox emails
  stop_on_reply INTEGER NOT NULL DEFAULT 1,
  managed INTEGER NOT NULL DEFAULT 1,   -- 1 = built here with approval placeholders; 0 = created in Instantly directly
  not_sending TEXT,                     -- Instantly's reason an active campaign is idle
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  title TEXT,
  phone TEXT,
  website TEXT,
  fields TEXT NOT NULL DEFAULT '{}',    -- JSON: every other column / GHL custom field
  source TEXT NOT NULL,                 -- csv | ghl
  source_ref TEXT,                      -- file name or GHL tag
  ghl_contact_id TEXT,
  stage TEXT NOT NULL DEFAULT 'new',    -- new | drafting | review | approved | rejected | pushed | error
  stage_message TEXT,
  instantly_lead_id TEXT,
  instantly_status INTEGER,
  interest_status INTEGER,
  step_reached INTEGER,                 -- last sequence step Instantly sent (1-based)
  last_sent_at TEXT,
  last_open_at TEXT,
  last_reply_at TEXT,
  pushed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, email)
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,                -- 1-based sequence step
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  edited INTEGER NOT NULL DEFAULT 0,
  flags TEXT,                           -- writer's notes for the reviewer, e.g. "no first name"
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lead_id, step)
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  email TEXT NOT NULL,
  status INTEGER,
  warmup_status INTEGER,
  warmup_score REAL,
  daily_limit INTEGER,
  sent_today INTEGER,
  bounced_7d INTEGER,
  sent_7d INTEGER,
  auto_paused_at TEXT,
  auto_paused_reason TEXT,
  last_synced_at TEXT,
  UNIQUE (client_id, email)
);

-- One row per email Instantly sent or received. Drives the timeline, journey and inbox.
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,                  -- Instantly email id
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  lead_id INTEGER REFERENCES leads(id),
  lead_email TEXT,
  direction TEXT NOT NULL,              -- out | in
  step INTEGER,
  account_email TEXT,
  subject TEXT,
  body_text TEXT,
  thread_id TEXT,
  sent_at TEXT NOT NULL,
  is_unread INTEGER NOT NULL DEFAULT 0,
  interest TEXT,                        -- AI tag for inbound: interested | not_now | not_interested | unsubscribe | ooo | other
  interest_reason TEXT,
  ghl_pushed_at TEXT,
  ghl_message TEXT
);
CREATE INDEX IF NOT EXISTS emails_client_time ON emails(client_id, sent_at);
CREATE INDEX IF NOT EXISTS emails_lead ON emails(lead_id);

CREATE TABLE IF NOT EXISTS daily_stats (
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  date TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0,
  clicked INTEGER NOT NULL DEFAULT 0,
  bounced INTEGER NOT NULL DEFAULT 0,
  opportunities INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, date)
);

CREATE TABLE IF NOT EXISTS mailbox_daily (
  client_id INTEGER NOT NULL REFERENCES clients(id),
  email TEXT NOT NULL,
  date TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  bounced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, email, date)
);

-- Emails Instantly has queued but not sent yet (replaced on every sync).
CREATE TABLE IF NOT EXISTS scheduled (
  id TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  lead_email TEXT,
  account_email TEXT,
  step INTEGER,
  subject TEXT,
  due_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  kind TEXT NOT NULL,                   -- sync | push | pause | resume | auto_pause | ghl | error | ...
  message TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to an existing file.
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["clients", "instantly_tag_id", "TEXT"],
  ["clients", "instantly_tag_label", "TEXT"],
];

function migrate(db: DatabaseSync) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function open(): DatabaseSync {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, "outbound.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

declare global {
   
  var __outbound_db: DatabaseSync | undefined;
}

export function db(): DatabaseSync {
  globalThis.__outbound_db ??= open();
  return globalThis.__outbound_db;
}

// Shared named-parameter objects may carry keys a query does not use.
function prep(sql: string) {
  const stmt = db().prepare(sql);
  stmt.setAllowUnknownNamedParameters(true);
  return stmt;
}

// node:sqlite rows have a null prototype, which React refuses to pass to client components; copy to plain objects.
export function all<T = Row>(sql: string, ...params: Params): T[] {
  return prep(sql).all(...(params as Param[])).map((r) => ({ ...r })) as T[];
}

export function get<T = Row>(sql: string, ...params: Params): T | undefined {
  const r = prep(sql).get(...(params as Param[]));
  return (r ? { ...r } : undefined) as T | undefined;
}

export function run(sql: string, ...params: Params) {
  const r = prep(sql).run(...(params as Param[]));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function logActivity(clientId: number | null, kind: string, message: string) {
  run("INSERT INTO activity (client_id, kind, message) VALUES (?, ?, ?)", clientId, kind, message);
}

export function getSetting(key: string, fallback: string): string {
  return get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}
