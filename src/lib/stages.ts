/** What each internal lead stage is called on screen. One place, so every list says the same thing. */
export const STAGES: { key: string; label: string; tone: string }[] = [
  { key: "new", label: "Added", tone: "text-muted" },
  { key: "drafting", label: "Preparing email", tone: "text-info" },
  { key: "review", label: "Waiting for approval", tone: "text-wait" },
  { key: "approved", label: "Approved, not sent yet", tone: "text-go" },
  { key: "pushed", label: "Sending", tone: "text-go" },
  { key: "rejected", label: "Not sending", tone: "text-muted" },
  { key: "error", label: "Problem", tone: "text-bad" },
  { key: "extending", label: "Preparing follow-ups", tone: "text-info" },
  { key: "extend_review", label: "Follow-ups waiting for approval", tone: "text-wait" },
  { key: "extend_approved", label: "Follow-ups approved", tone: "text-go" },
  { key: "extend_rejected", label: "Leaving at release", tone: "text-muted" },
  { key: "extend_error", label: "Follow-ups failed", tone: "text-bad" },
  { key: "removed", label: "Removed", tone: "text-muted" },
];

export const stageLabel = (key: string) => STAGES.find((s) => s.key === key)?.label ?? key;
export const stageTone = (key: string) => STAGES.find((s) => s.key === key)?.tone ?? "";

/** Campaign status, in the user's words. */
export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: "Not started",
  active: "Sending",
  paused: "Paused",
  completed: "Finished",
  error: "Problem",
};
