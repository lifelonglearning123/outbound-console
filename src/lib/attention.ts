import "server-only";
import { all, get, getSetting } from "./db";
import type { Client } from "./clients";
import { mailboxHealth, type MailboxHealth } from "./mailboxHealth";
import { GATEWAY_LABEL, type Gateway } from "./mailhost";
import { filterEvidence } from "./deliverability";

/**
 * What needs a person in a client's workspace, from one list so nothing is said twice: problems (something is broken)
 * show at the top of every client page; to-dos (a decision or a click) go in the Today box on the client's home.
 * Each item says what to do and, where one click does it, carries that action.
 */

export type AttentionAction = { kind: "bring_back"; emails: string[] } | { kind: "warmup_on"; email: string };

export type Attention = {
  kind: "problem" | "todo";
  tone: "bad" | "wait" | "go" | "info";
  text: string;
  href?: string;
  link?: string;
  action?: AttentionAction;
  /** Higher comes first. */
  priority: number;
};

const n = (v: number) => v.toLocaleString("en-GB");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

export async function clientAttention(client: Client, isAdmin: boolean, boxes?: MailboxHealth[]): Promise<Attention[]> {
  const items: Attention[] = [];
  const base = `/clients/${client.id}`;
  const mailboxes = boxes ?? (await mailboxHealth(client.id));
  const mailboxPage = `${base}/mailboxes`;

  if (isAdmin && client.key_status === "error") {
    items.push({ kind: "problem", tone: "bad", priority: 100, text: `Instantly connection problem: ${client.key_message ?? "the API key was refused"}.`, href: `${base}/settings`, link: "Fix in Settings" });
  }
  const verifyError = await getSetting(`verify_error_${client.id}`, "");
  if (verifyError) items.push({ kind: "problem", tone: "wait", priority: 90, text: verifyError });

  // Active campaigns with no mailbox left that can send.
  const working = new Set(mailboxes.filter((m) => m.state.key === "sending" || m.state.key === "easing").map((m) => m.email));
  const campaigns = await all<{ id: number; name: string; accounts: string }>(
    "SELECT id, name, accounts FROM campaigns WHERE client_id = ? AND status = 'active'", client.id,
  );
  for (const c of campaigns) {
    let accounts: string[] = [];
    try {
      accounts = JSON.parse(c.accounts || "[]");
    } catch {}
    if (accounts.length > 0 && !accounts.some((a) => working.has(a))) {
      items.push({
        kind: "problem", tone: "bad", priority: 95,
        text: `"${c.name}" has no working mailbox to send from: every mailbox it uses is resting, paused or disconnected.`,
        href: `${base}/campaigns/${c.id}`, link: "See why",
      });
    }
  }

  for (const m of mailboxes.filter((x) => x.state.key === "error")) {
    items.push({ kind: "problem", tone: "bad", priority: 85, text: `${m.email}: ${m.state.label.toLowerCase()}. ${m.detail ?? ""}`, href: mailboxPage, link: "Mailboxes" });
  }

  const stuck = mailboxes.filter((m) => m.stuck);
  if (stuck.length) {
    items.push({
      kind: "todo", tone: "wait", priority: 88,
      text: `${plural(stuck.length, "mailbox", "mailboxes")} paused by the old health rules ${stuck.length === 1 ? "has" : "have"} stopped warming up (${stuck.map((m) => m.email).join(", ")}). Bring ${stuck.length === 1 ? "it" : "them"} back: ${stuck.length === 1 ? "it rests" : "they rest"} out of campaigns while warmup rebuilds, then return by ${stuck.length === 1 ? "itself" : "themselves"}.`,
      action: { kind: "bring_back", emails: stuck.map((m) => m.email) },
    });
  }

  for (const m of mailboxes.filter((x) => x.warmupStatus === 0 && x.state.key !== "error")) {
    items.push({ kind: "todo", tone: "wait", priority: 75, text: `Warmup is off for ${m.email}, so its reputation isn't being kept up.`, action: { kind: "warmup_on", email: m.email } });
  }
  for (const m of mailboxes.filter((x) => x.warmupStatus === -1 || x.warmupStatus === -3)) {
    items.push({
      kind: "problem", tone: "bad", priority: 80,
      text: `Instantly has ${m.warmupStatus === -1 ? "banned" : "suspended"} warmup for ${m.email}. Check the mailbox in Instantly.`,
      href: "https://app.instantly.ai/app/accounts", link: "Open Instantly",
    });
  }
  for (const m of mailboxes.filter((x) => x.warmup.spamRising || x.warmup.falling)) {
    const share = m.warmup.sent7 ? Math.round((m.warmup.spam7 / m.warmup.sent7) * 100) : 0;
    items.push({
      kind: "todo", tone: "wait", priority: 60,
      text: m.warmup.spamRising
        ? `${m.email}: ${share}% of this week's warmup emails went to spam. Keep an eye on it; the console rests it if its warmup health drops under the minimum.`
        : `${m.email}: warmup emails reaching the inbox have dropped three days running.`,
      href: mailboxPage, link: "Mailboxes",
    });
  }

  const bounceRests = mailboxes.filter((m) => m.rest?.kind === "bounce").length;
  const sendingBoxes = mailboxes.filter((m) => m.status === 1).length;
  if (bounceRests >= 2 && bounceRests * 2 >= sendingBoxes) {
    items.push({
      kind: "todo", tone: "wait", priority: 65,
      text: `${plural(bounceRests, "mailbox", "mailboxes")} are resting for bounces. When most mailboxes bounce at once, the contacts are usually the cause, not the mailboxes.`,
      href: `${mailboxPage}#bounces`, link: "See why they bounced",
    });
  }

  // Approved contacts held behind a mail filter, when the evidence says there's a decision to make: the filter looks
  // safe (resume it) or there's too little to tell (send a test). Filters that keep bouncing are rightly held.
  const held = await all<{ campaign_id: number; name: string; gateway: Gateway; n: number }>(
    `SELECT l.campaign_id, c.name, md.gateway, COUNT(*) n FROM leads l
     JOIN campaigns c ON c.id = l.campaign_id JOIN mail_domains md ON md.domain = split_part(l.email, '@', 2)
     WHERE l.client_id = ? AND l.stage = 'approved'
       AND md.gateway IN (SELECT json_array_elements_text(COALESCE(c.hold_gateways, '["mimecast"]')::json))
     GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
    client.id,
  );
  if (held.length) {
    const advice = new Map((await filterEvidence(client.id)).map((f) => [f.gateway, f.advice]));
    const h = held.find((x) => advice.get(x.gateway)?.verdict !== "hold" && advice.get(x.gateway)?.verdict !== "risky");
    if (h) {
      const label = GATEWAY_LABEL[h.gateway] ?? h.gateway;
      const safe = advice.get(h.gateway)?.verdict === "safe";
      items.push({
        kind: "todo", tone: "info", priority: 50,
        text: `${plural(Number(h.n), "approved contact")} in "${h.name}" ${Number(h.n) === 1 ? "is" : "are"} held because their company uses ${label}. ` +
          (safe ? `${advice.get(h.gateway)!.text} Resume ${label} to send them.` : `Too few sent to ${label} to tell yet: send a test of 10.`),
        href: `${base}/campaigns/${h.campaign_id}/contacts#mail-filters`, link: "Mail filters",
      });
    }
  }

  const ready = await get<{ n: number; campaign_id: number; name: string }>(
    `SELECT COUNT(*) n, l.campaign_id, c.name FROM leads l JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.client_id = ? AND l.stage IN ('review', 'extend_review') AND l.verification = 'verified' AND c.status <> 'completed'
     GROUP BY 2, 3 ORDER BY 1 DESC LIMIT 1`,
    client.id,
  );
  if (ready && Number(ready.n) > 0) {
    items.push({
      kind: "todo", tone: "go", priority: 40,
      text: `${plural(Number(ready.n), "contact")} with a verified address ${Number(ready.n) === 1 ? "is" : "are"} ready to approve in "${ready.name}".`,
      href: `${base}/campaigns/${ready.campaign_id}/approve`, link: "Approve",
    });
  }

  const interested = (await get<{ n: number }>(
    "SELECT COUNT(*) n FROM emails WHERE client_id = ? AND direction = 'in' AND is_unread = 1 AND interest = 'interested'", client.id,
  ))?.n ?? 0;
  if (Number(interested) > 0) {
    items.push({ kind: "todo", tone: "go", priority: 45, text: `${plural(Number(interested), "interested reply", "interested replies")} waiting to be read.`, href: `${base}/replies`, link: "Replies" });
  }

  // Errors that keep happening. The same failure differs only by address or number, so those are blanked to group.
  if (isAdmin) {
    const errors = await all<{ message: string; at: string }>(
      "SELECT message, at FROM activity WHERE client_id = ? AND kind = 'error' AND at >= to_char(now() - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS') ORDER BY id DESC LIMIT 200",
      client.id,
    );
    const groups = new Map<string, { message: string; n: number }>();
    for (const e of errors) {
      const key = e.message.replace(/[\w.+-]+@[\w.-]+/g, "@").replace(/\d+/g, "#").slice(0, 80);
      const g = groups.get(key);
      if (g) g.n++;
      else groups.set(key, { message: e.message, n: 1 });
    }
    for (const g of [...groups.values()].filter((g) => g.n >= 3).slice(0, 3)) {
      const text = g.message.length > 180 ? `${g.message.slice(0, 180)}…` : g.message;
      items.push({ kind: "problem", tone: "bad", priority: 70, text: `Happened ${g.n} times in the last day: ${text}`, href: "/activity", link: "See activity" });
    }
  }

  return items.sort((a, b) => b.priority - a.priority);
}
