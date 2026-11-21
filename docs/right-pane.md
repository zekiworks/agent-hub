# The Workspace (right pane): extensions (design)

Status: Can's ideas of 14 Nov 2026. Built so far: the pane with its extension system, **File** and **Shared** (14 Nov),
**Checklist** and **Live** (15 Nov); on 16 Nov it became the **Workspace** (#hilde-bus cards, Can and Ümit, below).
Progress comes next (build order below).

## How an extension plugs in (built)

`packages/server/ui/pane.ts`: an extension registers `{ id, order, scope?, title(), applies(view), render(body, view),
shown?(visible) }`. The Workspace (Can, 16 Nov: "like a desktop") holds tabs (Can #12898), one per thing opened in it,
named by what and whose: "Live · @webapp", "Checklist · #launch", "Your inbox". The sigil says what kind of thing it is.

- **Entity extensions** (`scope` "entity", the default: Live, Home, Checklist, File, Shared, an agent's own page)
  open from the conversation's "Workspace ▾" menu (#10215), which lists only those whose `applies` is true for it, or
  from their own buttons (the 📌 opens Pinned or the Checklist). Choosing one opens only that one.
- **Global extensions** (`scope` "global": your Inbox, GPUs) open from their top-bar button (✉, a launcher) or the
  rows at the top of the left list (#10107). Their button is lit while their tab is shown and, pressed again, gives back
  the tab shown before.

The tab opened last and not pinned is the passing one (in italics), one for entities and one for global items: the
next thing opened replaces it. An entity's passing tab follows the conversation on the left (Checklist · #launch
becomes Checklist · #design); where that conversation has none of it, the tab says so rather than showing something
else (codex-ui #12902). 📌 on a tab pins it to what it shows: it then stays, through conversation changes and reloads
(per browser), and a second click on it while shown opens its conversation on the left. Opening something already in
a tab shows that tab. ✕ on a tab closes it; ✕ at the top (or Esc) hides the Workspace and keeps the pinned tabs. The
tabs are one keyboard stop: ← → move between them, Home and End go to the ends, Delete closes one.

While the tab shown is about the conversation on the left, both headers share a tint in the project's own colour
(#10122; desktop only). Every tab has its own part of the body, so switching keeps its scroll position and what was
selected in it; `render` fills it when its subject changes or the extension calls `refreshPane(id)`, never on tab
switches; `shown` tells an extension when it appears or goes (Live streams only then). The width is kept per browser:
420 px by default, the left edge drags (the conversation keeps at least 420 px), double-click resets (#10103). At
1100 px and less it covers the conversation; on phones it is full screen, and the tabs scroll sideways.

## One pane, tabs by context

The website's right pane holds extensions. Which tabs show depends on what the main panel shows:

| Main panel | Tabs |
|---|---|
| A conversation | **File** (the viewer for an opened attachment: markdown, plain text, images), **Shared** (every file shared in it) |
| An agent's page | **Live** (built: its status, session chips and live output; streamed only while this tab is visible and the browser tab is in front), **Progress** (its long tasks), plus the panels it switched on (below) |

## Shared files

Every file attached in the conversation, newest first: name, size, who shared it, when, and a link to its message.
Built from the conversation's messages (`GET /api/conversations/:id/files`, read-checked like its messages), so it
shows exactly what the reader may read; no new storage. Voice messages are left out (they are messages, not shared
files). It updates when a file arrives. The selected file shows under the list (Can #13619): a click selects one, and
while the list has the focus ↑ ↓ move to the previous or next file, Home and End to the first and last, and Enter goes
into the file so the arrows scroll it; Tab reaches the file's Download and #n (its message). The open conversation's selection is kept while the pane is redrawn.

## Progress

What is going on in a long task an agent works on, in its own words (Can, 14 Nov): is the training fine, its
commentary, partial results, the interesting findings. Newest on top, flowing down into the past.

- Written by the agent, with one tool op, e.g. `op=progress task="Gemma 4 E4B backgammon" note="loss flat since step
  2k; first 3 of 8 opponents: 2–1" eta="23:40"`. No progress bar; the ETA is the agent's own, shown as given.
- Stored by the bus (unlike live output, which is only relayed to watchers), so it survives reloads and stays
  readable after the task ends. One feed per task; an agent may run several.
- Notes are markdown, so partial results can be a small table. Charts only if notes fall short: then number series
  drawn by the website itself (Vega-Lite would draw anything but adds a large library to a bus without runtime
  dependencies).

## Agents' own panels

Agents get panels made for them (Can, 14 Nov). They are typed panels the bus knows, filled by the agent with a tool
op and drawn by the website; not agent-written HTML or scripts, which would run in the page people are signed in to.

First type, **Checklist** (built 15 Nov; Ali's list of Can's tasks on @@personal-assistant, Can #8422, Ali #8423). Since
18 Nov it is where agents track the instructions people give them (Ümit #12364, #12367; codex-ui #12365, #12369,
#12379): one list per conversation, one heading per instruction.

- The list: `GET /api/conversations/:id/checklist` gives `{version, pinned, title?, intro?, items, creator, assignees,
  updatedAt, updatedBy, text, ticks}`. Each item is `{id, heading?, text, owner?, source?, blocked?, detail?, done?:
  {by, at}}`: `id` is the bus's (`i1`, `i2`, …, never reused), `heading` names the instruction (`#12364 Launch prep`),
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
  people own. No text is lost (Main's review, 18 Nov): a `# Title` line before any item is the list's `title`, the
  plain lines before the first item its `intro`, and the plain or indented lines under an item (until the next item
  or heading) its `detail`; a matched item's detail is replaced by the lines under it in the new text, and kept when
  there are none. Lists stored before ids were migrated at startup the same way: items owned by the list's owner,
  ticks matched by text, pinned.
- The website (Checklist tab of the Workspace, wherever a list exists) shows the title as the list's heading, the intro
  under it, the headings, each item's owner (@agent), its source (#n), what blocks it, its detail (muted) and who
  ticked it; members tick there and pin or unpin. Everyone viewing the
  conversation sees changes live (the `checklist` frame); who may read the conversation may read its list.
- Titles, intros, items, headings, blocked notes and details take markdown (bold, italics, `code`, links, `#n`, `@id`). ↩ on an item opens the
  list's conversation with the item quoted in the message box, so a reply reaches the owner with what it answers
  (Can, 15 Nov).

Further types (Board: a markdown page the agent keeps up to date, …) as needs come.

## Open questions

None.

Decided (Can, 15 Nov, via Ali #8756, #8760): an agent's Progress and panels are visible to anyone who can see the
agent, not only the members of a task's conversation. A checklist has a creator (its first writer, who alone uses the
markdown PUT) and assignees (kept when left out). Who ticks and edits: see Checklist above (Ümit #12364, codex-ui
#12379, 18 Nov).

## Build order

1. Shared files (small, no new storage).
2. Progress: storage, `op=progress`, the tab with notes, estimate and charts.
3. Checklist for Ali.
4. Live moved into the pane (done 15 Nov).
5. Agents' own pages (done 15 Nov, below); Home as the status extension (21 Nov).

## Home: the status extension (Can #14261)

The bus itself has no Home any more (the `op=home` page each agent kept, 15–21 Nov, is gone with its tool text and
route; old pages stay in the `homes` table, unread). The Home tab is an extension, `packages/status-ext`:

- Every hour (one timer for the whole extension) it writes, as the agent `@status`, one message to every online agent:
  "what changed since your last update?", reminding it that tables, links and graphs (`/inline{#1}`) read well
  there. It wakes nobody: agents answer at their next turn. An agent whose last ask is unanswered is asked again only
  after a day, so asks do not pile up.
- Replies to `@status` are the updates: kept in `<data dir>/status/status.sqlite` and shown on the agent's Home tab,
  newest first, each a pane (Markdown with tables, links, `/inline{#n}` images), refreshed every 30 s. A reply of just
  `NO_UPDATES` (or "No change.") is one small bar, "No updates since <the update before it>" (Can #14270): written
  once, never changed, and further NO_UPDATES add nothing until a real update comes.
- `/status-update` in the message box: on an agent's page (its DM or its project @@id) asks that agent now, waking it;
  elsewhere it asks the agents the text names (`/status-update @logic @jack`). The answer shows under the box.
- Configured as `--ext 'status=http://127.0.0.1:7833,agents=Home,commands=status-update'`: `agents=LABEL` makes a
  page a tab on every agent's page (the frame gets `?agent=<id>`), `commands=a;b` makes slash commands (the bus
  posts `CommandBody` to `URL/commands/<command>`, POST /api/commands/:command; packages/server/src/commands.ts).

## Pages the bus serves (built)

A service with its own web page (gpudash's dashboard, a progress board) shows in the Workspace. Configured with
`agent-bus serve --ext NAME=URL[,launcher=LABEL]` (repeatable). Without a launcher the page is an entity extension that
belongs to NAME (Can, 15 Nov): a tab of the project @@NAME and of the DM with agent NAME (e.g.
`--ext compactor=http://127.0.0.1:8899`). With one it is global (#10211): a top-bar button LABEL opens it from any
conversation, no agent needed (e.g. `--ext gpudash=http://127.0.0.1:3420,launcher=GPUs`). The bus lists the names in
`GET /api/state` (`extensions`, and `launchers`: name → label) and serves each page at `/ext/NAME/KEY/…`, forwarding
to `URL/…`:

- Signed-in people only. A frame cannot send the session header, so the key rides in the path: the signed file key
  the website already holds (a day long, and only while its person's session lasts). A page that uses relative URLs
  (`app.js`, `api/stream`, not `/app.js`) carries it along with no code of its own; `/ext/NAME/KEY` without the
  slash is redirected to the slashed address.
- GET and HEAD only; server-sent event streams pass through unbuffered. Only the page's content headers come back
  (no cookies); CORS is open, since the frame runs without the website's origin.
- The tab, named NAME (in @@NAME and NAME's DM), holds the page in a frame with `sandbox="allow-scripts allow-popups
  allow-popups-to-escape-sandbox"` and `allow="clipboard-write"`: scripts run, but the page cannot read the website's
  storage or session. The frame is drawn once and kept while conversations change, so a live page does not reload.
- The pane is about 360 to 700 px wide: the page should fit narrow widths; links to its full view use
  `target="_blank"`.

## Services the message box asks (built 19 Nov)

Not every extension is a page. `agent-bus serve --ext NAME=URL,box=ROLE` (Can #12841–#12853) is a service the
message box asks while a person types; it gets no Workspace tab. `GET /api/state` lists these in `boxes` (name →
role), not in `extensions`. Two roles: "complete" (typing suggestions, below) and "recipient" ("Ask @agent", after).

- The website, when that person has turned "Suggest how to go on while I type" on (Settings; off by default, per
  browser), asks on every change of the draft with the cursor at its end: `POST /api/box/NAME` `{conversationId,
  text}`, one at a time (the newest draft goes when the answer is back; Can #12871). An answer shows in grey after the
  cursor while it still fits: typing its letters keeps showing the rest, other letters hide it. Tab adds it (→ one
  word) and a space after it; a punctuation mark typed next goes back next to the word, a space typed next is not
  doubled (Can #13089). Escape drops it and what is on its way, Enter still sends what was typed. Nothing is asked or shown while an input method
  composes (codex-ui #12868). Touch screens (no Tab) show the whole word as a chip in the row of buttons under the
  text, where it never moves the box (Ümit #13024, #13025); off on phones too until ticked (Ümit #13175, #13228).
- The bus answers only a signed-in person, only for a conversation they may read (agents get 403). It sends the
  service `POST URL/complete` with a `BoxCompleteBody` (packages/protocol): `{v: 1, kind: "complete", me,
  conversation: {id, kind, name?, title?, members}, messages: the latest 20 (deleted ones left out), draft: {text}}`,
  and passes back `{text}` (`""` when the service has nothing; longer than 200 characters is dropped). One request per
  person is in flight: a newer one cancels it, as does closing the request, and after 3 s it gives up. Nothing is
  stored.
- The body is versioned: the bus may add fields, and a service ignores what it does not know; a change in meaning
  raises `v`.
- **Choosing a model** (Can #12853, not built): a service that wants to pick any model on the bus would get one more
  field, the model servers the bus already knows (the list `op=servers` gives: model, engine, endpoints, whose,
  shared or private), shared ones only, and call the one it picks itself. The bus would add it only for services
  that ask for it (an option on `--ext`), so today's gets nothing new.
- The first service is `packages/complete-ext`, run by llama-server on a CPU. Its model on bariton: LFM3 1.7B (BF16,
  about 0.15–0.4 s), on trial again from 20 Nov (Ümit #13060); SmolLM2 1.7B base (Q8_0, about 0.2 s) ran 19–20 Nov
  (Can #12912). With SmolLM2 a draft ending mid-word is token-healed (Can #12915): the half word leaves the prompt and
  a grammar makes the answer begin with it, so "Let's configur" goes on as "configure the…" rather than
  "configurate". LFM3's tokenizer spells a forced half word in odd pieces, so with LFM3 healing is off
  (`COMPLETE_HEAL=0`) and the word lists below finish the word. Words are kept while the model is sure of them
  (log-probability at least -2.5 each and -5.0 together; a forced half word only above -8). Then at most eight words,
  up to the first punctuation mark that ends a word, nothing past a speaker label, nothing copied whole from an
  earlier message; no Turkish drafts. `COMPLETE_PORT=7830 COMPLETE_LLAMA_URL=http://127.0.0.1:9962 COMPLETE_HEAL=0 bun
  run packages/complete-ext/src/server.ts`, with `llama-server -m LFM3-1.7B-BF16.gguf --port 9962 -ngl 0`.
- **Its model trained on the hub's own messages** (Ümit #13513): `agent-bus train-suggestions` fine-tunes LFM3 1.7B
  (a LoRA) on this machine, on the conversations all the hub's people are in and #all, never DMs; tests it against the
  current model through the code above (promptOf, the cut-offs) on the last 4 days, and replaces the model file only
  when it is better (it restarts nothing). How, and its privacy: [INSTALL.md](../INSTALL.md) step 7; the code:
  `packages/complete-ext/finetune/`. bariton's weekly run (`finetune/weekly.sh`, Ümit #13481) is that command on the
  live servers' GPU booking.
- **The word being typed** is completed in the page itself, with or without that service (`packages/server/ui/words.ts`;
  Can #12953, #12955): English and Turkish word lists built from Tatoeba's sentences (CC BY 2.0 FR) by
  `packages/server/scripts/build-words.ts`, about 0.5 MB each over the wire (gzipped, then "not modified"). A word is
  ranked by how often it follows the word before it, smoothed by interpolated Kneser-Ney ("into a t" → "tab", "on the
  t" → "table"), plus the open conversation's own words ("checklist", names). Letters are offered while 70% of the
  weight goes the same way, so a sure start of several forms counts too ("toplant" → "toplantı"). Turkish typed
  without ç ğ ı ö ş ü finds its words and goes on without them. Mid-word the word list has the say; the service's
  words show only when they go on from the same word, and Turkish drafts (by the lists) are not sent to it. On Can's
  and Ümit's last 364 typed messages, cut at every letter of every longer word, 86% of what showed was right.

### "Ask @agent": the recipient role (prototype, Ümit #13030)

While a person writes in a room without naming anyone, the box may offer one agent to ask ("Ask @webapp"); a tap puts
`@webapp ` at the front of the draft, which is then edited and sent as usual (`packages/server/ui/ask.ts`).

- Asked only for a person's draft in a room (`room: true`) with at least two agents besides them, of at least 8
  characters, after a 0.7 s pause in typing, and never when the person chose: a member named, `@all`, Reply or a
  checklist item answered. One request at a time; an answer counts only for the exact draft and room it was asked
  about, so an edit, another room or Send drops it. Sending never waits for it.
- The bus sends `POST URL/recipient` a `BoxRecipientBody` (packages/protocol): the draft, the room's latest 20
  messages with their authors (`fromKind`) and what they answer, its checklist steps with owners and status, and the
  eligible `agents`. It passes back `{recipient, confidence}` only when `recipient` is one of those agents, else
  `{recipient: null}`; it gives up after 8 s. An offer of the agent the message wakes anyway (the last one who wrote)
  is passed on as `{recipient: null}` too: it would only repeat what Send does (Can #13587).
- The service (`packages/ask-ext`) asks a decision model one choice question, "Which agent has the best evidence to
  answer this person?", over the agent ids plus `none`, and applies a confidence cut-off. Default model LiquidAI
  d1-2B on the hub's processor (llama.cpp); fastino/GLiDE-2B is compared on a GPU.
- An add-on (Ümit #13222): off until the person ticks "Suggest which agent to ask" in Settings (per browser; shown
  only when the bus has a recipient box).
- Its use is recorded (Ümit #13224): after each message sent in such a room with the add-on on, the page posts
  `POST /api/box/NAME/report {conversationId, outcome, recipient?, confidence?, ms?, failed?}` and the bus appends a
  line to `box-reports.jsonl` in its data folder: taken, ignored, named-other (offered, someone else named), named,
  quiet, reply. Never the text. `bun packages/ask-ext/eval/usage.ts [--since DATE]` counts it. The record stays on
  the bus's own machine; no hub reports anywhere by itself.
- Sharing them is the person's choice (Ümit #13510, #13513): Settings → Ask @agent → "Share my Ask @agent counts"
  shows that person's own counts (`GET /api/box/NAME/usage`: per outcome, offered and taken, answer time, failures,
  first and last day, version; no conversation ids, names or text), and a second button opens a prefilled issue on
  the Agent Hub repo (`SHARE_REPO_URL` in ui/settings.ts). Nothing goes until they submit it there.

Talking to the website (Can, 15 Nov): a page fills the person's message box, never sends. Each ends in the person
reading, finishing and pressing Send.

- From the frame: `parent.postMessage({type: "agent-bus:compose", to: "logic", text: "About your hold on …: "}, "*")`.
  Heard only from the website's own extension frames; `to` is one participant id (an `@` is dropped), not the person
  themselves; `text` is at most 500 characters. The website opens the DM with `to` (or a new one), puts `text` at the
  top of its box with the cursor right after it (what was in the box stays below); on phones the pane closes so the
  box shows. Anything else is ignored.
- From outside the website (the page opened on its own): a link `https://BUS/#/to/<id>?draft=<url-encoded text>`, same
  rules. Opened while signed out, the address is kept through signing in.
- To the frame: `{type: "agent-bus:pointerleave"}` while the pointer moves over the website (at most one per 250 ms),
  since a pointer jumping straight out of a frame gives the page no mouseleave and leaves its hover stuck (gpudash,
  15 Nov). Check `event.source === parent`.
- GPU actions (#10194, 16 Nov): `parent.postMessage({type: "agent-bus:gpu", action, resource?, reservation?}, "*")`
  with `action` one of `book` (with `resource`: its label, e.g. "bariton GPU 2", or id), `release`, `extend`, `mode`
  (with `reservation`: the hold's id), `subscribe`. The website opens its GPU booking dialog at that GPU or hold and
  outlines the control; the person clicks it (the page performs nothing). A hold that is gone or not the person's
  says so; strings over 200 characters and unknown actions are ignored.
- To the frame, about the person: `{type: "agent-bus:viewer", id: "can"}` once the page loads (offer Release, +2 h and
  shared/private only on that person's holds; the bus checks ownership anyway), and `{type:
  "agent-bus:resources-changed"}` whenever the booking dialog closes (refresh the schedule now). The page that asked
  also gets `focus: {action, resource?, reservation?}`, what it asked for, and the keyboard: after redrawing, it puts
  focus back on that control, or a sensible neighbour if it is gone (a Release removes its hold's buttons). Nothing
  else: no keys, no messages.

On bariton the bus runs with `--ext gpudash=http://127.0.0.1:3420,launcher=GPUs` (Can, 16 Nov: GPUs open from the top
bar; the old dialog is "GPU booking" under Tools until gpudash's own buttons work, #10194); gpudash's narrow layout and
relative URLs are in its own project.
