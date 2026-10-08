# Instantly API v2 — coding reference

Source: https://api.instantly.ai/openapi/api_v2.json (OpenAPI 3.1, fetched 2026-09-29) + developer.instantly.ai pages.
Field names below are copied from the spec. `*` = required. `T|null` = nullable.

## 1. Basics

| Item | Value |
|---|---|
| Base URL | `https://api.instantly.ai` (all paths start `/api/v2/`) |
| Auth | Header `Authorization: Bearer <API_KEY>` |
| Keys | Created in app: Settings → Integrations → API Keys. Shown **once**. Each key has scopes. Multiple keys per workspace allowed. |
| Scope pattern | `<resource>:<read\|create\|update\|delete\|all>` or `all:<action>` / `all:all`. Each endpoint accepts its resource scope, `<resource>:all`, `all:<action>`, or `all:all`. |
| Workspace | Key is bound to one workspace; `GET /api/v2/workspaces/current` returns it. |
| Plan | Docs don't say. Third-party guides + an Instantly feature-request board ("API Access on Growth Plan") say **Hypergrowth ($97/mo) or higher** is needed for API v2; Growth does not include it. Confirm on the target account (a 401/403 on a valid key suggests the plan). |
| v1 | Separate, incompatible. Shares the rate limit with v2. |
| Content type | JSON request/response bodies. |

### Rate limits (workspace-wide, shared across all keys and v1+v2)
- ≤ **100 requests / second** AND ≤ **6,000 requests / minute**. Going over either one → HTTP **429**.
- **`GET /api/v2/emails` (list email) is limited separately to 20 requests / minute.**
- Instantly suggests batching (for example, 100 calls then a 2 s wait). No retry-after header is documented, so back off yourself.

### Pagination (cursor)
- List endpoints return `{ items: [...], next_starting_after?: string }`.
- For the next page, send `starting_after=<next_starting_after>`. When `next_starting_after` is missing, there are no more pages.
- `limit`: integer 1–100 (campaigns, accounts, emails, lead-labels, leads/list).
- The cursor type depends on the endpoint: a UUID (campaigns, emails), `timestamp_created&email` (accounts), a lead `id` (leads/list), or a timestamp (lead-labels).
- Analytics endpoints are not paginated (they return a plain array or object).

### Common enums

**Campaign `status`** (number): `0` Draft · `1` Active · `2` Paused · `3` Completed · `4` Running Subsequences · `-1` Accounts Unhealthy · `-2` Bounce Protect · `-99` Account Suspended

**Campaign `not_sending_status`** (number|null): `1` outside its schedule · `2` waiting for a lead to process · `3` campaign daily limit reached · `4` every sending account has hit its daily limit · `99` error (contact support)

**Lead `status`** (number): `1` Active · `2` Paused · `3` Completed · `-1` Bounced · `-2` Unsubscribed · `-3` Skipped

**Lead `lt_interest_status`** (number; can also be the numeric value of a custom label): `1` Interested · `2` Meeting Booked · `3` Meeting Completed · `4` Won · `0` Out of Office · `-1` Not Interested · `-2` Wrong Person · `-3` Lost · `-4` No Show. A missing or null value means plain "Lead" (no status).

**Lead `verification_status`**: `0` Not verified · `1` Verified · `11` Pending · `12` Pending Verification Job · `-1` Invalid · `-2` Risky · `-3` Catch All · `-4` Job Change

**Lead `enrichment_status`**: `1` Enriched · `11` Pending · `-1` not available · `-2` Error
**Lead `esp_code`**: `0` In Queue · `1` Google · `2` Microsoft · `3` Zoho · `8` AirMail · `9` Yahoo · `10` Yandex · `12` Web.de · `13` Libero.it · `999` Other · `1000` Not Found
**Lead `esg_code`**: `0` In Queue · `1` Barracuda · `2` Mimecast · `3` Proofpoint · `4` Cisco
**Lead `upload_method`**: `manual` · `api` · `website-visitor`

**Account `status`**: `1` Active · `2` Paused · `3` Temporarily paused for maintenance (resumes automatically) · `-1` Connection Error · `-2` Soft Bounce Error · `-3` Sending Error
**Account `warmup_status`**: `1` Active · `0` Paused · `-1` Banned · `-2` Spam Folder Unknown · `-3` Permanent Suspension
**Account `provider_code`**: `1` Custom IMAP/SMTP · `2` Google · `3` Microsoft · `4` AWS · `8` AirMail · `11` Airmail Instant

