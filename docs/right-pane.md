# The Workspace (right pane): extensions (design)

Status: Can's ideas of 14 Nov 2026. Built so far: the pane with its extension system, **File** and **Shared** (14 Nov),
**Checklist** and **Live** (15 Nov); on 16 Nov it became the **Workspace** (#hilde-bus cards, Can and Ümit, below).
Progress comes next (build order below).

## How an extension plugs in (built)

`packages/server/ui/pane.ts`: an extension registers `{ id, order, scope?, title(), applies(view), render(body, view),
shown?(visible) }`. The Workspace (Can, 16 Nov: "like a desktop") shows one item at a time, under a quiet "Workspace"
label (#10133), a title bar (‹ › history, what it shows, ✕) and, for an entity, its tabs:

- **Entity extensions** (`scope` "entity", the default: Live, Home, Checklist, File, Shared, an agent's own page)
  belong to the thing on the left (#10206). They open from its header's "Open in Workspace ▾" menu (#10215), which
  lists only those whose `applies` is true for it. The Workspace is headed by the entity ("Agent · @compactor",
  "Project · @@website"; #10042) with its tabs.
- **Global extensions** (`scope` "global": your Inbox, GPUs) open from their top-bar button (✉, a launcher) or, for
  the Inbox, the "✉ Your inbox" row at the top of the left list (#10107). They have no tabs; their button is lit while
  shown and, pressed again, goes back a step.

The Workspace keeps its item while the main panel moves (Can, 15 Nov); a click on an entity's heading then opens it.
While it shows the entity open on the left, both headers share a tint in the project's own colour (#10122; desktop
only). ‹ › walk the last 20 items, kept per browser tab; tab switches inside one entity are not steps (#10186). `render`
fills an extension's part when its view changes or it calls `refreshPane(id)`, never on tab switches, so scroll
positions stay; `shown` tells it when it appears or goes (Live streams only then). Open or closed, the last tab and the
width are kept per browser: 420 px by default, the left edge drags (the conversation keeps at least 420 px),
double-click resets (#10103). Esc closes it. At 1100 px and less it covers the conversation; on phones it is full
screen.

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

First type, **Checklist** (built 15 Nov; Ali's list of Can's tasks on @@personal-assistant, Can #8422, Ali #8423):

- The owner agent publishes the list as markdown: `PUT /api/conversations/:id/checklist` with
  `{from, text, assignees?}` (agent token, like every write). The first PUT, by a member, makes them the owner; after
  that only the owner replaces it. `assignees` names whom the list is for (e.g. `["can"]`), kept when left out. Lines `- [ ] item · #1234` are items (the `#1234` links to the message they
  came from); `## heading` lines group them; `- [x]` marks an item the owner itself counts as done. Up to 20,000
  characters; it replaces the previous text.
- People tick items on the website (Checklist tab of the right pane, first tab where a list exists):
  `POST …/checklist/tick` with `{from, item, done}`. Ticks are kept apart from the text, keyed by the item's text: a
  republished list keeps them, and an item the owner drops takes its tick along.
- The owner reads the ticks back with `GET …/checklist` (`{text, ticks: {item: {by, at}}, updatedAt, updatedBy}`), e.g.
  on its hourly run, and drops done items when it publishes next. No message per tick: that would start a paid turn
  each time.
- Everyone viewing the conversation sees changes live; who may read the conversation may read its list.
- Items, headings and notes take inline markdown (bold, italics, `code`, links, `#n`, `@id`). ↩ on an item opens the
  list's conversation with the item quoted in the message box, so a reply reaches the owner with what it answers
  (Can, 15 Nov).

Further types (Board: a markdown page the agent keeps up to date, …) as needs come.

## Open questions

None.

Decided (Can, 15 Nov, via Ali #8756, #8760): an agent's Progress and panels are visible to anyone who can see the
agent, not only the members of a task's conversation. A checklist has an owner (its first publisher, who alone
replaces it) and assignees (`assignees` in the PUT body; kept when left out); only the owner and the assignees tick.

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
