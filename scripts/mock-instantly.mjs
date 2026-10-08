// A tiny in-memory stand-in for the Instantly API v2, for testing the console without a real workspace.
// Run: node scripts/mock-instantly.mjs   then start the app with INSTANTLY_BASE_URL=http://127.0.0.1:3471/api/v2
// Any API key works. Active campaigns "send" one email each time /emails is polled, and every
// third lead replies (alternating interested / unsubscribe) so the inbox and GHL flow have data.
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT || 3471);
const now = () => new Date().toISOString();

const accounts = ["sam@fruitful-mail.co", "sam@fruitfulhq.co", "hello@getfruitful.co"].map((email, i) => ({
  email, status: 1, warmup_status: 1, stat_warmup_score: [98, 91, 64][i], daily_limit: 30,
}));
const campaigns = new Map();
// Custom tags: two clients share this workspace. Mailboxes 1-2 are "Signal", mailbox 3 is "Fruitful".
const tags = [{ id: "tag-signal", label: "Signal" }, { id: "tag-fruitful", label: "Fruitful" }];
const tagged = new Map([["tag-signal", new Set([accounts[0].email, accounts[1].email])], ["tag-fruitful", new Set([accounts[2].email])]]);
const hasTag = (q, id) => { const t = q.get("tag_ids"); return !t || t.split(",").some((x) => tagged.get(x)?.has(id)); };
const leads = new Map(); // id -> lead
const verifications = new Map(); // email -> verification result
const emails = [];
const sentCount = new Map();

function render(tpl, lead) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = lead.payload?.[k];
    if (v === undefined) throw new Error(`Variable {{${k}}} missing on lead ${lead.email}`);
    return String(v);
  });
}

function sendOne() {
  for (const c of campaigns.values()) {
    if (c.status !== 1) continue;
    const steps = c.sequences?.[0]?.steps ?? [];
    for (const lead of leads.values()) {
      if (lead.campaign !== c.id || lead.status !== 1) continue;
      const step = (lead._step ?? 0) + 1;
      if (step > steps.length) { lead.status = 3; continue; }
      const v = steps[step - 1].variants[0];
      const eaccount = c.email_list[(sentCount.get(c.id) ?? 0) % Math.max(1, c.email_list.length)] ?? accounts[0].email;
      sentCount.set(c.id, (sentCount.get(c.id) ?? 0) + 1);
      const thread = lead._thread ?? randomUUID();
      lead._thread = thread;
      const subject = step === 1 ? render(v.subject, lead) : `Re: ${lead._subject}`;
      if (step === 1) lead._subject = subject;
      emails.push({
        id: randomUUID(), thread_id: thread, subject, body: { html: render(v.body, lead) }, content_preview: null,
        from_address_email: eaccount, to_address_email_list: lead.email, eaccount, lead: lead.email, campaign_id: c.id,
        ue_type: 1, step: String(step), is_unread: 0, is_auto_reply: 0, i_status: null, timestamp_email: now(), timestamp_created: now(),
      });
      lead._step = step;
      lead.timestamp_last_contact = now();
      const n = [...leads.values()].indexOf(lead);
      if (step === 1 && n % 3 === 2) {
        const interested = (n / 3) % 2 < 1;
        emails.push({
          id: randomUUID(), thread_id: thread, subject: `Re: ${subject}`,
          body: { text: interested ? `Hi,\n\nThis is timely. Could we talk Thursday afternoon?\n\nThanks\n\nOn Mon someone wrote:\n> old quoted text` : "Please remove me from your list." },
          content_preview: null, from_address_email: lead.email, to_address_email_list: eaccount, eaccount, lead: lead.email, campaign_id: c.id,
          ue_type: 2, step: null, is_unread: 1, is_auto_reply: 0, i_status: null,
          timestamp_email: new Date(Date.now() + 1000).toISOString(), timestamp_created: new Date(Date.now() + 1000).toISOString(),
        });
        lead.status = 3;
        lead._replied = true;
      }
      return;
    }
  }
}

function page(items, q) {
  const limit = Number(q.get("limit") || 100);
  const after = q.get("starting_after");
  let start = 0;
  if (after) start = items.findIndex((i) => (i.id ?? i.email) === after) + 1;
  const slice = items.slice(start, start + limit);
  return { items: slice, next_starting_after: start + limit < items.length ? (slice.at(-1).id ?? slice.at(-1).email) : null };
}