**Email `ue_type`** (number|null): `1` Sent from campaign · `2` Received · `3` Sent (manual) · `4` Scheduled

---

## 2. Workspace

### GET `/api/v2/workspaces/current` — scope `workspaces:read`
Takes no params. Response: `id`, `name`, `owner`, `timestamp_created`, `timestamp_updated`, `plan_id` (string|null), `plan_id_bundle`, `plan_id_leadfinder`, `plan_id_verification{quantity,product_id,timestamp_updated}`, `plan_id_crm`, `plan_id_website_visitor`, `plan_id_inbox_placement`, `org_logo_url`, `org_client_domain`, `add_unsub_to_block`, `default_opportunity_value`, `scheduled_for_removal_at`.
Use it as the "is this key valid" health check. `plan_id` shows the plan.

---

## 3. Campaigns

### Campaign object (returned by create/get/patch/activate/pause/variables, and in list `items[]`)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | string | |
| `status` | number | enum above (read-only) |
| `not_sending_status` | number\|null | enum above (read-only) |
| `campaign_schedule` | object | see below |
| `sequences` | array | see below |
| `email_list` | string[] | sending account emails |
| `email_tag_list` | string[] | account tag IDs to send from, instead of listing emails |
| `daily_limit` | number\|null | max emails the campaign sends per day |
| `daily_max_leads` | integer\|null (≥0) | max NEW leads contacted per day |
| `stop_on_reply` | bool\|null | stop the sequence for a lead when it replies |
| `stop_on_auto_reply` | bool\|null | |
| `stop_for_company` | bool\|null | stop the whole domain when one lead replies |
| `email_gap` | number\|null | minutes between emails |
| `random_wait_max` | number\|null | minutes |
| `text_only`, `first_email_text_only` | bool\|null | |
| `link_tracking` | bool\|null | |
| `open_tracking` | bool | |
| `prioritize_new_leads` | bool\|null | |
| `match_lead_esp` | bool\|null | |
| `insert_unsubscribe_header` | bool\|null | |
| `allow_risky_contacts`, `disable_bounce_protect` | bool\|null | |
| `is_evergreen` | bool\|null | |
| `pl_value` | number\|null | value per positive lead |
| `auto_variant_select` | `{trigger*: 'reply_rate'\|'click_rate'\|'open_rate'}`\|null | |
| `limit_emails_per_company_override` | `{mode*: 'custom'\|'disabled', daily_limit (≥1), scope: 'per_campaign'\|'across_workspace'}`\|null | |
| `provider_routing_rules` | `[{action:'send'\|'do_not_send', recipient_esp:[], sender_esp:[]}]` | ESP values `all`,`google`,`outlook`,`other` |
| `cc_list`, `bcc_list` | string[] | |
| `core_variables`, `custom_variables` | object\|null | read-only: the campaign's registered variables |
| `owned_by`, `created_by`, `organization`, `ai_sdr_id` | uuid\|null | |
| `timestamp_created`, `timestamp_updated` | string | |

**`campaign_schedule`**
```jsonc
{
  "start_date": "2026-10-01",      // YYYY-MM-DD | null, in the campaign timezone
  "end_date": null,                // YYYY-MM-DD | null
  "schedules": [                   // required, ≥1
    {
      "name": "Weekdays",                           // required
      "timing": { "from": "09:00", "to": "17:00" },  // required, HH:MM 24h (^([01][0-9]|2[0-3]):([0-5][0-9])$)
      "days": { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false }, // required; keys "0".."6", 0 = Sunday (assumed, see uncertainties)
      "timezone": "Europe/Isle_of_Man"             // required, STRICT enum (see below)
    }
  ]
}
```
**Timezone enum gotcha:** `timezone` must be one of 102 fixed values. Many common IANA names are **not** accepted: there is **no `Europe/London`, `America/New_York`, `America/Los_Angeles`, `Europe/Paris` or `UTC`**. Allowed values include:
- UK/GMT: `Europe/Isle_of_Man` (the only London-equivalent zone), `Africa/Abidjan` (GMT, no daylight saving), `Atlantic/Canary`
- CET: `Europe/Belgrade`, `Europe/Sarajevo`, `Africa/Ceuta`, `Arctic/Longyearbyen`
- US: `America/Detroit` (Eastern), `America/Chicago` (Central), `America/Boise` (Mountain), `America/Creston` (Arizona), `America/Dawson` (Pacific-ish), `America/Anchorage`
- Others: `Europe/Helsinki`, `Europe/Bucharest`, `Europe/Istanbul`, `Asia/Dubai`, `Asia/Kolkata`, `Asia/Hong_Kong`, `Australia/Melbourne`, `Australia/Perth`, `Pacific/Auckland`, `Etc/GMT+12` … `Etc/GMT-13`
- The full list is in the spec at `components.schemas.Campaign.properties.campaign_schedule...timezone.enum`. Validate against it before calling.

