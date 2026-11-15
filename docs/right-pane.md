# The right pane: extensions (design)

Status: Can's ideas of 14 Nov 2026. Built so far: the pane with its extension system, **File** and **Shared** (14 Nov),
**Checklist** and **Live** (15 Nov). Progress comes next (build order below).

## How an extension plugs in (built)

`packages/server/ui/pane.ts`: an extension registers `{ id, order, title(), applies(view), render(body, view),
shown?(visible) }`. The pane is opened for a view, its source, and keeps it (Can, 15 Nov): opening another conversation
on the left does not change the pane; only opening an extension for the open conversation does (▤, a file clicked in
a message). While source and main panel differ, the source's name heads the pane, and a click on it opens it. Tabs
show while `applies` is true for the source; `render` fills its own part of the pane when the source changes or the
extension calls `refreshPane(id)`, never on tab switches, so scroll positions stay; `shown` tells it when its tab
appears or goes (Live streams only then). Open or closed and the last tab are kept per browser; ▤ closes the pane when
it shows the open conversation and switches it to the open conversation otherwise; Esc closes it. On phones the pane
covers the conversation.

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

- The owner agent publishes the list as markdown: `PUT /api/conversations/:id/checklist` with `{from, text}`, members
  only (agent token, like every write). Lines `- [ ] item · #1234` are items (the `#1234` links to the message they
  came from); `## heading` lines group them; `- [x]` marks an item the owner itself counts as done. Up to 20,000
  characters; it replaces the previous text.
- People tick items on the website (Checklist tab of the right pane, first tab where a list exists):
  `POST …/checklist/tick` with `{from, item, done}`. Ticks are kept apart from the text, keyed by the item's text: a
  republished list keeps them, and an item the owner drops takes its tick along.
- The owner reads the ticks back with `GET …/checklist` (`{text, ticks: {item: {by, at}}, updatedAt, updatedBy}`), e.g.
  on its hourly run, and drops done items when it publishes next. No message per tick: that would start a paid turn
  each time.
- Everyone viewing the conversation sees changes live; who may read the conversation may read its list.

Further types (Board: a markdown page the agent keeps up to date, …) as needs come.

## Open questions

1. Who sees an agent's Progress and panels: anyone who can see the agent, or only the members of the conversation
   a task belongs to?
2. Who else may tick a checklist item (Ümit; other agents)?

## Build order

1. Shared files (small, no new storage).
2. Progress: storage, `op=progress`, the tab with notes, estimate and charts.
3. Checklist for Ali.
4. Live moved into the pane (done 15 Nov).
