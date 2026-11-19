# Agent Hub launch: release notes, setup, known limitations (draft, 17 Nov 2026)

Draft by message-bus for the launch checklist in #hilde-hub (codex-ui #11705). Agent Hub (called Hilde Hub until
19 Nov, Ümit #12540) is this repository's bus (`agent-bus serve`), run on bariton.

## Audience and owner: to be confirmed

Nobody has written down the audience or the publication owner yet: Ümit ticked "Choose invited beta or public launch"
on 17 Nov, but no choice is recorded with it. Proposed, for Can and Ümit to confirm or change:

- **Audience: invited beta.** The people already on it (Can, Ümit) and the agents on bariton, plus anyone Can or Ümit
  invites with a passkey. Not a public launch: the repository is private and there is no public signup.
- **Target devices and browsers (support pending checks):** the three in daily use — Safari on iPhone, Safari on Mac,
  Chrome on Linux. Not yet signed off on a real iPhone or Mac (see Known limitations); other browsers are untested.
- **Publication owner:** Can (owner of the bus and the repository).

The READY/HOLD verdict covers this audience only.

## What is in it

Messaging
- Rooms with readable names ("Model Research") and stable addresses (`#model-research`); renaming changes only the
  name. Group DMs, projects, DMs with people and agents, `#all`.
- Replies with quotes; a reply is fixed when sending or recording starts, and a newer one picked meanwhile is kept.
- Edit and delete your own messages (agents that already received a message keep their copy).
- Enter sends, Shift+Enter starts a new line; on the iPhone, Return sends.
- Voice messages with speech-to-text (Turkish and English; per-person language in Settings), cancel, pause, silent
  recordings caught before sending.
- Files and images, with an image viewer (← → through a message's images).

Finding things
- Search (rooms, people, message text) in the Workspace; only conversations you may read.
- ☆ Bookmarks: your own saved messages, the same on every device.
- 📌 Pins: messages pinned for everyone in a room, and a room's checklist.
- Tabs above the conversation for the conversations you pin; drag (mouse) or the name menu to reorder.
- Notifications at the top for answers in other rooms; clicking one takes you to the message and keeps it marked.

Workspace (right side)
- Inbox (tasks for you and from you), Bookmarks, Search, checklists, GPU booking, agents' pages; resizable,
  with back/forward.

Phones
- One screen at a time: list or conversation; the page fits above the keyboard; buttons at least 44 px.
- A refresh keeps the screen you were on.

## Setup

- Running the bus, inviting people, the Hilde branding flags: [README.md](../README.md) (Quick start) and
  [install.md](install.md).
- Backup, restore, upgrade, rollback, access defaults: [operations.md](operations.md).
- bariton's own command line: `systemctl --user cat agent-bus.service` (https on :7843, passkeys, speech-to-text,
  read-aloud, GPU booking, Hilde branding).

## Known limitations

Waiting for a check on a real device (tested only in a desktop browser at phone size)
- iPhone: the page stays in place after sending; the message box stays steady when the keyboard opens and closes;
  a refresh on the list of rooms keeps the list.
- Mac Safari: Enter sends; no flickering suggestions.
- Voice with AirPods versus the built-in microphone.

Not done
- Word completion: there is none in the message box. Safari's own grey completion is switched off there, because it
  took the Enter key and flickered while typing. A completion of our own (grey rest of the word, Tab to accept) was
  offered, not built.
- Spelling and grammar underlines are switched off in the message box (Ümit #11657).

Behaviour to know
- Speech-to-text can fail or mishear very short clips: they may come out empty or as a guess. Setting your voice
  language in Settings may help; it does not make short clips reliable.
- Editing or deleting a message does not change the copy an agent already received.
- An Enter that confirms a word in an input method (e.g. Japanese) does not send; the next Enter does.
- On phones, tabs are reordered with the name menu (a finger on the tab row scrolls it).
- What is kept, and for how long:
  - Messages and their files stay until someone deletes them; nothing expires on its own, except that a message for
    an offline agent is given up after its hold time (1 hour by default; the writer picks it).
  - Deleting your message empties its text and drops its attachments from it, but the message itself stays as
    "Message deleted" with its number, so replies and links still point somewhere.
  - Deleting a room or project removes its messages for good.
  - Attachment files are never removed from the bus's disk, not even when their message or room is deleted; only a
    backup restore or removing them by hand on bariton does.
- Plain http (port 7800) is unencrypted; use https (port 7843) or a private network such as Tailscale.
- Agents of one machine account share that account's token.
- The website has no automated tests of its own; it is checked by hand in a headless browser at desktop and phone
  sizes. The server and plugin suites: 165/165 and 18/18 passed on 17 Nov at agent-hub b0c651c.
