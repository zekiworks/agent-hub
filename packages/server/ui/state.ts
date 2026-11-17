// The page's shared mutable state (one object, read and written by every module) and the queries over it.
import { ALL_CONVERSATION_ID, type Bookmark, type Conversation, type Message, type Participant } from "@agent-bus/protocol";
import { nameList, sortedUnique } from "./format";

export const UNREAD_ONLY_KEY = "agent-bus.unreadOnly";
/** Show offline agents and the conversations with them (off by default, to keep the list to who is working now). */
export const INCLUDE_OFFLINE_KEY = "agent-bus.includeOffline";

/** Messages per page fetched from a conversation. */
export const PAGE_SIZE = 100;

/**
 * What the main pane shows: an existing conversation, or a not-yet-created DM or group DM with `to` (ids besides me),
 * or a not-yet-created project `project` (`to` is then []).
 */
export type View = { kind: "conversation"; id: string } | { kind: "draft"; to: string[]; project?: string };

interface MessageCache {
  messages: Message[];
  /** More messages exist before the first loaded one. */
  hasEarlier: boolean;
}

export interface MentionCandidate {
  id: string;
  label: string;
  hint: string;
}

/** A checklist item a message answers (↩ on the item; Ümit #11598). */
export interface ItemReply {
  conversationId: string;
  item: string;
}

export const state = {
  me: "",
  humans: [] as string[],
  participants: [] as Participant[],
  conversations: new Map<string, Conversation>(),
  /** My own bookmarks (Can #11065), newest first: the bus keeps them, only I see them. */
  bookmarks: [] as Bookmark[],
  /** My tabs (Can #11480): conversations I pinned, in my order; the bus keeps them, only I see them. */
  tabs: [] as string[],
  caches: new Map<string, MessageCache>(),
  /** Conversations whose first page is being fetched → live messages received meanwhile. */
  loading: new Map<string, Message[]>(),
  unread: new Map<string, number>(),
  /** Unread messages for me: mentioning me, or in a one-to-one/group conversation I am a member of. */
  attention: new Map<string, number>(),
  /** The most important of those: they mention me, or their conversation is just me and one other. */
  urgent: new Map<string, number>(),
  /** Agents whose conversations the sidebar is limited to (all of them must be members). */
  filter: new Set<string>(),
  /** Show only conversations with unread messages (the open one stays). Remembered in this browser. */
  unreadOnly: localStorage.getItem(UNREAD_ONLY_KEY) === "1",
  includeOffline: localStorage.getItem(INCLUDE_OFFLINE_KEY) === "1",
  /** "Other projects" is open. */
  browsing: false,
  /** "Other groups" is open. */
  /** Which Groups fold is open, if any. */
  otherGroupsOpen: "" as "" | "agentGroups" | "agentDms" | "archived",
  readAt: {} as Record<string, number>,
  view: { kind: "conversation", id: ALL_CONVERSATION_ID } as View,
  staged: [] as File[],
  /** Message the next send replies to (quotes), in the open conversation. */
  replyTo: undefined as Message | undefined,
  /**
   * A checklist item the next send answers (↩ on the item): shown above the box and put in front of the message as a
   * quote when it is sent, never written into the box (Ümit #11598, codex-ui #11599).
   */
  itemReply: undefined as ItemReply | undefined,
  /**
   * The message I am "in" (Ümit #11622): the one I clicked, or the one a banner, #number, bookmark or search took me to.
   * Lit until I click another one, press Esc, or leave the conversation.
   */
  selectedSeq: undefined as number | undefined,
  sending: false,
  /** A voice recording started with a click is running: Send sends it (voice.ts). */
  voiceLatched: false,
  mention: { open: false, start: 0, items: [] as MentionCandidate[], index: 0 },
};

export function agents(): Participant[] {
  return state.participants
    .filter((p) => p.kind === "agent")
    .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
}

/**
 * The DM (two ids) or group DM (more) whose members are exactly `ids`, as the server picks it for "@x" / "@{a,b}":
 * an unarchived one first, then the most recent.
 */
export function findByMembers(ids: readonly string[]): Conversation | undefined {
  const wanted = sortedUnique(ids);
  const kind = wanted.length === 2 ? "dm" : "group";
  return Array.from(state.conversations.values())
    .filter((c) => c.kind === kind && c.members.length === wanted.length && wanted.every((id) => c.members.includes(id)))
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.lastMessageAt - a.lastMessageAt)[0];
}