**`sequences`** — an array, but **only `sequences[0]` is used**. Send exactly one.
```jsonc
"sequences": [{
  "steps": [                                  // required
    {
      "type": "email",                        // required, only value allowed
      "delay": 2,                             // required: wait BEFORE THE NEXT step
      "delay_unit": "days",                   // 'minutes'|'hours'|'days', default 'days'
      "variants": [                           // required, ≥1 (A/B variants)
        { "subject": "Hello {{firstName}}",   // required
          "body": "Hey {{firstName}},<br/><br/>…", // required, HTML; use <br/> for line breaks
          "v_disabled": false }               // optional
      ]
    }
  ]
}]
```
`pre_delay` / `pre_delay_unit` only apply to subsequences.

**Placeholders:** the spec's own examples use `{{firstName}}` in `subject` and `body`. Built-in lead variables are camelCase: `{{firstName}}`, `{{lastName}}`, `{{companyName}}`, `{{jobTitle}}`, `{{website}}`, `{{phone}}`, `{{personalization}}` (these are the `payload` keys on a lead). **Custom variables:** a key sent in a lead's `custom_variables` is stored in `lead.payload.<key>`, and the key is added to the campaign's variables. You use it in copy as `{{<key>}}`, with the key spelled exactly as sent. This is standard Instantly behaviour, but the spec doesn't state it outright; see uncertainties.

### GET `/api/v2/campaigns` — list — scope `campaigns:read`
Query: `limit` (1–100), `starting_after` (uuid cursor), `search` (name), `tag_ids` (comma-separated), `status` (campaign status enum), `exclude_status`, `ai_sales_agent_id`, `include_ai_sales_agent_campaigns` (bool; AI-agent campaigns are excluded by default).
Response: `{ items: Campaign[], next_starting_after }`.

### POST `/api/v2/campaigns` — create — scope `campaigns:create`
Body: `name*`, `campaign_schedule*`, plus any writable Campaign field (`sequences`, `email_list`, `daily_limit`, `stop_on_reply`, `daily_max_leads`, `email_gap`, `random_wait_max`, `text_only`, `link_tracking`, `open_tracking`, `stop_on_auto_reply`, `stop_for_company`, `prioritize_new_leads`, `match_lead_esp`, `insert_unsubscribe_header`, `allow_risky_contacts`, `disable_bounce_protect`, `auto_variant_select`, `limit_emails_per_company_override`, `provider_routing_rules`, `cc_list`, `bcc_list`, `email_tag_list`, `pl_value`, `is_evergreen`, `owned_by`, `ai_sdr_id`).
Response: Campaign. A new campaign is Draft (`status: 0`); call activate to start it.

### GET `/api/v2/campaigns/{id}` — scope `campaigns:read` → Campaign.

### PATCH `/api/v2/campaigns/{id}` — scope `campaigns:update`
Body: any subset of the create fields (none required; `ai_sdr_id` is not patchable). Sending `sequences` replaces all the copy; sending `campaign_schedule` requires `schedules`. → Campaign.

### POST `/api/v2/campaigns/{id}/activate` — start or resume — scope `campaigns:update`
No body. → Campaign.

### POST `/api/v2/campaigns/{id}/pause` — stop or pause — scope `campaigns:update`
No body. → Campaign.

### POST `/api/v2/campaigns/{id}/variables` — add campaign variables — scope `campaigns:update`
Body: `{ "variables*": string[] }` (variable names to register on the campaign). → Campaign.

