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
      {
        id: "take-out",
        question: "A contact is stuck in another campaign. How do I move them to a new one?",
        answer: [
          "Take them out of the campaign that holds them. Open that campaign's Contacts tab, tick them and press Take ticked contacts out. To do many at once, set Status to “With the sender, sequence not finished” and use the button above the list.",
          "This works at any point: before they've been handed to the sender, while they're queued, or part-way through the sequence. Anyone already with the sender is removed there too, so that campaign emails them nothing more. Emails already sent stay on their record.",
          "They're then free straight away. If another campaign had them approved and waiting, they go to it by themselves; otherwise add them to the new campaign as usual. The Approvals tab of the waiting campaign names the campaign holding them and links to it.",
          "Someone who replied, bounced or unsubscribed stays suppressed whichever campaign they're in.",
        ],
      },
      {
        id: "unable-to-verify",
        question: "Why does a real email address, such as my own Yahoo address, show “Unable to verify”?",
        answer: [
          "It doesn't mean anything is wrong with the address, only that the check couldn't confirm it exists. The check asks the mail server whether the address exists, without sending anything, and it doesn't always get a clear answer.",
          "This is common for two kinds of address: companies whose mail server accepts every address, and providers such as Yahoo, which reportedly don't give a straight answer, to stop spammers harvesting real addresses. So expect good Yahoo addresses to show this too.",
          "These contacts can still be sent to. They wait under Unconfirmed, your call on the Approvals tab until you approve them. Sending is the real test: the email may arrive or it may bounce, so send a few at a time and watch the bounce figure on the Sending tab.",
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
          "Once contacts are with the sender, a follow-up they have can't gain or lose its subject. An existing subject can still be reworded for everyone not yet sent.",
        ],
      },
      {
        id: "edit-email",
        question: "What happens if I change an email after contacts are prepared or approved?",
        answer: [
          "Anyone not yet sent gets the new version. That email is prepared again for them and needs approving again, and any other emails in their sequence keep their approval. Edits made to that email one by one are replaced, so make them after you've finished changing it.",
          "Contacts already with the sender keep the emails they have. Changing only the wait between emails doesn't need anything approving again.",
        ],
      },
      {
        id: "tidy-up",
        question: "How do I remove a campaign I no longer need?",
        answer: [
          "On the campaigns list, a campaign with no contacts that has never sent can be deleted. A finished campaign, or one with contacts that hasn't started, can be archived: it moves to the Archived list under the table, and you can restore it at any time.",
          "A campaign with contacts can't be deleted, because its history is what stops those people being emailed again. A campaign that's sending or paused can't be archived, because it could still email someone.",
        ],
      },
      {
        id: "when-sent",
        question: "I pressed Start sending. When do the emails actually go, and how do I know they went?",
        answer: [
          "Emails only go out on the campaign's sending days, between its From and To hours, up to its daily cap. Start outside those hours and the first ones wait until they next open. The line under the campaign's name always says which: “Sending now”, “First emails go out today from 08:30”, or “Today's emails are sent. Next ones go out tomorrow from 08:30”.",
          "The same line shows how many went today, when the last one went and from which mailbox. The console checks every 30 minutes, so an email can take up to half an hour to show.",
          "For one person, open the Contacts tab: the Emailed column shows when their email went and which mailbox sent it.",
        ],
      },
      {
        id: "new-mailbox",
        question: "Can I send from a mailbox that's resting or still warming up?",
        answer: [
          "A new mailbox warms up for about two weeks. You can tick it for a campaign before then and it will send, but the form warns you: emails from a new mailbox are more likely to land in spam, which can hurt its domain for a long time. If you go ahead, keep the daily cap low. New campaigns leave it unticked until it's ready.",
          "A resting mailbox is one the console has taken out of sending because of bounces or warmup trouble; its warmup carries on. If a campaign also has other mailboxes, it sends from those and the resting one rejoins by itself.",
          "If every mailbox a campaign sends from is resting, the campaign waits: it shows “Waiting for a mailbox”, sends nothing, and starts by itself when one is back. To start sooner, tick another mailbox on the Email tab, or press Send anyway to send from the resting ones.",
        ],
      },
      {
        id: "schedule",
        question: "Can I schedule a campaign to start later?",
        answer: [
          "Yes. Press Schedule at the top of a campaign that hasn't started, then pick one of the suggested days, or a date, hour and minute, in the campaign's timezone. You can change it, cancel it or start now at any time before then.",
          "It can start up to 30 minutes after the time you pick. A campaign isn't sent all at once: emails then go out over the following days, within its daily limit and sending hours. A time outside those hours means the first emails wait until they next open.",
          "Approved contacts wait in the console and are checked again as they go, so anyone who has since replied, bounced or unsubscribed stays out. Contacts approved after it starts can still be sent.",
          "If it has no approved contacts or no mailbox that can send at that time, it doesn't start and nothing is sent. The campaign page says why, so you can pick a new time. If its mailboxes are only resting, it waits for one to come back instead.",
        ],
      },
    ],
  },
];
