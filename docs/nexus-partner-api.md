# Nexus partner API

Nexus (the CRM portal) runs outreach campaigns that write a bespoke email for each person. When a campaign's
emails go through the outbound console, the split is:

- **Nexus owns the people and the words**: the audience, what is known about each person, the AI-written copy,
  review, reading each reply and deciding what happens next, and the record in GoHighLevel.
- **The console owns delivery**: checking addresses, mail filters, problem companies, mailboxes and their health,
  the Instantly campaign, and the analysis afterwards.

A Nexus campaign is an ordinary console campaign underneath (`source = 'nexus'`), so People, verification, mail
filters, mailboxes, statistics and the inbox all work on it. What the console does **not** do for these campaigns:
write copy (the writer skips them), ask for approval of copy (Nexus approves it), or classify replies and act on
them (Nexus does). Its UI says so on the campaign.

## Calls

Every call: `Authorization: Bearer <NEXUS_PARTNER_SECRET>`, JSON in and out, under `/api/partner/nexus`.
Errors are `{ "error": "...", "code"?: "..." }` with a 4xx/5xx status. Without `NEXUS_PARTNER_SECRET` set the
API answers 503.

Every call names the sub-account as `locationId` (the GoHighLevel location id; query string on GET, body
otherwise). It resolves to the console client with that `ghl_location_id` that is not archived: none is
`404 code "no_client"`, more than one is `409 code "ambiguous"`.

A Nexus campaign is addressed by Nexus's own campaign id, `{nexusId}` in the path, kept on
`campaigns.nexus_campaign_id`. A campaign that doesn't exist yet is `404 code "no_campaign"`.

### GET /status?locationId=

Whether the sub-account can send through the console.

```json
{
  "connected": true,
  "client": { "id": 3, "name": "Tradeworthy" },
  "instantly": { "ok": true, "message": "6 mailboxes, 4 campaigns" },
  "mailboxes": [{ "email": "dan@tw-mail.co", "healthy": true, "ready": true, "note": "" }],
  "verification": { "credits": 1840, "problem": null }
}
```

### PUT /campaigns/{nexusId}

Create or update the campaign, in the console and in Instantly, and make sure Instantly reports its events to Nexus.

```json
{
  "locationId": "7rjp…",
  "name": "Autumn roof quotes",
  "steps": [{ "delayDays": 3 }, { "delayDays": 4 }, { "delayDays": 0 }],
  "schedule": { "days": [1, 2, 3, 4, 5], "from": "09:00", "to": "17:00", "timezone": "Europe/London" },
  "dailyLimit": 60,
  "accounts": null,
  "webhook": { "url": "https://crm.example.com/api/partner/console/webhook?campaign=…", "token": "…" }
}
```

- `steps`: one per email the Instantly sequence sends, in order. `delayDays` is Instantly's: days to wait after this
  step before the next one; the last is 0. A campaign whose follow-ups Nexus writes on the day has one step.
- `schedule.days`: 0 is Sunday. A time zone Instantly doesn't accept falls back to the console's UK default.
- `accounts`: the mailboxes to send from, or `null` for every mailbox that can send now.
- `webhook`: one Instantly webhook, `event_type: "all_events"`, limited to this campaign, delivering to `url` with the
  header `Authorization: Bearer <token>`. Replaced when the url or token changes.
- Once any lead has reached Instantly, the number of steps can't change (`409 code "steps_locked"`).

→ `{ "campaignId": 41, "instantlyCampaignId": "…", "status": "draft" }`

### POST /campaigns/{nexusId}/leads

Hand people over for checking. At most 1000 per call; call again for more.

```json
{ "locationId": "…", "leads": [{ "email": "scott@x.co", "firstName": "Scott", "lastName": "M", "company": "…",
  "title": null, "phone": null, "website": null, "ghlContactId": "ooOV…" }] }
```

The usual import rules apply (`importLeads`): someone who replied, bounced, unsubscribed or was invalid in any of the
client's campaigns is skipped; an address checked before keeps its result. New addresses queue for verification and
mail servers are looked up. A passed address waits at stage `new`; nothing is written by the console.

→ `{ "added": 12, "updated": 0, "skippedExisting": 0, "skippedDoNotContact": 1, "skippedInvalid": 0, "reused": 3 }`

### GET /campaigns/{nexusId}/leads?locationId=&page=1

Where each person stands. 500 a page.