### GET `/api/v2/campaigns/{id}/sending-status` — scope `campaigns:read`
Query: `with_ai_summary` (bool, default false).
Response:
- `diagnostics` (object|null):
  - `campaign_id`, `last_updated`
  - `status` — one of: `campaign_paused`, `campaign_draft`, `campaign_completed`, `campaign_running_subsequences`, `campaign_bounce_protect`, `campaign_accounts_unhealthy`, `campaign_account_suspended`, `out_of_schedule`, `waiting_for_leads`, `daily_limit_met`, `account_daily_limit_met`, `new_lead_limit_met`, `all_accounts_unhealthy`, `waiting_for_esp_match`, `domain_limit_reached`, `follow_up_delay_not_met`, `no_accounts_available`, `healthy`
  - `issue_tracking{current_status_code, issue_first_seen_at, consecutive_loops_with_issue, last_healthy_send_at}`
  - `accounts_summary{total_connected, available, unavailable{daily_limit_hit, slow_ramp_limit_hit, disconnected, global_gap_not_met}}`
  - `campaign_daily_limit{limit, sent, limit_hit}`
  - `new_lead_limit{enabled, limit, contacted, limit_hit}`
  - `schedule_status{in_schedule}`
  - `follow_ups_waiting{count, earliest_wait_time_seconds}`
  - `leads_status{no_leads_ready, account_unavailable_skips, delay_not_met_skips}`
  - also `send_one_by_one`, `esp_routing_status`, `domain_limiter`
  - Only `campaign_id`, `last_updated`, `status` and `issue_tracking` are always present; the rest can be missing when the campaign is out of schedule.
- `summary` (object|null): `{status, status_message, issue_started_at, last_healthy_send_at, ai_summary}`

### Campaign analytics (scope not stated in the spec — see uncertainties)
Date params on all three: `start_date` / `end_date` accept `YYYY-MM-DD` (read as 00:00 UTC) or a full ISO 8601 string.

**GET `/api/v2/campaigns/analytics`** — query: `id` (one campaign; omit for all), `ids` (repeat the param: `?ids=a&ids=b`), `start_date`, `end_date`, `exclude_total_leads_count` (bool; true makes the call much faster).
Response is an **array** of:
- `campaign_name`, `campaign_id`, `campaign_status`, `campaign_is_evergreen`
- `leads_count`, `contacted_count`, `new_leads_contacted_count`, `emails_sent_count`
- `open_count`, `open_count_unique`, `open_count_unique_by_step`
- `reply_count`, `reply_count_unique`, `reply_count_unique_by_step`, `reply_count_automatic`, `reply_count_automatic_unique`, `reply_count_automatic_unique_by_step`
- `link_click_count`, `link_click_count_unique`, `link_click_count_unique_by_step`
- `bounced_count`, `unsubscribed_count`, `completed_count`
- `total_opportunities`, `total_opportunity_value`

`reply_count_unique` excludes auto-replies.

**GET `/api/v2/campaigns/analytics/daily`** — query: `campaign_id` (optional), `start_date`, `end_date`, `campaign_status` (enum).
Response is an **array** of: `date` (YYYY-MM-DD), `sent`, `contacted`, `new_leads_contacted`, `opened`, `unique_opened`, `replies`, `unique_replies`, `replies_automatic`, `unique_replies_automatic`, `clicks`, `unique_clicks`, `opportunities`, `unique_opportunities`.

**GET `/api/v2/campaigns/analytics/steps`** — query: `campaign_id` (optional), `start_date`, `end_date`, `include_opportunities_count` (bool).
Response is an **array** of:
- `step` (string|null), `variant` (string|null; `0`=A, `1`=B …)
- `sent`, `opened`, `unique_opened`, `replies`, `unique_replies`, `replies_automatic`, `unique_replies_automatic`, `clicks`, `unique_clicks`
- only when `include_opportunities_count=true`: `opportunities`, `unique_opportunities`, `meetings_booked`, `won`

---

## 3b. Email verification (costs credits; 402 when the workspace has no paid plan or credits)

**POST `/api/v2/email-verification`** — scope `email_verifications:create`. Body: `email*`, `webhook_url` (optional; called only if the check takes over 10s).
**GET `/api/v2/email-verification/{email}`** — scope `email_verifications:read`. Poll this when the POST answered `pending`.
Both return: `email`, `verification_status` (`pending` | `verified` | `invalid`), `catch_all` (`true` | `false` | `"pending"`),
`credits` (left after this check), `credits_used`, and `status` (`success` | `error`; the docs say not to read the outcome from it).
There is no bulk endpoint. Rate limit is the workspace-wide 100/s, 6,000/min. One lead verification costs 0.25 Instantly credits (third-party figure; check billing).

## 4. Leads

