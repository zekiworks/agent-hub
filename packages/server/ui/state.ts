// The page's shared mutable state (one object, read and written by every module) and the queries over it.
import { ALL_CONVERSATION_ID, type Conversation, type Message, type Participant } from "@agent-bus/protocol";
import { nameList, sortedUnique } from "./format";

export const UNREAD_ONLY_KEY = "agent-bus.unreadOnly";
/** Show offline agents and the conversations with them (off by default, to keep the list to who is working now). */
export const INCLUDE_OFFLINE_KEY = "agent-bus.includeOffline";
/** Show agent-only conversations (agents' DMs and groups) in the sidebar; hidden by default (docs/projects.md). */
export const AGENT_DMS_KEY = "agent-bus.agentDms";

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

export const state = {
  me: "",
  humans: [] as string[],
  participants: [] as Participant[],
  conversations: new Map<string, Conversation>(),
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
  agentDms: localStorage.getItem(AGENT_DMS_KEY) === "1",
  /** "Browse projects" is open. */
  browsing: false,
  readAt: {} as Record<string, number>,
  view: { kind: "conversation", id: ALL_CONVERSATION_ID } as View,
  staged: [] as File[],
  /** Message the next send replies to (quotes), in the open conversation. */
  replyTo: undefined as Message | undefined,
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

/**
 * The sidebar's Projects list: `all`, then the projects and group DMs I am in (and DMs with people), by last message;
 * agent-only conversations too while "Agent DMs" is on. Archived ones and DMs with agents are left out.
 */
export function sortedConversations(): Conversation[] {
  const all = state.conversations.get(ALL_CONVERSATION_ID);
  const listed = Array.from(state.conversations.values())
    .filter((c) => c.kind !== "all" && !c.archived && !c.preview && !isDmWithAgent(c))
    .filter((c) => c.members.includes(state.me) || (state.agentDms && isAgentOnly(c)))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return all ? [all, ...listed] : listed;
}

/** Projects I am not in that I can see (open, or discoverable), for "Browse projects". */
export function browsableProjects(): Conversation[] {
  return Array.from(state.conversations.values())
    .filter((c) => c.kind === "project" && !c.archived && !c.members.includes(state.me))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
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
 * Without "Include offline", conversations with an offline agent are hidden (the open one stays).
 */
export function passesFilter(conv: Conversation): boolean {
  if (state.unreadOnly && (state.unread.get(conv.id) ?? 0) === 0 && !isCurrent(conv.id)) return false;
  if (!state.includeOffline && !isCurrent(conv.id) && hasOfflineAgent(conv)) return false;
  if (conv.kind === "all" || state.filter.size === 0) return true;
  return [...state.filter].every((id) => conv.members.includes(id));
}

export function isCurrent(conversationId: string): boolean {
  return state.view.kind === "conversation" && state.view.id === conversationId;
}

/** Agent whose direct conversation (or draft) is open. */
export function currentDirectAgent(): string | undefined {
  if (state.view.kind === "draft") return state.view.to.length === 1 ? state.view.to[0] : undefined;
  const conv = state.conversations.get(state.view.id);
  if (!conv || conv.kind === "all" || conv.kind === "project") return undefined;
  const agentIds = new Set(agents().map((a) => a.id));
  const convAgents = conv.members.filter((id) => agentIds.has(id));
  return convAgents.length === 1 ? convAgents[0] : undefined;
}

/** "all", a project's "@@name", or the members: everyone but me (all of them if I am not a member). */
export function conversationTitle(conv: Conversation): string {
  if (conv.kind === "all") return "all";
  if (conv.kind === "project" && conv.name) return `@@${conv.name}`;
  const others = conv.members.filter((id) => id !== state.me);
  return nameList(others.length > 0 ? others : conv.members);
}

export function mergeMessages(a: readonly Message[], b: readonly Message[]): Message[] {
  const bySeq = new Map<number, Message>();
  for (const m of a) bySeq.set(m.seq, m);
  for (const m of b) bySeq.set(m.seq, m);
  return Array.from(bySeq.values()).sort((x, y) => x.seq - y.seq);
}
