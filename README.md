# Outbound Console

A control room for cold email sent through Instantly, for several clients at once, hosted on Vercel with a
Neon Postgres database. The AI writes each email and you approve it, Instantly sends it, and replies come back
here and into each client's GHL. Decisions and design are in `PLAN.md`; Instantly API notes in `docs/instantly-api.md`.

## Logins

- **Admin** (`ADMIN_EMAIL`): every client, API keys, client settings, and the **Users** page.
- **Client logins**: only the clients ticked for them on **Users**. They can see stats and reports, read the inbox,
  approve emails and run campaigns, but never see API keys, client settings or other clients.

The admin's first password is set once at `/setup` with the `SETUP_TOKEN`; that page closes afterwards.
Client logins are added on **Users** with a first password, which they can change under **Account**.

## Deploying (Vercel + Neon)

1. Create a Neon project and put its **pooled** connection string in `.env.local` as `DATABASE_URL`.
   `.env.local` also needs the values listed in `.env.example`.
2. Copy the data from the old local app (once): stop the local app, then `npm run db:migrate`.
3. `vercel link` in this folder (Pro plan: the sync runs every 3 minutes via `vercel.json`).
4. `npm run vercel:env` copies the settings from `.env.local` into the Vercel project.
5. `vercel --prod`, then open `/setup` on the new URL to set the admin password.

`SECRETS_KEY` encrypts the Instantly and GHL keys in the database. Keep it the same everywhere and never change it
once there's data, or the stored keys can't be read.

## Local development

`npm install` (behind the corporate proxy: `$env:NODE_OPTIONS="--use-system-ca"` first), then `npm run dev`
(http://127.0.0.1:3480). With `DATABASE_URL` pointing at Neon, local runs share the live data; use a Neon branch
for experiments. Set `SYNC_DISABLED=1` to stop the local server syncing alongside Vercel.

## Several clients in one Instantly workspace

A client can have its own workspace, which is simplest: one key per client and no tag.
Or several clients can share one workspace, with one Instantly tag per client:

1. In Instantly, create a tag per client, e.g. "Signal" and "Fruitful", or let the app create them.
   Put each client's mailboxes under that client's tag. Also tag any campaigns the client already has.
2. In the console, give each client the same API key and its own tag (Settings → Instantly tag).

Each client then sees and controls only the mailboxes and campaigns carrying its tag. Its inbox and
timeline only show emails from its own mailboxes, and campaigns created here are tagged automatically.
If two clients share a workspace and either has no tag, both stop syncing until they're tagged,
so one client never sees another's data.
Still shared across the workspace: the blocklist (an unsubscribe applies to every client) and Instantly's lead database.

## The flow

1. **Campaign.** Describe what each step should do. The app creates the campaign in Instantly as a draft,
   with the steps set to `{{subject_1}}`, `{{body_1}}`, `{{body_2}}` and so on.
2. **Leads.** Upload a CSV or pull GHL contacts by tag, then click **Write**. gpt-5.5 writes every step
   for every lead, using the lead's fields and the client brief.
3. **Approvals.** Approve, edit, rewrite or reject each lead's emails. Keys: `j`/`k` move, `a` approve,
   `r` reject. **Send approved to Instantly** uploads only the approved leads, with their text in the
   custom variables above.
4. **Launch.** Use the button on the campaign page. After that, pause and resume, daily caps, sending
   windows and mailboxes can all be changed from the campaign page.
5. **Sync.** Every few minutes the app pulls sent emails, replies, queued sends, stats and mailbox health.
   It tags replies with AI, sends interested ones to GHL, blocklists unsubscribe requests, and pauses
   mailboxes that break the health rules set on the Mailboxes page.

## Testing without a real workspace

```
npm run mock:instantly
$env:INSTANTLY_BASE_URL="http://127.0.0.1:3471/api/v2"; $env:DATABASE_URL="<a Neon test branch>"; npm run dev
```
The mock accepts any key. It "sends" one email per sync, and every third lead replies.

## Check on the first real client

These points were built from Instantly's docs and tested only against the mock:
- API access needs a plan that includes API v2. Third-party sources say Hypergrowth or above.
- `{{subject_1}}`-style custom variables must fill into the step copy. Send one test lead to yourself first.
- Follow-up steps have an empty subject so they go out as replies in the same thread.
- Timezones must come from Instantly's fixed list. UK time is `Europe/Isle_of_Man`, because `Europe/London` isn't in it.
- Schedule days assume "0" = Sunday.
