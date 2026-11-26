/**
 * What the sending platform says about a running campaign, as one plain sentence for people, or nothing when all is
 * well. Finishing today's emails, being outside sending hours or waiting for a follow-up's day aren't problems, so
 * they say nothing here; only something that needs a person does. Works from the status code, or from the stored
 * message when that's all there is.
 */
export type SendNotice = { tone: "info" | "wait" | "bad"; text: string; mailboxes?: boolean; email?: boolean };

const FINE = new Set([
  "healthy", "out_of_schedule", "daily_limit_met", "account_daily_limit_met", "new_lead_limit_met", "domain_limit_reached",
  "follow_up_delay_not_met", "campaign_running_subsequences", "campaign_paused", "campaign_draft", "campaign_completed",
]);

const NO_MAILBOX: SendNotice = { tone: "bad", text: "None of its mailboxes can send right now.", mailboxes: true };

const BY_CODE: Record<string, SendNotice> = {
  waiting_for_leads: { tone: "info", text: "Everyone due an email has had one." },
  all_accounts_unhealthy: NO_MAILBOX,
  campaign_accounts_unhealthy: NO_MAILBOX,
  no_accounts_available: NO_MAILBOX,
  campaign_bounce_protect: { tone: "bad", text: "Paused to protect your mailboxes, because too many emails bounced.", mailboxes: true },
  campaign_account_suspended: { tone: "bad", text: "One of its mailboxes has been suspended.", mailboxes: true },
  waiting_for_esp_match: {
    tone: "wait", text: "Waiting for a mailbox on the same email provider as each contact. Turn off “Pair like with like” to send anyway.", email: true,
  },
};

export function sendNotice(code: string | null | undefined, message?: string | null): SendNotice | null {
  if (code) {
    if (FINE.has(code)) return null;
    if (BY_CODE[code]) return BY_CODE[code];
  }
  const m = message ?? "";
  if (!m) return null;
  if (/daily (sending )?limit|outside (the )?scheduled sending hours|follow.?up|new lead limit|domain limit|paused|completed|draft/i.test(m)) return null;
  if (/no leads are ready|waiting for leads/i.test(m)) return BY_CODE.waiting_for_leads;
  if (/unhealthy|no accounts|no mailbox/i.test(m)) return NO_MAILBOX;
  if (/bounce/i.test(m)) return BY_CODE.campaign_bounce_protect;
  if (/suspend/i.test(m)) return BY_CODE.campaign_account_suspended;
  if (/esp/i.test(m)) return BY_CODE.waiting_for_esp_match;
  return { tone: "wait", text: m.replace(/\.?$/, ".") };
}
