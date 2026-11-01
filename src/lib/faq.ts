/**
 * The questions people ask about the console, answered with where to click. Content, not code: each answer is a list
 * of blocks, a string for a paragraph and an array of strings for a list. Keep the answers in step with the rules they
 * describe (DO_NOT_CONTACT and importLeads in leads.ts, bouncedGroups in people.ts), and the names with what the pages say.
 * Every client reads this, so it holds no client's numbers.
 */

export type FaqBlock = string | string[];
export type FaqItem = { id: string; question: string; answer: FaqBlock[] };
export type FaqSection = { id: string; title: string; items: FaqItem[] };

export const FAQ: FaqSection[] = [
  {
    id: "contacts",
    title: "Contacts and suppression",
    items: [
      {
        id: "bounced",
        question: "Will the console automatically suppress contacts who bounced?",
        answer: [
          "Yes, across all of the client's campaigns, not only the one where it happened. The console checks when contacts are added and again just before sending, and it hears about a new bounce within about 30 minutes.",
          "The same goes for anyone who replied (an out-of-office doesn't count), unsubscribed, or has an invalid address. Bounces, replies and unsubscribes in campaigns run outside the console count too.",
          "There's one exception, on purpose: an address that passed the check, at a company behind a mail filter such as Mimecast. The address exists and the filter refused the email, so that person can join a new campaign. New campaigns hold Mimecast back by default, so they aren't emailed unless you resume that filter under Mail filters on the Contacts tab.",
          "Bounced contacts are also tagged “email bounced” in the Nexus Portal. To delete them there, open a campaign's Contacts tab or the client's Stats page, set Status to Bounced, and use the delete panel. It leaves out checked addresses a mail filter refused, and anyone who replied or booked a meeting. The console keeps its own record, so deleted contacts stay suppressed.",
          "The tag also goes on contacts a mail filter refused, so take care if you bulk delete by that tag in the Nexus Portal itself.",
        ],
      },
      {
        id: "reload",
        question: "Do we have to reload contacts for a new campaign under the same client?",
        answer: [
          "Yes. Each new campaign starts empty, and there's no button to copy contacts from an earlier one. On the campaign's Contacts tab, use Add contacts and choose From Nexus Portal, CSV file or Type it in.",
          "To keep a campaign topped up, set a Nexus Portal tag on its Email tab: contacts carrying that tag join at each sync. A campaign run from Nexus gets its contacts from Nexus when it starts.",
        ],
      },
      {
        id: "remembered",
        question: "Will the console remember suppressed contacts if we reload from the Nexus Portal?",
        answer: [
          "Yes, so reloading is safe. Across all of the client's campaigns, the console remembers:",
          [
            "Invalid addresses, bounces, replies and unsubscribes: they're turned away and not added again.",
            "Address check results: anyone already checked keeps their result, so no credits are spent checking them again.",
            "Results already on the contact as Nexus Portal tags (“Email Verified”, “Email Unable To Verify”, “Email Invalid”): these are used instead of a new check.",
          ],
          "Two things to expect:",
          [
            "Removing a contact from a campaign by hand doesn't suppress them. Load them again and they come back: verified ones under Ready to send, and unconfirmed ones under Unconfirmed, your call. To keep someone out, delete them from the Nexus Portal and leave them out of any CSV file.",
            "A contact is only emailed by one campaign at a time. Someone still in another campaign's sequence can be loaded, but waits until that sequence ends, and a paused campaign counts as still emailing them.",
          ],
        ],
      },
    ],
  },
];
