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
  {
    id: "sending",
    title: "Emails and sending",
    items: [
      {
        id: "own-subject",
        question: "Can each email in a campaign have its own subject?",
        answer: [
          "Yes. On the campaign's Email tab, fill in a follow-up's subject line, or for an AI-written follow-up tick “Send as a new email with its own subject”. It then arrives as a new email in its own thread.",
          "A follow-up with no subject is sent as a reply in the same thread, under the first email's subject.",
          "Once contacts have a follow-up, it can't gain or lose its subject, though an existing subject can be reworded for emails prepared after that. So set subjects before you add contacts where you can.",
        ],
      },
      {
        id: "schedule",
        question: "Can I schedule a campaign to start later?",
        answer: [
          "Yes. Press Schedule beside Start sending on a campaign that hasn't started, and pick a date and time in the campaign's timezone. You can change it, cancel it or start now at any time before then.",
          "It can start up to 30 minutes after the time you pick. A campaign isn't sent all at once: emails then go out over the following days, within its daily limit and sending hours. A time outside those hours means the first emails wait until they next open.",
          "Approved contacts wait in the console and are checked again as they go, so anyone who has since replied, bounced or unsubscribed stays out. Contacts approved after it starts can still be sent.",
          "If it has no approved contacts or no mailbox that can send at that time, it doesn't start and nothing is sent. The campaign page says why, so you can pick a new time.",
        ],
      },
    ],
  },
];