### Lead object (returned by create/get/patch, and in leads/list `items[]`)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `email` | string\|null | |
| `first_name`, `last_name`, `company_name`, `job_title`, `phone`, `website`, `personalization` | string\|null | |
| `company_domain` | string | |
| `campaign` | uuid\|null | campaign ID |
| `list_id` | uuid\|null | |
| `status` | number | lead status enum |
| `lt_interest_status` | number | interest enum |
| `payload` | object\|null | **custom variables** (plus camelCase copies of the built-ins: `firstName`, `lastName`, `companyName`, `jobTitle`, `website`, `phone`, `personalization`). Values must be string/number/boolean/null; no objects or arrays. |
| `email_open_count`, `email_reply_count`, `email_click_count` | number | |
| `email_opened_step/_variant`, `email_replied_step/_variant`, `email_clicked_step/_variant` | number\|null | |
| `status_summary` | `{lastStep{from, stepID, timestamp_executed}, domain_complete}` | |
| `last_step_from`, `last_step_id`, `last_step_timestamp_executed` | | |
| `timestamp_created`, `timestamp_updated`, `timestamp_last_contact`, `timestamp_last_open`, `timestamp_last_reply`, `timestamp_last_click`, `timestamp_last_interest_change`, `timestamp_last_touch` | date-time\|null | |
| `verification_status`, `enrichment_status`, `esp_code`, `esg_code`, `upload_method` | | enums above |
| `pl_value_lead` | string\|null | |
| `assigned_to`, `uploaded_by_user`, `organization` | uuid | |
| `subsequence_id`, `status_summary_subseq`, `timestamp_added_subsequence` | | subsequence info |
| `is_website_visitor`, `last_contacted_from` | | |

**`custom_variables` format (write side):** a flat object `{ "key": "value" }`. Values are string, number, boolean or null (no nesting). The keys are added to the campaign so every lead in it gets the same variable keys. Read them back from `payload`.

### POST `/api/v2/leads/add` — bulk add (≤1000) — scope `leads:create`
Body:
- `campaign_id` (uuid) **or** `list_id` (uuid) — exactly one of the two.
- `leads*` (array, max 1000). Each lead has `email`, `first_name`, `last_name`, `company_name`, `job_title`, `phone`, `website`, `personalization`, `lt_interest_status`, `pl_value_lead`, `assigned_to`, `custom_variables`.
  - With `campaign_id`, `email` is required.
  - With `list_id`, each lead needs at least one of `email`, `first_name` or `last_name`.
- `skip_if_in_workspace` (bool): skip the lead if it exists anywhere in the workspace. Overrides the other skip flags.
- `skip_if_in_campaign` (bool): skip if the lead is in ANY campaign.
- `skip_if_in_list` (bool): skip if the lead is in ANY list.
- `blocklist_id` (uuid|null; defaults to the workspace blocklist), `assigned_to` (uuid), `verify_leads_on_import` (bool).

Response:
- counts: `status`, `total_sent`, `leads_uploaded`, `in_blocklist`, `blocklist_used`, `duplicated_leads` (already in this campaign or list), `skipped_count` (skipped by the skip_if flags), `invalid_email_count`, `incomplete_count`, `duplicate_email_count` (duplicates within the request)
- `remaining_in_plan` (only when `campaign_id` is used)
- `created_leads[]`: `{index, id, email, first_name, last_name, phone}` — use `index` to map back to your input.

### POST `/api/v2/leads` — create one — scope `leads:create`
Body:
- `campaign` (uuid) or `list_id` (uuid) — note the field is `campaign`, not `campaign_id`
- `email`, `first_name`, `last_name`, `company_name`, `job_title`, `phone`, `website`, `personalization`, `lt_interest_status`, `pl_value_lead`, `assigned_to`, `custom_variables`
- `skip_if_in_workspace`, `skip_if_in_campaign`, `skip_if_in_list`, `blocklist_id`, `verify_leads_on_import`, `verify_leads_for_lead_finder`

→ Lead.

