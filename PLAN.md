# Outbound Console — plan

A local control room for cold email sent through Instantly, for several clients at once.
Fruitful is the first client.

## Decisions (locked 2026-09-29)

| Topic | Decision |
|---|---|
| Users | Chao + team only. No client logins, no white-label. |
| Instantly | One workspace + API v2 key per client, stored in the app. |
| Leads | CSV upload, or pulled from the client's GHL sub-account. |
| Personalisation | CSV / GHL fields + a per-client brief (offer, ICP, tone, proof, CTA). No scraping. |
| Approval | Every AI-written email is approved, edited or rejected before anything reaches Instantly. |
| Control | Pause/resume campaigns, daily caps, sending windows, sequences, mailbox health with auto-pause. |
| Visuals | Live send timeline, funnel per client, unified reply inbox, lead journey. |
| Replies | Interested replies -> contact + opportunity in the client's GHL. |
| Hosting | Local only: Next.js + SQLite (`node:sqlite`) on 127.0.0.1:3480. |
| Sync | Background worker that starts with Windows and polls Instantly (no webhooks). |
| Scale | 1-5 clients, under 500 emails/day. |
| AI | Kimi (kimi-k2.6) via `KIMI_API_KEY`; OpenAI gpt-5.5 if only `OPENAI_API_KEY` is set. Switched 2026-10-08. |

## How approval works with Instantly

Instantly has no approval step, so the app holds the copy:

1. Each campaign the app creates in Instantly has steps whose subject/body are only placeholders:
   `{{subject_1}}` / `{{body_1}}`, `{{subject_2}}` / `{{body_2}}`, ...
2. The app writes every step for every lead with gpt-5.5 and puts them in the approval queue.
3. When all of a lead's steps are approved, the lead is uploaded to the Instantly campaign with the
   approved text in its custom variables. Instantly then sends, rotates mailboxes and handles warmup.
4. Nothing unapproved can be sent, because an unapproved lead never exists in Instantly.

## Build order

1. **Clients** — add/edit a client (Instantly key, GHL location + token + pipeline/stage, brief).
   "Check key" calls Instantly's workspace endpoint and shows the workspace name, mailboxes and campaigns.
2. **Leads + AI + approval** — CSV upload with column mapping, GHL contact pull (by tag),
   dedupe, AI drafting per step, approval queue (approve / edit / reject, bulk, keyboard).
3. **Campaigns + push** — create/link an Instantly campaign with the placeholder sequence,
   schedule (days, window, timezone), daily cap, mailboxes; push approved leads; pause/resume.
4. **Sync worker + visuals** — Windows-startup worker polls campaigns, emails, accounts and analytics;
   send timeline, per-client funnel, reply inbox, lead journey.
5. **Safety + GHL** — mailbox health (bounce/warmup score thresholds -> auto-pause),
   AI interest tagging of replies, interested -> GHL contact + opportunity + note.

## Status (2026-09-29)

All five build steps are done and tested end to end against `scripts/mock-instantly.mjs` with real gpt-5.5.
Not yet tested against a real Instantly workspace or real GHL; see README "Check on the first real client".

## Running it

```
npm run dev        # http://127.0.0.1:3480
```

Secrets live in the local SQLite file (`data/`) and `.env.local`; both are git-ignored.