```json
{
  "leads": [{
    "email": "scott@x.co", "ghlContactId": "ooOV…",
    "verification": "verified", "verdict": "ok", "reason": null, "mailServer": "Microsoft",
    "stage": "new", "instantlyStatus": null, "pushedAt": null, "lastSentAt": null, "lastReplyAt": null,
    "stepReached": null, "lastReply": null
  }],
  "total": 520, "page": 1, "pageSize": 500, "checking": 31
}
```

`verdict`, the first that applies:

| verdict | meaning |
|---|---|
| `removed` | taken out in the console by a person, or stopped through this API |
| `do_not_contact` | replied, bounced or unsubscribed in another of the client's campaigns, including ones run outside the console |
| `invalid` | the address doesn't exist |
| `no_mail_server` | the domain has no mail server |
| `problem_company` | the company is on the client's problem companies list |
| `held_filter` | behind a mail filter this campaign holds back (still sendable later) |
| `checking` | not checked yet |
| `unconfirmed` | the domain accepts every address, so it couldn't be confirmed (sendable) |
| `ok` | verified |

`reason` says it in words. `lastReply` is the newest reply the console has stored (`{ at, subject, text }`), from
its regular sync; Nexus normally learns of replies from the webhook first.

### PUT /campaigns/{nexusId}/copy

The approved words for people whose address passed. Each person's steps must cover every live step.

```json
{ "locationId": "…", "leads": [{ "email": "scott@x.co", "steps": [
  { "step": 1, "subject": "your roof quote", "text": "Hi Scott,\n\n…" },
  { "step": 2, "subject": "", "text": "…" } ] }] }
```

Stored as approved drafts (plain text, line breaks kept) and the lead moves to `approved`.

→ `{ "results": [{ "email": "scott@x.co", "ok": true }, { "email": "x@y.co", "ok": false, "problem": "not_checked" }] }`

Problems: `unknown`, `not_checked`, `not_sendable` (verdict other than ok/unconfirmed/held_filter), `incomplete`,
`already_sent`.

### POST /campaigns/{nexusId}/push

Send every approved person to Instantly, by the console's rules (mail filters held, problem companies, someone mid-
sequence in another campaign waits, domains without mail servers set aside). Starts the Instantly campaign if it
isn't running.

→ `{ "pushed": 10, "skipped": 0, "held": 1, "blocked": 0, "waiting": 0, "stopped": 0, "nomail": 0 }`

### POST /campaigns/{nexusId}/status

`{ "locationId": "…", "action": "pause" | "resume" }` → `{ "status": "paused" }`

### POST /campaigns/{nexusId}/leads/stop

Take one person out: removed from the Instantly campaign if they reached it, and marked `removed` here.

`{ "locationId": "…", "email": "scott@x.co", "reason": "Asked to stop", "block": true }` → `{ "ok": true }`

`block` adds the address to the Instantly block list as well (an opt-out).

### POST /campaigns/{nexusId}/reply

Send an email in the person's existing thread, from the mailbox that has been writing to them: Nexus's answer to a
reply, or a follow-up Nexus wrote on the day.

`{ "locationId": "…", "email": "scott@x.co", "subject": null, "text": "Thanks Scott, …" }`

The thread is read live from Instantly (the newest email with this lead in this campaign). `subject` defaults to
`Re: ` and the thread's subject.

→ `{ "id": "…", "eaccount": "dan@tw-mail.co", "threadId": "…" }`
`404 code "no_thread"` when nothing has been sent to them yet; `409 code "mailbox_resting"` when that mailbox is
resting (try again later rather than switch address mid-thread).

### POST /signin

A one-time link that signs a Nexus user into the console, as a client login for this sub-account's client only,
opening the campaign's People page (or the client's page without `nexusId`). The login is created on first use.

`{ "locationId": "…", "email": "dan@x.co", "nexusId": "…" }` → `{ "url": "https://console…/partner-signin?token=…" }`

The link works once, within two minutes.

## Events (Instantly → Nexus)

Instantly posts every event of the campaign to the webhook url with the bearer token. Nexus acts on
`reply_received`, `auto_reply_received`, `email_sent`, `email_bounced` and `lead_unsubscribed`, and ignores the rest.
Field names are Instantly's: `event_type`, `campaign_id`, `lead_email`, `email_account`, `step` (1-based), `email_id`,
`email_subject`, `email_text`, `reply_subject`, `reply_text`, `reply_html`, `timestamp`.
