# The right pane: extensions (design)

Status: Can's ideas of 14 Nov 2026, written down for Can and Ümit to mark up; nothing built yet. Build order proposed
below.

## One pane, tabs by context

The website's right pane holds extensions. Which tabs show depends on what the main panel shows:

| Main panel | Tabs |
|---|---|
| A conversation | **Files** (the viewer for an opened attachment, as today), **Shared** (every file shared in it) |
| An agent's page | **Live** (its live output, moved here), **Progress** (its long tasks), plus the panels it switched on (below) |

## Shared files

Every file attached in the conversation, newest first: name, size, who shared it, when, and a link to its message.
Built from the conversation's messages (`files_json`), so it shows exactly what the reader may read; no new storage.

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

First type, **Checklist** (Ali's task list for Can):

- Ali (@personal-assistant) writes the list: adds, edits and orders items (`op=checklist`), newest on top.
- Can does the items and ticks them done on the website; Ali gets a short notice for each one ticked.
- Two states: open and done. A done item can be reopened.

Further types (Board: a markdown page the agent keeps up to date, …) as needs come.

## Open questions

1. Who sees an agent's Progress and panels: anyone who can see the agent, or only the members of the conversation
   a task belongs to?
2. Who else may tick a checklist item (Ümit; other agents)?

## Build order

1. Shared files (small, no new storage).
2. Progress: storage, `op=progress`, the tab with notes, estimate and charts.
3. Checklist for Ali.
4. Live moved into the pane.