/** The conversation a draft would write to, once it exists. */
export function draftConversation(view: Extract<View, { kind: "draft" }>): Conversation | undefined {
  return view.project !== undefined ? projectNamed(view.project) : findByMembers([state.me, ...view.to]);
}

/** My DM with `id`, if there is one. */
export function dmWith(id: string): Conversation | undefined {
  return findByMembers([state.me, id]);
}

export function projectNamed(name: string): Conversation | undefined {
  return Array.from(state.conversations.values()).find((c) => c.kind === "project" && c.name === name);
}

/** No person is in it: agents' DMs and groups (people may read them; the sidebar shows them behind a switch). */
export function isAgentOnly(conv: Conversation): boolean {
  return conv.kind !== "all" && !conv.members.some((id) => state.humans.includes(id));
}

/** A DM with an agent: the Agents section stands for it, so the conversation list leaves it out. */
export function isDmWithAgent(conv: Conversation): boolean {
  return conv.kind === "dm" && conv.members.includes(state.me) && conv.members.some((id) => id !== state.me && !state.humans.includes(id));
}

const byLast = (a: Conversation, b: Conversation) => b.lastMessageAt - a.lastMessageAt;

/** The sidebar's Projects list: `all`, then the projects I am in, by last message; archived ones left out. */
/** I pinned `conv`: it sorts first in my sidebar. */
export function pinnedByMe(conv: Conversation): boolean {
  return !!conv.pinnedBy?.includes(state.me);
}

/**
 * The Projects list: the projects I pinned, mine or not (Can, 15 Nov: first, no section of their own), then `all`,
 * then my other projects.
 */
export function sortedConversations(): Conversation[] {
  const projects = Array.from(state.conversations.values())
    .filter((c) => c.kind === "project" && !c.room && !c.archived)
    .sort(byLast);
  return [...projects.filter(pinnedByMe), ...projects.filter((c) => !pinnedByMe(c) && c.members.includes(state.me))];
}

/** The Rooms section (Can, 15 Nov: under Agents; #all is one): pinned rooms, then #all, then my other rooms. */
export function sortedRooms(): Conversation[] {
  const all = state.conversations.get(ALL_CONVERSATION_ID);
  const rooms = Array.from(state.conversations.values())
    .filter((c) => c.kind === "project" && c.room && !c.archived)
    .sort(byLast);
  return [...rooms.filter(pinnedByMe), ...(all ? [all] : []), ...rooms.filter((c) => !pinnedByMe(c) && c.members.includes(state.me))];
}

/** The sidebar's Groups list: the group DMs I am in, and DMs with people (DMs with agents are their Agents rows). */
export function sortedGroups(): Conversation[] {
  return Array.from(state.conversations.values())
    .filter((c) => (c.kind === "group" || c.kind === "dm") && !c.archived && c.members.includes(state.me) && !isDmWithAgent(c))
    .sort(byLast);
}

/**
 * "Other groups": the group DMs and DMs I can read and am not in, i.e. the agents' own (no person in them; people
 * may read them for oversight, docs/projects.md), and my archived ones; the latter last.
 */
/**
 * The Groups section's folds (Can, 16 Nov: one "Other groups" mixed three kinds and read as growth): live agents-only
 * group DMs, DMs between two agents, and archived group DMs and DMs (mine, and agents-only ones).
 */
export function otherGroups(): { agentGroups: Conversation[]; agentDms: Conversation[]; archived: Conversation[] } {
  const all = Array.from(state.conversations.values()).filter((c) => (c.kind === "group" || c.kind === "dm") && !c.preview);
  const theirs = (c: Conversation) => !c.members.includes(state.me) && isAgentOnly(c);
  return {
    agentGroups: all.filter((c) => c.kind === "group" && !c.archived && theirs(c)).sort(byLast),
    agentDms: all.filter((c) => c.kind === "dm" && !c.archived && theirs(c)).sort(byLast),
    archived: all.filter((c) => c.archived && (c.members.includes(state.me) || theirs(c))).sort(byLast),
  };
}

/** "Other projects": the projects I can see and am not in (open or discoverable), archived ones last. */
export function browsableProjects(rooms = false): Conversation[] {
  return Array.from(state.conversations.values())
    .filter((c) => c.kind === "project" && !!c.room === rooms && !c.members.includes(state.me) && !pinnedByMe(c))
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.lastMessageAt - a.lastMessageAt);
}

/**
 * An agent of this conversation is offline (or no longer on the bus). The bus's own participants (@resources, harness
 * "bus") never connect, so they never count: their notices must always show.
 */
