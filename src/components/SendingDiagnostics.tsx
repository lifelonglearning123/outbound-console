import Link from "next/link";
import type { SendingStatus } from "@/lib/instantly";
import type { MailboxHealth } from "@/lib/mailboxHealth";
import { ago, dateTime } from "@/lib/format";

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString("en-GB");

/**
 * Why a campaign is or isn't sending, in Instantly's own words (its sending-status, refreshed by every sync), next to
 * what the console is doing with each of the campaign's mailboxes.
 */
export function SendingDiagnostics({
  diag, at, boxes, mailboxesHref,
}: {
  diag: SendingStatus | null;
  at: string | null;
  boxes: MailboxHealth[];
  mailboxesHref: string;
}) {
  const s = diag?.summary;
  const d = diag?.diagnostics;
  const healthy = s?.status === "healthy";
  const inSchedule = d?.schedule_status?.in_schedule;
  const acc = d?.accounts_summary;
  const un = acc?.unavailable;
  const unavailable = [
    un?.daily_limit_hit && `${n(un.daily_limit_hit)} reached their daily limit`,
    un?.slow_ramp_limit_hit && `${n(un.slow_ramp_limit_hit)} at Instantly's slow-ramp limit`,
    un?.disconnected && `${n(un.disconnected)} disconnected`,
    un?.global_gap_not_met && `${n(un.global_gap_not_met)} waiting out the gap between emails`,
  ].filter(Boolean);
  const count = (k: string) => boxes.filter((b) => b.state.key === k);
  const resting = count("resting");
  const easing = count("easing");
  const off = [...count("paused"), ...count("error"), ...count("maintenance")];

  return (
    <section className="card flex flex-col gap-2 p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Why it is or isn&apos;t sending</h3>
        {at && <span className="text-xs text-muted">Instantly, {ago(at)}</span>}
      </div>
      {s ? (
        <p className={healthy || s.status === "out_of_schedule" ? "text-go" : "text-wait"}>
          {healthy ? "Sending normally." : s.status === "out_of_schedule" ? "Outside its sending hours right now; it carries on in the next sending window." : s.status_message}
          {!healthy && s.status !== "out_of_schedule" && s.issue_started_at && <span className="text-muted"> Since {dateTime(s.issue_started_at)}.</span>}
          {s.last_healthy_send_at && <span className="text-muted"> Last sent normally {ago(s.last_healthy_send_at)}.</span>}
        </p>
      ) : (
        <p className="text-muted">Instantly&apos;s sending status appears here at the next sync while the campaign is active.</p>
      )}
      {d && inSchedule !== false && (
        <ul className="list-disc pl-5 text-muted">
          {acc && (
            <li>
              Instantly can send from <span className="num text-ink">{n(acc.available)}</span> of the{" "}
              <span className="num">{n(acc.total_connected)}</span> connected mailboxes{unavailable.length ? `: ${unavailable.join(", ")}` : ""}.
            </li>
          )}
          {d.campaign_daily_limit?.limit ? (
            <li>
              Sent today: <span className="num text-ink">{n(d.campaign_daily_limit.sent)}</span> of the campaign&apos;s{" "}
              <span className="num">{n(d.campaign_daily_limit.limit)}</span>.
            </li>
          ) : null}
          {d.follow_ups_waiting?.count ? <li><span className="num text-ink">{n(d.follow_ups_waiting.count)}</span> follow-ups waiting for their delay.</li> : null}
          {d.leads_status?.no_leads_ready && <li>No contacts are due an email right now.</li>}
          {d.esp_routing_status?.waiting_for_match && <li>Waiting for a mailbox of the same kind as the recipient (ESP matching is on).</li>}
          {d.domain_limiter?.active && d.domain_limiter.domains_at_limit ? (
            <li><span className="num text-ink">{n(d.domain_limiter.domains_at_limit)}</span> companies reached the per-company daily limit.</li>
          ) : null}
        </ul>
      )}
      {d && inSchedule === false && (
        <p className="text-xs text-muted">Outside sending hours Instantly only reports the headline; the detail shows during the sending window.</p>
      )}
      {(resting.length > 0 || easing.length > 0 || off.length > 0) && (
        <p className="text-muted">
          The console:{" "}
          {[
            resting.length && `${resting.length} of its mailboxes ${resting.length === 1 ? "is" : "are"} resting while ${resting.length === 1 ? "it recovers" : "they recover"}`,
            easing.length && `${easing.length} easing in (${easing.map((b) => `${b.ramp?.limit ?? "–"} a day`).join(", ")})`,
            off.length && `${off.length} paused or disconnected`,
          ].filter(Boolean).join("; ")}
          . <Link href={mailboxesHref} className="underline">Mailboxes</Link>
        </p>
      )}
    </section>
  );
}