### POST `/api/v2/leads/list` — list/search (POST, not GET) — scope `leads:read`
Body (all optional):
| Field | Type | Notes |
|---|---|---|
| `campaign` | uuid | filter by campaign (field name is `campaign`) |
| `list_id` | uuid | |
| `in_campaign`, `in_list` | bool | |
| `search` | string | whole-word/prefix match on email, name, company, title… Newly written leads take a few seconds to become searchable. |
| `filter` | string | `FILTER_VAL_CONTACTED`, `FILTER_VAL_NOT_CONTACTED`, `FILTER_VAL_COMPLETED`, `FILTER_VAL_UNSUBSCRIBED`, `FILTER_VAL_ACTIVE`, `FILTER_LEAD_INTERESTED`, `FILTER_LEAD_NOT_INTERESTED`, `FILTER_LEAD_MEETING_BOOKED`, `FILTER_LEAD_MEETING_COMPLETED`, `FILTER_LEAD_CLOSED`, `FILTER_LEAD_OUT_OF_OFFICE`, `FILTER_LEAD_WRONG_PERSON`, `FILTER_LEAD_LOST`, `FILTER_LEAD_NO_SHOW`, `FILTER_LEAD_CUSTOM_LABEL_POSITIVE`, `FILTER_LEAD_CUSTOM_LABEL_NEGATIVE`, `FILTER_VAL_BOUNCED`, `FILTER_VAL_SKIPPED`, `FILTER_VAL_RISKY`, `FILTER_VAL_INVALID`, `FILTER_VAL_VALID`, `FILTER_VAL_CATCH_ALL`, `FILTER_VAL_NOT_VERIFIED`, `FILTER_VAL_IN_SUBSEQUENCE`, `FILTER_VAL_OPENED_NO_REPLY`, `FILTER_VAL_COMPLETED_NO_REPLY`, `FILTER_VAL_NO_OPENS`, `FILTER_VAL_REPLIED`, `FILTER_VAL_LINK_CLICKED` |
| `ids`, `excluded_ids` | string[] | lead IDs |
| `contacts` | string[] | lead emails |
| `queries` | `[{actionType*, values*}]` | `actionType`: `reply`,`email-open`,`last-contacted`,`link-click`,`lead-status`,`lead-status-change`. `values`: `{"occurrence-days": n, "occurrence-count": {condition:'more'\|'less'\|'equal', count}, "lead-status": {status, condition:'is'\|'is-not'}}` |
| `limit` | int 1–100 | |
| `starting_after` | string | the last lead's `id` (or its email when `distinct_contacts=true`) |
| `distinct_contacts`, `is_website_visitor` | bool | |
| `enrichment_status` | number | |
| `esg_code` | string | `'0'`…`'4'`, `'all'`, `'none'` |
| `organization_user_ids` | string[] | |
| `smart_view_id` | uuid | |

Response: `{ items: Lead[], next_starting_after }`. Sorted by `id` ascending (reliable chronological order only for leads created on or after 2025-10-15).

### GET `/api/v2/leads/{id}` — scope `leads:read` → Lead.

### PATCH `/api/v2/leads/{id}` — scope `leads:update`
Body: `first_name`, `last_name`, `company_name`, `job_title`, `phone`, `website`, `personalization`, `lt_interest_status`, `pl_value_lead`, `assigned_to`, `custom_variables`. `email`, campaign and list can't be changed here. → Lead.

