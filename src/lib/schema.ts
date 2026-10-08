// The database tables. Kept free of app imports so scripts/migrate-to-neon.mts can use it too.

/** SQLite's datetime('now') text format, kept so stored timestamps stay comparable with migrated rows. */
export const NOW_TEXT = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  instantly_api_key TEXT,               -- encrypted (see secrets.ts)
  instantly_workspace_id TEXT,
  instantly_workspace_name TEXT,
  instantly_tag_id TEXT,                -- shared-workspace mode: only resources with this Instantly tag belong to the client
  instantly_tag_label TEXT,
  key_status TEXT,
  key_message TEXT,
  key_checked_at TEXT,
  ghl_location_id TEXT,
  ghl_token TEXT,                       -- encrypted
  ghl_pipeline_id TEXT,
  ghl_stage_id TEXT,
  ghl_meeting_calendars TEXT,           -- JSON array of calendar ids; empty = every calendar
  ghl_meeting_stage TEXT,               -- "pipelineId:stageId" that counts as a booked meeting
  ghl_log_since TEXT,                   -- emails from this time on are copied into GHL conversations
  brief TEXT NOT NULL DEFAULT '{}',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  instantly_campaign_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  instantly_status INTEGER,
  steps TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL DEFAULT '{}',
  daily_limit INTEGER NOT NULL DEFAULT 30,
  accounts TEXT NOT NULL DEFAULT '[]',
  stop_on_reply INTEGER NOT NULL DEFAULT 1,
  managed INTEGER NOT NULL DEFAULT 1,
  not_sending TEXT,
  hold_after INTEGER,
  release_to INTEGER,
  release_resume INTEGER,
  ghl_tag TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  title TEXT,
  phone TEXT,
  website TEXT,
  fields TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  source_ref TEXT,
  ghl_contact_id TEXT,
  stage TEXT NOT NULL DEFAULT 'new',
  stage_message TEXT,
  instantly_lead_id TEXT,
  instantly_status INTEGER,
  interest_status INTEGER,
  step_reached INTEGER,
  last_sent_at TEXT,
  last_open_at TEXT,
  last_reply_at TEXT,
  pushed_at TEXT,
  ghl_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT},
  UNIQUE (client_id, email)
);
-- Instantly email verification: queued | pending | verified | catch_all | invalid (null = never checked).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS verification TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_at TEXT;
-- GHL follow-up to verification: queued_tag | queued_remove | queued_delete | done (null = nothing done yet).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ghl_verification_tag TEXT;

CREATE TABLE IF NOT EXISTS drafts (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  edited INTEGER NOT NULL DEFAULT 0,
  flags TEXT,
  format TEXT NOT NULL DEFAULT 'text',
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT},
  UNIQUE (lead_id, step)
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id SERIAL PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  lead_email TEXT,
  direction TEXT NOT NULL,
  step INTEGER,
  account_email TEXT,
  subject TEXT,
  body_text TEXT,
  thread_id TEXT,
  sent_at TEXT NOT NULL,
  is_unread INTEGER NOT NULL DEFAULT 0,
  interest TEXT,
  interest_reason TEXT,
  ghl_pushed_at TEXT,
  ghl_message TEXT,
  ghl_logged_at TEXT,
  ghl_log_error TEXT
);
CREATE INDEX IF NOT EXISTS emails_client_time ON emails(client_id, sent_at);
CREATE INDEX IF NOT EXISTS emails_lead ON emails(lead_id);

CREATE TABLE IF NOT EXISTS daily_stats (
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  contacted INTEGER NOT NULL DEFAULT 0,
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
  opened INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, email, date)
);

CREATE TABLE IF NOT EXISTS scheduled (
  id TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_email TEXT,
  account_email TEXT,
  step INTEGER,
  subject TEXT,
  due_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS step_stats (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0,
  opportunities INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, step)
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  booked_at TEXT NOT NULL,
  starts_at TEXT,
  title TEXT,
  status TEXT
);
CREATE INDEX IF NOT EXISTS meetings_client ON meetings(client_id, booked_at);

CREATE TABLE IF NOT EXISTS ghl_contacts (
  client_id INTEGER NOT NULL,
  contact_id TEXT NOT NULL,
  email TEXT,
  PRIMARY KEY (client_id, contact_id)
);

CREATE TABLE IF NOT EXISTS activity (
  id SERIAL PRIMARY KEY,
  client_id INTEGER,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT ${NOW_TEXT}
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Logins. role: admin (everything) | client (only the clients in user_clients; no keys or settings).
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,                    -- null until the person sets it on first login
  role TEXT NOT NULL DEFAULT 'client',
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT},
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_clients (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, client_id)
);
`;
