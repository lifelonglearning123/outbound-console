# Outbound Console

A local control room for cold email sent through Instantly, for several clients at once.
The AI writes each email and you approve it, Instantly sends it, and replies come back here.
Interested replies go to the client's GHL. Decisions and design are in `PLAN.md`.
The Instantly API notes are in `docs/instantly-api.md`.

## Setup

1. `npm install` (behind the corporate proxy: `$env:NODE_OPTIONS="--use-system-ca"` first)
2. Create `.env.local`:
   ```
   OPENAI_API_KEY=sk-...
   OPENAI_MODEL=gpt-5.5
   SYNC_MINUTES=3
   ```
3. `npm run app:install` adds a Desktop shortcut and a Startup entry, so the sync runs from Windows login.
4. Open the console, click **+ Add** under Clients, and paste the client's Instantly API v2 key.
   Create the key inside that client's workspace with the `all:all` scope.

Day to day, use the Desktop shortcut. The first start builds the app, which takes about a minute.
It runs on http://127.0.0.1:3480. Stop it with Start Menu → Outbound Console → Stop.

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
$env:INSTANTLY_BASE_URL="http://127.0.0.1:3471/api/v2"; $env:DATA_DIR="C:\temp\oc-test"; npm run dev
```
The mock accepts any key. It "sends" one email per sync, and every third lead replies.

## Check on the first real client

These points were built from Instantly's docs and tested only against the mock:
- API access needs a plan that includes API v2. Third-party sources say Hypergrowth or above.
- `{{subject_1}}`-style custom variables must fill into the step copy. Send one test lead to yourself first.
- Follow-up steps have an empty subject so they go out as replies in the same thread.
- Timezones must come from Instantly's fixed list. UK time is `Europe/Isle_of_Man`, because `Europe/London` isn't in it.
- Schedule days assume "0" = Sunday.