### POST `/api/v2/leads/update-interest-status` — scope not stated (probably `leads:update`)
Body:
- `lead_email*` (string)
- `interest_value*` (number|null — `null` resets to "Lead"; otherwise an `lt_interest_status` value or a custom label's `interest_status`)
- `campaign_id`, `list_id` (strings)
- `ai_interest_value` (number), `disable_auto_interest` (bool)

Response **202** `{ message }` — the update is asynchronous. Side effects: a campaign lead may be marked completed, opportunities may be created or updated, and automations or subsequences may trigger.

---

## 5. Lead labels

### GET `/api/v2/lead-labels` — scope `lead-labels:read`
Query: `limit` (1–100), `starting_after` (timestamp), `search`, `interest_status` (`positive`|`neutral`|`negative`).
`items[]`: `id`, `label`, `interest_status_label` (`positive`|`negative`|`neutral`), **`interest_status`** (number, set by Instantly — the value to use as `interest_value` / `lt_interest_status` for this custom label), `description`, `use_with_ai`, `created_by`, `organization_id`, `timestamp_created`, `access_grants[]`.

---

## 6. Accounts (sending mailboxes)

### Account object
- `email`, `first_name`, `last_name`
- `status` (enum), `warmup_status` (enum), `status_message{code, command, response, e_message, responseCode}`
- `stat_warmup_score` (number|null — warmup health score)
- `daily_limit` (number|null — sending limit per day), `sending_gap` (minutes, 0–1440)
- `warmup{limit, increment ('disabled'|'0'..'4'), reply_rate, warmup_custom_ftag, advanced{warm_ctd, open_rate, important_rate, read_emulation, spam_save_rate, weekday_only}}`
- `provider_code` (enum), `enable_slow_ramp`
- `tracking_domain_name`, `tracking_domain_status`
- `setup_pending`, `is_managed_account`, `autofix_failed` (null = in progress)
- `signature`, `reply_to`, `timestamp_warmup_start`
- `daily_limit_max`, `warmup_limit_max` (AirMail only), `inbox_placement_test_limit`
- `organization`, `added_by`, `modified_by`, `timestamp_created`, `timestamp_updated`
- `tags` (only when `include_tags=true`)

### GET `/api/v2/accounts` — list — scope `accounts:read`
Query:
- `limit` (1–100), `starting_after` (cursor, format `timestamp_created&email`), `search`
- `status` (account status enum), `provider_code`
- `tag_ids` (OR, comma-separated), `tag_ids_all` (AND), `include_tags` (bool)
- `filter`: `ACC_FILTER_PAUSED`, `ACC_FILTER_ERROR`, `ACC_FILTER_NO_CTD`, `ACC_FILTER_PW_ACCOUNTS`, `ACC_FILTER_DFY`, `ACC_FILTER_DFY_SETUP_PENDING`, `ACC_FILTER_W_ACTIVE`, `ACC_FILTER_W_PAUSED`, `ACC_FILTER_W_ERROR`
- `sort_by` (`timestamp_created`|`email`|`stat_warmup_score`|`status`), `sort_order` (`asc`|`desc`), `skip` (offset; use with `sort_by`)

→ `{ items: Account[], next_starting_after }`.

### POST `/api/v2/accounts/warmup-analytics` — scope `accounts:read`
Body: `{ "emails*": string[] }` (max 100).
Response:
- `email_date_data`: `{ "<email>": { "<YYYY-MM-DD>": { sent, landed_inbox, landed_spam, received } } }`
- `aggregate_data`: `{ "<email>": { sent, received, landed_inbox, landed_spam, health_score, health_score_label } }`

### GET `/api/v2/accounts/analytics/daily` — scope not stated
Query: `emails` (**required** array, 1–200; repeat the param), `start_date` (default is 30 days back; the range can be at most 31 days), `end_date` (default today).
Response is an **array** of: `date`, `email_account`, `sent`, `bounced`, `contacted`, `new_leads_contacted`, `opened`, `unique_opened`, `replies`, `unique_replies`, `replies_automatic`, `unique_replies_automatic`, `clicks`, `unique_clicks`.

### POST `/api/v2/accounts/{email}/pause` — scope `accounts:update` → Account.
### POST `/api/v2/accounts/{email}/resume` — scope `accounts:update` → Account.
(URL-encode `{email}`.)

### POST `/api/v2/accounts/test/vitals` — scope `accounts:read`
Body: `{ "accounts": string[] }` (account emails).
Response: `{ status, success_list[], failure_list[] }`. Each list item is `{ domain, allPass, mx, spf, dkim, dmarc, indeterminate: ('mx'|'spf'|'dkim'|'dmarc')[] }`. `indeterminate` lists records that couldn't be checked because DNS failed; re-run the test for those.

---

## 7. Emails (Unibox)

### Email object
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | use it as `reply_to_uuid` |
| `thread_id` | uuid\|null | every email in a thread has the same value |
| `message_id` | string | RFC Message-ID |
| `subject` | string | |
| `body` | `{text, html}` | |
| `content_preview` | string\|null | |
| `from_address_email` | string\|null | |
| `to_address_email_list` | string | comma-separated |
| `cc_address_email_list`, `bcc_address_email_list`, `reply_to` | string\|null | |
| `from_address_json`, `to_address_json`, `cc_address_json` | array\|null | |
| `eaccount` | string | the workspace mailbox that sent or received the email |
| `lead` | string\|null | the lead's email address |
| `lead_id` | uuid\|null | |
| `campaign_id`, `subsequence_id`, `list_id` | uuid\|null | |
| `ue_type` | number\|null | 1 campaign-sent · 2 received · 3 sent (manual) · 4 scheduled |
| `step` | string\|null | campaign step |
| `is_unread` | number\|null | 0/1 (a number, not a boolean) |
| `is_auto_reply` | number\|null | 0/1 |
| `is_focused` | number\|null | 1 = Primary tab |
| `i_status` | number\|null | interest status (same values as `lt_interest_status`) |
| `ai_interest_value`, `ai_assisted`, `ai_agent_id` | | |
| `timestamp_email` | date-time | the email's own date — **use this one** |
| `timestamp_created` | date-time | when Instantly ingested the email |
| `reminder_ts` | date-time\|null | |
| `attachment_json` | `{files[{filename, size, type, url, error}]}`\|null | |
| `organization_id` | uuid | |

### GET `/api/v2/emails` — list — scope `emails:read` — **20 req/min**
Query:
- `limit` (1–100), `starting_after` (cursor)
- `search` — a lead email, or `thread:<thread_id>` for every email in one thread
- `campaign_id`, `list_id`, `lead` (lead email), `eaccount` (comma-separated mailboxes), `company_domain`
- `email_type`: `received`|`sent`|`manual` (the filter param; the response field is `ue_type`)
- `i_status` (number), `is_unread` (bool), `marked_as_done` (bool), `has_reminder` (bool)
- `mode`: `emode_focused`|`emode_others`|`emode_all`
- `latest_of_thread` (bool), `preview_only` (bool), `scheduled_only` (bool)
- `sort_order` (`asc`|`desc`, default desc by created date)
- `assigned_to` (uuid)
- `min_timestamp_created`, `max_timestamp_created` (ISO)

→ `{ items: Email[], next_starting_after }`.
Polling tip: `email_type=received` + `min_timestamp_created=<last poll>`. Remember the 20/min limit.

### GET `/api/v2/emails/{id}` — scope `emails:read` → Email.

### GET `/api/v2/emails/unread/count` — scope `emails:read` → `{ count }`.

### POST `/api/v2/emails/reply` — scope `emails:create`
Body:
- `eaccount*` — a connected mailbox, normally the original email's `eaccount`
- `reply_to_uuid*` — the `id` of the email you are replying to
- `subject*` — usually `"Re: " + subject`
- `body*` — `{html?, text?}`, at least one; use `<br/>` in html
- `additional_recipients` (string[]), `cc_address_email_list`, `bcc_address_email_list` (comma strings), `reminder_ts`, `assigned_to`

It replies to the sender of the email you name. → Email (the sent reply).

---

## 8. Block list

### POST `/api/v2/block-lists-entries` — scope `block_list_entries:create`
Body: `{ "bl_value*": "user@x.com" | "x.com" }`.
→ `{ id, bl_value, is_domain, organization_id, timestamp_created }`. Bulk version: `POST /api/v2/block-lists-entries/bulk-create`.

---

## 9. Webhook events (brief)
Payload base: `timestamp`, `event_type`, `workspace`, `campaign_id`, `campaign_name`.
Optional fields:
- lead and step: `lead_email`, `email_account`, `step` (1-based), `variant` (1-based), `is_first`
- sent emails: `email_id` (usable as `reply_to_uuid`), `email_subject`, `email_text`, `email_html`
- replies: `unibox_url`, `reply_text_snippet`, `reply_subject`, `reply_text`, `reply_html`
- lead fields merged in as extra keys

`event_type` values:
- email: `email_sent`, `email_opened`, `reply_received`, `auto_reply_received`, `link_clicked`, `email_bounced`, `lead_unsubscribed`, `account_error`, `campaign_completed`
- interest: `lead_neutral`, `lead_interested`, `lead_not_interested`, `lead_meeting_booked`, `lead_meeting_completed`, `lead_closed`, `lead_out_of_office`, `lead_wrong_person`
- custom labels: the label name is sent as the `event_type`, unchanged

Webhooks are managed under `/api/v2/webhooks` (not covered here).

---

## 10. Uncertainties
1. **Plan:** the docs never state a plan requirement. "Hypergrowth ($97/mo) or higher" comes from third-party guides and a feature-request post. Verify on the live account.
2. **Analytics scopes:** the spec gives no scope for campaigns/analytics(/daily, /steps), accounts/analytics/daily or leads/update-interest-status. An `analytics:read` scope exists, so assume `analytics:read` / `leads:update` or use `all:read` / `all:all`.
3. **Custom-variable placeholders:** the spec only shows `{{firstName}}` in examples. That `custom_variables` keys work as `{{key}}` (case-sensitive, exact key) in step subject/body follows from how Instantly behaves ("payload = lead custom variables"; keys are added to the campaign), but the v2 docs don't state it. Test with one lead.
4. **`days` keys:** `"0"`–`"6"` are assumed to be Sunday–Saturday (JS `getDay()` convention). The spec doesn't say.
5. **Timezone enum:** the spec's list (102 values) is strict and has no `Europe/London`. Using `Europe/Isle_of_Man` for UK time is inferred from the enum, not documented. Expect a 400 for values outside the list.
6. **`email_type=manual`** vs `ue_type=3`: how the filter values map to `ue_type` is not documented.
7. **`i_status` on emails:** assumed to use the same values as `lt_interest_status`; the spec only says "interest status".
8. **`filter` on leads/list** says "for custom lead labels, use the `interest_status` field", but the request body schema has no `interest_status` property.
9. No documented `Retry-After` header on 429; no documented error body schema.