const routes = [
  ["GET", /^\/workspaces\/current$/, () => ({ id: "ws_mock", name: "Fruitful (mock)", plan_id: "hypergrowth" })],
  ["GET", /^\/accounts$/, (m, q) => page(accounts.filter((a) => hasTag(q, a.email)), q)],
  ["GET", /^\/custom-tags$/, (m, q) => page(tags, q)],
  ["POST", /^\/custom-tags$/, (m, q, body) => { const t = { id: randomUUID(), label: body.label }; tags.push(t); tagged.set(t.id, new Set()); return t; }],
  ["POST", /^\/custom-tags\/toggle-resource$/, (m, q, body) => {
    for (const id of body.tag_ids) for (const r of body.resource_ids) {
      if (body.assign) tagged.get(id)?.add(r);
      else tagged.get(id)?.delete(r);
    }
    return { success: true };
  }],
  ["POST", /^\/accounts\/(.+)\/(pause|resume)$/, (m) => {
    const a = accounts.find((x) => x.email === decodeURIComponent(m[1]));
    if (!a) throw Object.assign(new Error("not found"), { code: 404 });
    a.status = m[2] === "pause" ? 2 : 1;
    return a;
  }],
  ["GET", /^\/accounts\/analytics\/daily$/, (m, q) => q.getAll("emails").map((e, i) => ({
    date: now().slice(0, 10), email_account: e, sent: 40, bounced: i === 1 ? 3 : 0,
  }))],
  ["GET", /^\/campaigns$/, (m, q) => page([...campaigns.values()].filter((c) => hasTag(q, c.id)), q)],
  ["POST", /^\/campaigns$/, (m, q, body) => {
    const c = { id: randomUUID(), status: 0, not_sending_status: null, timestamp_created: now(), email_list: [], ...body };
    campaigns.set(c.id, c);
    return c;
  }],
  ["GET", /^\/campaigns\/analytics\/daily$/, (m, q) => {
    const id = q.get("campaign_id");
    const sent = emails.filter((e) => e.campaign_id === id && e.ue_type === 1).length;
    const replies = emails.filter((e) => e.campaign_id === id && e.ue_type === 2).length;
    return sent ? [{ date: now().slice(0, 10), sent, unique_opened: Math.round(sent * 0.5), unique_replies: replies, unique_clicks: 0, unique_opportunities: 0 }] : [];
  }],
  ["GET", /^\/campaigns\/([\w-]+)\/sending-status$/, () => ({ summary: { status: "healthy", status_message: "Sending" }, diagnostics: null })],
  ["GET", /^\/campaigns\/([\w-]+)$/, (m) => campaigns.get(m[1])],
  ["PATCH", /^\/campaigns\/([\w-]+)$/, (m, q, body) => {
    const c = campaigns.get(m[1]);
    const before = c.sequences?.[0]?.steps?.length ?? 0;
    Object.assign(c, body);
    // Like Instantly: adding steps re-activates leads that finished the sequence without replying.
    if ((c.sequences?.[0]?.steps?.length ?? 0) > before) {
      for (const l of leads.values()) if (l.campaign === c.id && l.status === 3 && !l._replied) l.status = 1;
    }
    return c;
  }],
  ["PATCH", /^\/leads\/([\w-]+)$/, (m, q, body) => {
    const l = leads.get(m[1]);
    if (!l) throw Object.assign(new Error("lead not found"), { code: 404 });
    if (body.custom_variables) l.payload = { ...l.payload, ...body.custom_variables };
    return l;
  }],
  ["DELETE", /^\/leads\/([\w-]+)$/, (m) => { leads.delete(m[1]); return { id: m[1] }; }],
  ["POST", /^\/campaigns\/([\w-]+)\/activate$/, (m) => Object.assign(campaigns.get(m[1]), { status: 1 })],
  ["POST", /^\/campaigns\/([\w-]+)\/pause$/, (m) => Object.assign(campaigns.get(m[1]), { status: 2 })],
  ["POST", /^\/campaigns\/([\w-]+)\/variables$/, (m) => campaigns.get(m[1])],
  // Email verification: every 6th address is invalid, every 4th a catch-all, every 5th takes a second request to finish.
  ["POST", /^\/email-verification$/, (m, q, body) => {
    const n = [...body.email].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    const result = { email: body.email, verification_status: n % 6 === 0 ? "invalid" : "verified", catch_all: n % 4 === 0, credits: 1000 - verifications.size, credits_used: 1 };
    verifications.set(body.email, result);
    return n % 5 === 0 ? { email: body.email, verification_status: "pending", catch_all: "pending", credits: result.credits, credits_used: 1 } : result;
  }],
  ["GET", /^\/email-verification\/(.+)$/, (m) => {
    const r = verifications.get(decodeURIComponent(m[1]));
    if (!r) throw Object.assign(new Error("Resource not found"), { code: 404 });
    return r;
  }],
  ["POST", /^\/leads\/add$/, (m, q, body) => {
    const created = [];
    body.leads.forEach((l, index) => {
      if ([...leads.values()].some((x) => x.email === l.email && x.campaign === body.campaign_id)) return;
      const id = randomUUID();
      leads.set(id, { id, email: l.email, campaign: body.campaign_id, status: 1, lt_interest_status: null, payload: l.custom_variables ?? {},
        email_open_count: 0, email_reply_count: 0, email_click_count: 0, timestamp_last_contact: null, timestamp_last_open: null, timestamp_last_reply: null });
      created.push({ index, id, email: l.email });
    });
    return { leads_uploaded: created.length, in_blocklist: 0, duplicated_leads: body.leads.length - created.length, skipped_count: 0, invalid_email_count: 0, created_leads: created };
  }],
  ["POST", /^\/leads\/list$/, (m, q, body) => {
    const items = [...leads.values()].filter((l) => !body.campaign || l.campaign === body.campaign);
    return page(items, new URLSearchParams({ limit: String(body.limit ?? 100), ...(body.starting_after ? { starting_after: body.starting_after } : {}) }));
  }],
  ["POST", /^\/leads\/update-interest-status$/, (m, q, body) => {
    for (const l of leads.values()) if (l.email === body.lead_email) l.lt_interest_status = body.interest_value;
    return { message: "queued" };
  }],
  ["GET", /^\/emails$/, (m, q) => {
    if (q.get("scheduled_only") === "true") {
      const due = [];
      let t = Date.now() + 20 * 60_000;
      for (const l of leads.values()) {
        const c = campaigns.get(l.campaign);
        if (!c || c.status !== 1 || l.status !== 1) continue;
        due.push({ id: `sched-${l.id}`, lead: l.email, eaccount: c.email_list[0], campaign_id: c.id, step: String((l._step ?? 0) + 1), subject: l.payload.subject_1 ?? "", ue_type: 4, timestamp_email: new Date(t).toISOString() });
        t += 17 * 60_000;
      }
      return { items: due };
    }
    sendOne();
    const min = q.get("min_timestamp_created");
    const own = q.get("eaccount")?.split(",");
    return page(emails.filter((e) => (!min || e.timestamp_created > min) && (!own || own.includes(e.eaccount))), q);
  }],
  ["POST", /^\/emails\/reply$/, (m, q, body) => {
    const orig = emails.find((e) => e.id === body.reply_to_uuid);
    const e = { ...orig, id: randomUUID(), ue_type: 3, subject: body.subject, body: body.body, eaccount: body.eaccount, timestamp_email: now(), timestamp_created: now() };
    emails.push(e);
    return e;
  }],
  ["POST", /^\/block-lists-entries$/, (m, q, body) => ({ id: randomUUID(), bl_value: body.bl_value })],
];

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (!req.headers.authorization?.startsWith("Bearer ")) return send(401, { message: "Unauthorized" });
    if (req.headers.authorization === "Bearer bad") return send(401, { message: "Invalid API key" });
    const route = routes.find(([method, re]) => method === req.method && re.test(path));
    if (!route) return send(404, { message: `No mock for ${req.method} ${path}` });
    try {
      const out = route[2](path.match(route[1]), url.searchParams, raw ? JSON.parse(raw) : {});
      console.log(req.method, path);
      send(200, out ?? {});
    } catch (e) {
      console.error(req.method, path, e.message);
      send(e.code ?? 400, { message: e.message });
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock Instantly on http://127.0.0.1:${PORT}/api/v2`));
