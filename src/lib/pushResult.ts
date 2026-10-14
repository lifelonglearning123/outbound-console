/** What a send did, shared by the server send and the pages that report it. */

/** Handed over, refused by Instantly, and why the rest stayed behind. */
export type PushResult = { pushed: number; skipped: number; held: number; waiting: number; stopped: number };

export const NO_PUSH: PushResult = { pushed: 0, skipped: 0, held: 0, waiting: 0, stopped: 0 };

export function addPushes(a: PushResult, b: PushResult): PushResult {
  return {
    pushed: a.pushed + b.pushed,
    skipped: a.skipped + b.skipped,
    held: a.held + b.held,
    waiting: a.waiting + b.waiting,
    stopped: a.stopped + b.stopped,
  };
}

/** A send result in words, for the message after pressing Send. */
export function describePush(r: PushResult): string {
  const parts = [
    r.pushed ? `${r.pushed} handed to the sender` : "Nothing new was handed to the sender",
    r.held && `${r.held} held because their mail filter is paused`,
    r.waiting && `${r.waiting} waiting because they're still in another campaign's sequence`,
    r.stopped && `${r.stopped} set aside because they replied, bounced or unsubscribed elsewhere`,
    r.skipped && `${r.skipped} refused by Instantly (see their row on Contacts)`,
  ].filter(Boolean);
  return parts.join(". ") + ".";
}
