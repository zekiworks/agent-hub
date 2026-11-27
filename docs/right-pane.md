# The Workspace (right pane): extensions

The Workspace is the right pane of the website. It holds **Live**, **Home**, **Checklist**, **File**, **Shared**, the
Inbox and pages that extensions serve.

## How an extension plugs in

`packages/server/ui/pane.ts`: an extension registers `{ id, order, scope?, title(), applies(view), render(body, view),
shown?(visible) }`. The Workspace ("like a desktop") holds tabs, one per thing opened in it,
named by what and whose: "Live · @webapp", "Checklist · #launch", "Your inbox". The sigil says what kind of thing it is.

- **Entity extensions** (`scope` "entity", the default: Live, Home, Checklist, File, Shared, an agent's own page)
  open from the conversation's "Workspace ▾" menu, which lists only those whose `applies` is true for it, or
  from their own buttons (the 📌 opens Pinned or the Checklist). Choosing one opens only that one.
- **Global extensions** (`scope` "global": your Inbox, GPUs) open from their top-bar button (✉, a launcher) or the
  rows at the top of the left list. Their button is lit while their tab is shown and, pressed again, gives back
  the tab shown before.

The tab opened last and not pinned is the passing one (in italics), one for entities and one for global items: the
next thing opened replaces it. An entity's passing tab follows the conversation on the left (Checklist · #launch
becomes Checklist · #design); where that conversation has none of it, the tab says so rather than showing something
else. 📌 on a tab pins it to what it shows: it then stays, through conversation changes and reloads
(per browser), and a second click on it while shown opens its conversation on the left. Opening something already in
a tab shows that tab. ✕ on a tab closes it; ✕ at the top (or Esc) hides the Workspace and keeps the pinned tabs. The
tabs are one keyboard stop: ← → move between them, Home and End go to the ends, Delete closes one.

While the tab shown is about the conversation on the left, both headers share a tint in the project's own colour
(desktop only). Every tab has its own part of the body, so switching keeps its scroll position and what was
selected in it; `render` fills it when its subject changes or the extension calls `refreshPane(id)`, never on tab
switches; `shown` tells an extension when it appears or goes (Live streams only then). The width is kept per browser:
420 px by default, the left edge drags (the conversation keeps at least 420 px), double-click resets. At
1100 px and less it covers the conversation; on phones it is full screen, and the tabs scroll sideways.

## One pane, tabs by context

The website's right pane holds extensions. Which tabs show depends on what the main panel shows:

| Main panel | Tabs |
|---|---|
| A conversation | **File** (the viewer for an opened attachment: markdown, plain text, images), **Shared** (every file shared in it), **Checklist** (when the conversation has one) |
| An agent's page | **Live** (its status, session chips and live output; streamed only while this tab is visible and the browser tab is in front; any signed-in person can open it), **Home** (with the status extension), plus the panels it switched on (below) |

## Shared files

Every file attached in the conversation, newest first: name, size, who shared it, when, and a link to its message.
Built from the conversation's messages (`GET /api/conversations/:id/files`, read-checked like its messages), so it
shows exactly what the reader may read; no new storage. Voice messages are left out (they are messages, not shared
files). It updates when a file arrives. The selected file shows under the list: a click selects one, and
while the list has the focus ↑ ↓ move to the previous or next file, Home and End to the first and last, and Enter goes
into the file so the arrows scroll it; Tab reaches the file's Download and #n (its message). The open conversation's selection is kept while the pane is redrawn.

## Agents' own panels

Agents get panels made for them. They are typed panels the Hub knows, filled by the agent with a tool
op and drawn by the website; not agent-written HTML or scripts, which would run in the page people are signed in to.

First type, **Checklist**, is where agents track the instructions people give them: one list per conversation, one
heading per instruction.

- The list: `GET /api/conversations/:id/checklist` gives `{version, pinned, title?, intro?, items, creator, assignees,
  updatedAt, updatedBy, text, ticks}`. Each item is `{id, heading?, text, owner?, source?, blocked?, detail?, done?:
  {by, at}}`: `id` is the Hub's (`i1`, `i2`, …, never reused), `heading` names the instruction (`#123 Launch prep`),
  `owner` is who added it (stored, not parsed from the text), `source` the message it came from (shown as a #n link),
  `blocked` what is missing, `detail` more about it (may span lines). `version` grows with every change: an edit, a
  tick, a pin. `text` and `ticks` are derived from the list for the markdown writers below: `# title`, the intro,
  `## heading`, `- [x] text` with the detail indented under it.
- Agents change it with `POST …/checklist/edit` `{from, base, ops, assignees?}`: the operations are applied together,
  only if `base` is the current version (0: no list yet, which creates it), else 409 with `{error, checklist}`: the
  writer reads the list it got back and applies its own changes again, never retrying the same call blindly.
  Operations: `{op: "add", heading?, text, source?, detail?}` (owner: the writer), `{op: "update", id, text?, heading?,
  blocked?, detail?}` (`""` clears `blocked`, `detail` or `heading`), `{op: "remove", id}`. Any member adds; an agent updates and removes
  only its own items, people who are members any item. Rewording keeps the id and the done state.
- Ticks: `POST …/checklist/tick` `{from, id, done, base?}`. People who are members (or assignees) tick and untick any
  item; an agent only its own, and it never unticks a person's tick. Every tick is a new version. No message per tick:
  that would start a paid turn each time; agents read ticks back with the list.
- Pinning: a list is pinned when it is made, and counts among the conversation's pinned things (📌). Only people who
  are members unpin and pin it: `POST …/checklist/pin` `{from, pinned}`. Agent writes never change it, and a list
  with every item done stays pinned. An unpinned list leaves the pin count but stays in the Workspace's Checklist tab,
  with a Pin button (Unpin while pinned).
- The tool: `message-bus` op=checklist (every harness; Hermes keeps its own copy). With `to` or `message_id` (that
  message's conversation) it reads the list; with `base` and `ops` it edits; `tick`/`untick` take item ids. Its
  description gives the routine: when a person gives instructions, add the steps under a heading naming their message
  (`#n …`) with `source` set; tick a step only when done; set `blocked` with what is missing; update existing steps
  instead of adding duplicates; on a changed list, reread and reapply.
- The markdown PUT from before ids still works for the list's creator: `PUT …/checklist` `{from, text, assignees?,
  base?}`. `- [ ] item` lines under `## heading` lines are matched to items by their exact text, so ids and ticks
  survive; `- [x]` marks an item done; `- [ ]` leaves a tick alone. An agent's PUT keeps the items other agents and
  people own. No text is lost: a `# Title` line before any item is the list's `title`, the
  plain lines before the first item its `intro`, and the plain or indented lines under an item (until the next item
  or heading) its `detail`; a matched item's detail is replaced by the lines under it in the new text, and kept when
  there are none. Lists stored before ids were migrated at startup the same way: items owned by the list's owner,
  ticks matched by text, pinned.
- The website (Checklist tab of the Workspace, wherever a list exists) shows the title as the list's heading, the intro
  under it, the headings, each item's owner (@agent), its source (#n), what blocks it, its detail (muted) and who
  ticked it; members tick there and pin or unpin. Everyone viewing the
  conversation sees changes live (the `checklist` frame); who may read the conversation may read its list.
- Titles, intros, items, headings, blocked notes and details take markdown (bold, italics, `code`, links, `#n`, `@id`). ↩ on an item opens the
  list's conversation with the item quoted in the message box, so a reply reaches the owner with what it answers.

Who sees what: an agent's panels and its Live output are visible to anyone who can see the agent, not only the members
of a conversation it works in. A checklist has a creator (its first writer, who alone uses the markdown PUT) and
assignees (kept when left out). Who ticks and edits: see Checklist above.

## Home: the status extension

The Home tab is an extension, `packages/status-ext`:

- Every hour (one timer for the whole extension) it writes a `status> …` message from the shared `@system` identity
  to every online agent: "what changed since your last update?", reminding it that tables, links and graphs
  (`/inline{#1}`) read well there. The stored `systemSource: "status"` routes replies to the status extension; the
  prefix is not parsed. It wakes nobody: agents answer at their next turn. It skips an agent that has not seen its
  last ask yet (the Hub's receipt): one in a long turn answers after it anyway, so asks do not pile up.
- Replies to `status>` messages are the updates: kept in `<data dir>/status/status.sqlite` and shown on the agent's
  Home tab, newest first, each a pane (Markdown with tables, links, `/inline{#n}` images), refreshed every 30 s. A
  reply of just `NO_UPDATES` (or "No change.") is one small bar, "No updates since <the update before it>": written
  once, never changed, and further NO_UPDATES add nothing until a real update comes.
- Configured as `--ext 'status=http://127.0.0.1:7833,agents=Home'`: `agents=LABEL` makes a page a tab on every
  agent's page (the frame gets `?agent=<id>`). There is no slash command.

## Pages the Hub serves

A service with its own web page (a GPU dashboard, a progress board) shows in the Workspace. Configured with
`agent-bus serve --ext NAME=URL[,launcher=LABEL]` (repeatable). Without a launcher the page is an entity extension that
belongs to NAME: a tab of the project @@NAME and of the DM with agent NAME (e.g.
`--ext webapp=http://127.0.0.1:8899`). With one it is global: a top-bar button LABEL opens it from any
conversation, no agent needed (e.g. `--ext gpudash=http://127.0.0.1:3420,launcher=GPUs`). The Hub lists the names in
`GET /api/state` (`extensions`, and `launchers`: name → label) and serves each page at `/ext/NAME/KEY/…`, forwarding
to `URL/…`:

- Signed-in people only. A frame cannot send the session header, so the key rides in the path: the signed file key
  the website already holds. It is valid for a day, and only while its person has at least one signed-in session;
  anyone holding it can open the page until then. A page that uses relative URLs
  (`app.js`, `api/stream`, not `/app.js`) carries it along with no code of its own; `/ext/NAME/KEY` without the
  slash is redirected to the slashed address.
- GET and HEAD only; server-sent event streams pass through unbuffered. Only the page's content headers come back
  (no cookies); CORS is open, since the frame runs without the website's origin.
- The tab, named NAME (in @@NAME and NAME's DM), holds the page in a frame with `sandbox="allow-scripts allow-popups
  allow-popups-to-escape-sandbox"` and `allow="clipboard-write"`: scripts run, but the page cannot read the website's
  storage or session. The frame is drawn once and kept while conversations change, so a live page does not reload.
- The pane is about 360 to 700 px wide: the page should fit narrow widths; links to its full view use
  `target="_blank"`.

A GPU dashboard can run as `--ext gpudash=http://127.0.0.1:3420,launcher=GPUs`, so GPUs open from the top bar; the
older dialog stays as "GPU booking" under Tools.

### Talking to the website

A page fills the person's message box, never sends. Each ends in the person reading, finishing and pressing Send.

- From the frame: `parent.postMessage({type: "agent-bus:compose", to: "logic", text: "About your hold on …: "}, "*")`.
  Heard only from the website's own extension frames; `to` is one participant id (an `@` is dropped), not the person
  themselves; `text` is at most 500 characters. The website opens the DM with `to` (or a new one), puts `text` at the
  top of its box with the cursor right after it (what was in the box stays below); on phones the pane closes so the
  box shows. Anything else is ignored.
- From outside the website (the page opened on its own): a link `https://HUB/#/to/<id>?draft=<url-encoded text>`, same
  rules. Opened while signed out, the address is kept through signing in.
- To the frame: `{type: "agent-bus:pointerleave"}` while the pointer moves over the website (at most one per 250 ms),
  since a pointer jumping straight out of a frame gives the page no mouseleave and leaves its hover stuck. Check
  `event.source === parent`.
- GPU actions: `parent.postMessage({type: "agent-bus:gpu", action, resource?, reservation?}, "*")`
  with `action` one of `book` (with `resource`: its label, e.g. "HOST GPU 2", or id), `release`, `extend`, `mode`
  (with `reservation`: the hold's id), `subscribe`. The website opens its GPU booking dialog at that GPU or hold and
  outlines the control; the person clicks it (the page performs nothing). A hold that is gone or not the person's
  says so; strings over 200 characters and unknown actions are ignored.
- To the frame, about the person: `{type: "agent-bus:viewer", id: "maya"}` once the page loads (offer Release, +2 h and
  shared/private only on that person's holds; the Hub checks ownership anyway), and `{type:
  "agent-bus:resources-changed"}` whenever the booking dialog closes (refresh the schedule now). The page that asked
  also gets `focus: {action, resource?, reservation?}`, what it asked for, and the keyboard: after redrawing, it puts
  focus back on that control, or a sensible neighbour if it is gone (a Release removes its hold's buttons). Nothing
  else: no keys, no messages.

## Services the message box asks

Not every extension is a page. `agent-bus serve --ext NAME=URL,box=ROLE` is a service the
message box asks while a person types; it gets no Workspace tab. `GET /api/state` lists these in `boxes` (name →
role), not in `extensions`. Three roles: "complete" (typing suggestions, below), "recipient" ("Ask @agent", after),
and "needs" (the Inbox's "Waiting for your answer", see [projects.md](projects.md#tasks)).

- The website, when that person has turned "Suggest how to go on while I type" on (Settings; off by default, per
  browser), asks on every change of the draft with the cursor at its end: `POST /api/box/NAME` `{conversationId,
  text}`, one at a time (the newest draft goes when the answer is back). An answer shows in grey after the
  cursor while it still fits: typing its letters keeps showing the rest, other letters hide it. Tab adds it (→ one
  word) and a space after it; a punctuation mark typed next goes back next to the word, a space typed next is not
  doubled. Escape drops it and what is on its way, Enter still sends what was typed. Nothing is asked or shown while an input method
  composes. Touch screens (no Tab) show the whole word as a chip in the row of buttons under the
  text, where it never moves the box; off on phones too until ticked.
- The Hub answers only a signed-in person, only for a conversation they may read (agents get 403). It sends the
  service `POST URL/complete` with a `BoxCompleteBody` (packages/protocol): `{v: 1, kind: "complete", me,
  conversation: {id, kind, name?, title?, members}, messages: the latest 20 (deleted ones left out), draft: {text}}`,
  and passes back `{text}` (`""` when the service has nothing; longer than 200 characters is dropped). One request per
  person is in flight: a newer one cancels it, as does closing the request, and after 3 s it gives up. Nothing is
  stored.
- The body is versioned: the Hub may add fields, and a service ignores what it does not know; a change in meaning
  raises `v`.
- The first service is `packages/complete-ext`, which asks a small model served by llama-server (the reference Hub
  uses LFM3 1.7B on a CPU, about 0.15–0.4 s per answer). It shows at most eight words, stops at the end of a phrase,
  and never copies an earlier message whole. To run it:
  `COMPLETE_PORT=7830 COMPLETE_LLAMA_URL=http://127.0.0.1:9962 COMPLETE_HEAL=0 bun run packages/complete-ext/src/server.ts`,
  with `llama-server -m LFM3-1.7B-BF16.gguf --port 9962 -ngl 0`, then pass
  `--ext complete=http://127.0.0.1:7830,box=complete` to `agent-bus serve`. How it decides what to show:
  [packages/complete-ext/README.md](../packages/complete-ext/README.md).
- **Its model trained on the Hub's own messages:** `agent-bus train-suggestions` fine-tunes LFM3 1.7B (a LoRA) on
  this machine. Training uses `#all` and non-DM conversations containing every selected person; by default that means
  every person on the Hub, and a private room can qualify. It tests the result against the current model and replaces
  the model file only when it is better (it restarts nothing). How, and its privacy:
  [INSTALL.md](../INSTALL.md#typing-suggestions-trained-on-your-own-messages-optional); the code:
  `packages/complete-ext/finetune/`.
- **The word being typed** is completed in the page itself, with or without that service (`packages/server/ui/words.ts`):
  English and Turkish word lists built from Tatoeba's sentences (CC BY 2.0 FR) by
  `packages/server/scripts/build-words.ts`, about 0.5 MB each over the wire (gzipped, then "not modified"). A word is
  ranked by how often it follows the word before it, smoothed by interpolated Kneser-Ney ("into a t" → "tab", "on the
  t" → "table"), plus the open conversation's own words ("checklist", names). Letters are offered while 70% of the
  weight goes the same way, so a sure start of several forms counts too ("toplant" → "toplantı"). Turkish typed
  without ç ğ ı ö ş ü finds its words and goes on without them. Mid-word the word list has the say; the service's
  words show only when they go on from the same word, and Turkish drafts (by the lists) are not sent to it.

### "Ask @agent": the recipient role (prototype)

While a person writes in a room without naming anyone, the box may offer one agent to ask ("Ask @webapp"); a tap puts
`@webapp ` at the front of the draft, which is then edited and sent as usual (`packages/server/ui/ask.ts`).

- Asked only for a person's draft in a room (`room: true`) with at least two agents besides them, of at least 8
  characters, after a 0.7 s pause in typing, and never when the person chose: a member named, `@all`, Reply or a
  checklist item answered. One request at a time; an answer counts only for the exact draft and room it was asked
  about, so an edit, another room or Send drops it. Sending never waits for it.
- The Hub sends `POST URL/recipient` a `BoxRecipientBody` (packages/protocol): the draft, the room's latest 20
  messages with their authors (`fromKind`) and what they answer, its checklist steps with owners and status, and the
  eligible `agents`. It passes back `{recipient, confidence}` only when `recipient` is one of those agents, else
  `{recipient: null}`; it gives up after 8 s. An offer of the agent the message wakes anyway (the last one who wrote)
  is passed on as `{recipient: null}` too: it would only repeat what Send does.
- The service (`packages/ask-ext`) asks a decision model one choice question, "Which agent has the best evidence to
  answer this person?", over the agent ids plus `none`, and applies a confidence cut-off. Default model LiquidAI
  d1-2B on the Hub's processor (llama.cpp); fastino/GLiDE-2B is compared on a GPU.
- An add-on: off until the person ticks "Suggest which agent to ask" in Settings (per browser; shown
  only when the Hub has a recipient box).
- Its use is recorded: after each message sent in such a room with the add-on on, the page posts
  `POST /api/box/NAME/report {conversationId, outcome, recipient?, confidence?, ms?, failed?}` and the Hub appends a
  line to `box-reports.jsonl` in its data folder: taken, ignored, named-other (offered, someone else named), named,
  quiet, reply. Never the text. `bun packages/ask-ext/eval/usage.ts [--since DATE]` counts it. The record stays on
  the Hub's own machine; no Hub reports anywhere by itself.
- Sharing them is the person's choice: Settings → Ask @agent → "Share my Ask @agent counts"
  shows that person's own counts (`GET /api/box/NAME/usage`: per outcome, offered and taken, answer time, failures,
  first and last day, version; no conversation ids, names or text), and a second button opens a prefilled issue on
  the Agent Hub repo (`SHARE_REPO_URL` in ui/settings.ts). Nothing goes until they submit it there.
