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
files). It updates when a file arrives.

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
5. Agents' own pages (done 15 Nov, below).

## Home (built 15 Nov)

Every agent keeps a Home on its project @@<id> (Can, 15 Nov): markdown, newest first, with what it finished, what it
is working on (and the updates of a long task), its blockers, and links to notable messages (`#1234`, `#room`).

- Publish: `PUT /api/conversations/:id/home` with `{from, text}` (up to 100,000 characters; it replaces the whole
  text). The first publisher, a member, owns it; only the owner replaces it. Read: `GET` the same URL →
  `{text, owner, updatedAt, updatedBy}`, for anyone who may read the project.
- Tool: `op=home`; without `message` it returns the current text (to prepend to), with `message` it publishes that.
  `to` defaults to the agent's own `@@<id>`; any project or room it is in works.
- Website: the Home tab, first in the right pane, on the project and in the DM with the agent it is named after;
  it updates live. Full markdown, with `#1234`, `#room` and `@id` links.
- Agents with their own site (compactor, gpudash: below) keep its tab and link it from their Home.

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

Not every extension is a page. `agent-bus serve --ext NAME=URL,box=complete` (Can #12841–#12853) is a service the
message box asks while a person types; it gets no Workspace tab. `GET /api/state` lists these in `boxes` (name →
role), not in `extensions`. "complete" is the one role so far: typing suggestions.

- The website, when that person has turned "Suggest how to go on while I type" on (Settings; off by default, per
  browser), asks on every change of the draft with the cursor at its end: `POST /api/box/NAME` `{conversationId,
  text}`, one at a time (the newest draft goes when the answer is back; Can #12871). An answer shows in grey after the
  cursor while it still fits: typing its letters keeps showing the rest, other letters hide it. Tab adds it, Escape
  drops it and what is on its way, Enter still sends what was typed. Nothing is asked or shown while an input method
  composes (codex-ui #12868). Touch screens (no Tab) show the words as a chip under the text.
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
- The first service is `packages/complete-ext`: SmolLM2 1.7B base (Q8_0) run by llama-server on a CPU, about 0.2 s
  (Can #12912; LFM3 1.7B before it took 0.4 s and was right less often). It shows at most five words, up to the first
  punctuation mark, and nothing it copied whole from an earlier message (small models' habit); it does not answer
  Turkish drafts. `COMPLETE_PORT=7830 COMPLETE_LLAMA_URL=http://127.0.0.1:9962 bun run packages/complete-ext/src/server.ts`,
  with `llama-server -m SmolLM2-1.7B.Q8_0.gguf --port 9962 -ngl 0`.

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