function hasOfflineAgent(conv: Conversation): boolean {
  if (conv.kind === "all") return false;
  return conv.members.some((id) => {
    if (state.humans.includes(id)) return false;
    const participant = state.participants.find((p) => p.id === id);
    return participant?.harness !== "bus" && !participant?.online;
  });
}

/**
 * Agent filter: `@all` always passes, a group when every filtered agent is a member. Unread filter: unread or open.
 * Without "Include offline", conversations with an offline agent are hidden (the open one stays), but not rooms: a
 * room is a shared place of people and agents, and one agent going offline must not take it out of the list
 * (Ümit #11394).
 */
export function passesFilter(conv: Conversation): boolean {
  if (state.unreadOnly && (state.unread.get(conv.id) ?? 0) === 0 && !isCurrent(conv.id)) return false;
  if (!state.includeOffline && !isCurrent(conv.id) && !(conv.kind === "project" && conv.room) && hasOfflineAgent(conv)) return false;
  if (conv.kind === "all" || state.filter.size === 0) return true;
  return [...state.filter].every((id) => conv.members.includes(id));
}

export function isCurrent(conversationId: string): boolean {
  return state.view.kind === "conversation" && state.view.id === conversationId;
}

/** Agent whose direct conversation (or draft) is open. */
export function currentDirectAgent(): string | undefined {
  return directAgentOf(state.view);
}

/** The one agent of `view` (an agent's DM, a draft to it, or a group DM with a single agent), if any. */
export function directAgentOf(view: View): string | undefined {
  if (view.kind === "draft") return view.to.length === 1 ? view.to[0] : undefined;
  const conv = state.conversations.get(view.id);
  if (!conv || conv.kind === "all" || conv.kind === "project") return undefined;
  const agentIds = new Set(agents().map((a) => a.id));
  const convAgents = conv.members.filter((id) => agentIds.has(id));
  return convAgents.length === 1 ? convAgents[0] : undefined;
}

/**
 * A project's own colour. Projects in the order they were made each step a golden angle (137.5°) round the colour
 * wheel, so every one gets a different hue, as far as possible from the ones before it, and keeps it: new projects
 * only add to the end. (A hash of the name gave 12 hues for 17 projects.) Lightness alternates a little to separate
 * neighbours further; both levels read on the dark theme. Nothing is stored.
 */
export function projectColor(conv: Conversation): string {
  const root = rootProject(conv) ?? conv;
  // Only root projects take a hue of their own; sub-projects and groups under a project wear their root's.
  const roots = Array.from(state.conversations.values())
    .filter((c) => c.kind === "project" && !c.parentId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rank = Math.max(0, roots.findIndex((c) => c.id === root.id));
  const hue = Math.round((rank * 137.508) % 360);
  return `hsl(${hue} 70% ${rank % 2 === 0 ? 62 : 70}%)`;
}

/** The root project of `conv`: its parent (one level only), itself when it is a root project, else undefined. */
export function rootProject(conv: Conversation): Conversation | undefined {
  const parent = conv.parentId ? state.conversations.get(conv.parentId) : undefined;
  return parent ?? (conv.kind === "project" ? conv : undefined);
}

/** Projects and anything under a project wear a project colour. */
export function hasProjectColor(conv: Conversation): boolean {
  return conv.kind === "project" || !!conv.parentId;
}

/** "#all", a project's or room's name (its title, else "@@name"/"#name"), or the members: everyone but me (all of them
 * if I am not a member). */
export function conversationTitle(conv: Conversation): string {
  if (conv.kind === "all") return "#all"; // a room, everyone's (Can, 15 Nov)
  if (conv.kind === "project" && conv.title) return conv.title; // the name people gave it (#10623)
  if (conv.kind === "project" && conv.name) return conversationAddress(conv) ?? conv.name;
  const others = conv.members.filter((id) => id !== state.me);
  return nameList(others.length > 0 ? others : conv.members);
}

/** A project's or room's address ("@@name", "#name"); undefined for everything else. */
export function conversationAddress(conv: Conversation): string | undefined {
  if (conv.kind !== "project" || !conv.name) return undefined;
  return conv.room ? `#${conv.name}` : `@@${conv.name}`;
}

export function mergeMessages(a: readonly Message[], b: readonly Message[]): Message[] {
  const bySeq = new Map<number, Message>();
  for (const m of a) bySeq.set(m.seq, m);
  for (const m of b) bySeq.set(m.seq, m);
  return Array.from(bySeq.values()).sort((x, y) => x.seq - y.seq);
}
