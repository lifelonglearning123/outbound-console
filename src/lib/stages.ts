/** What each internal lead stage is called on screen. One place, so every list says the same thing. */
export const STAGES: { key: string; label: string; tone: string }[] = [
  { key: "new", label: "Added", tone: "text-muted" },
  { key: "drafting", label: "Preparing email", tone: "text-info" },
  { key: "review", label: "Ready to send", tone: "text-go" },
  { key: "approved", label: "Approved, not sent yet", tone: "text-go" },
  { key: "pushed", label: "Sending", tone: "text-go" },
  { key: "rejected", label: "Not sending", tone: "text-muted" },
  { key: "error", label: "Problem", tone: "text-bad" },
  { key: "extending", label: "Preparing follow-ups", tone: "text-info" },
  { key: "extend_review", label: "Follow-ups ready to send", tone: "text-wait" },
  { key: "extend_approved", label: "Follow-ups approved", tone: "text-go" },
  { key: "extend_rejected", label: "Leaving at release", tone: "text-muted" },
  { key: "extend_error", label: "Follow-ups failed", tone: "text-bad" },
  { key: "removed", label: "Removed", tone: "text-muted" },
];

export const stageLabel = (key: string) => STAGES.find((s) => s.key === key)?.label ?? key;
export const stageTone = (key: string) => STAGES.find((s) => s.key === key)?.tone ?? "";

/** Where a contact is, in the user's words, taking the address check into account. */
export function contactStatus(stage: string, verification: string | null): { label: string; tone: string } {
  if (stage === "new" && (verification === "queued" || verification === "pending")) return { label: "Checking address", tone: "text-info" };
  if (stage === "new" && !verification) return { label: "Address not checked", tone: "text-muted" };
  if (stage === "rejected" && verification === "invalid") return { label: "Invalid address, set aside", tone: "text-bad" };
  if (stage === "review" && verification === "verified") return { label: "Ready to send", tone: "text-go" };
  if (stage === "review" && verification === "catch_all") return { label: "Unconfirmed, your call", tone: "text-wait" };
  if (stage === "review") return { label: "Prepared, address not checked", tone: "text-muted" };
  return { label: stageLabel(stage), tone: stageTone(stage) };
}

/** Groupings for the contacts list. */
export const CONTACT_GROUPS: { key: string; label: string; tone: string; where: string }[] = [
  { key: "verified", label: "Verified", tone: "text-go", where: "verification = 'verified'" },
  { key: "catch_all", label: "Unable to verify", tone: "text-wait", where: "verification = 'catch_all'" },
  { key: "invalid", label: "Invalid", tone: "text-bad", where: "verification = 'invalid'" },
  { key: "checking", label: "Checking", tone: "text-info", where: "verification IN ('queued', 'pending')" },
  { key: "unchecked", label: "Not checked", tone: "text-muted", where: "verification IS NULL" },
];

/** Campaign status, in the user's words. */
export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: "Not started",
  active: "Sending",
  paused: "Paused",
  completed: "Finished",
  error: "Problem",
};
