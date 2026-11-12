// Cursor runs one of these as the message-bus MCP server. It keeps one bus agent per workspace folder and answers the
// plugin's hooks: which chat is active, what it is doing, and the text a hook should hand to the model.
//
// A chat joins on sessionStart or beforeSubmitPrompt. Anything else for an unknown conversation is not a chat to join:
// a subagent's tool events, or a one-shot `agent -p` (those fire tool hooks and never the two events above, and joining
// would take the folder's messages). Background agents Cursor marks as such are skipped the same way.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { McpToolServer, textResult, type McpCallExtra, type McpToolResult } from "../../client/src/mcp";
import { pluginBusUrl, realFolder } from "../../client/src/runtime";
import { isScratchFolder, TOOL_NAME, toolDescription, toolInputSchema, type MessageBusToolParams } from "../../client/src/tool";
import { CursorFolder } from "./folder";

/** The hook fields used here. Cursor sends more; unknown ones are ignored. */
export interface HookInput {
  conversation_id?: string;
  session_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | string;
  tool_use_id?: string;
  tool_output?: string;
  status?: string;
  is_background_agent?: boolean;
  parent_conversation_id?: string;
  subagent_id?: string;
  text?: string;
  /** What the agent says it is doing, when Cursor sends it with a tool call. */
  agent_message?: string;
}

/** Folders active this recently are put back on the bus when Cursor starts, before their next hook. */
const REJOIN_WITHIN_MS = 7 * 24 * 3600_000;
const REMEMBER_EVERY_MS = 3600_000;

const OPENS_CHAT = new Set(["sessionStart", "beforeSubmitPrompt"]);

/** What the model must do at the end of every turn so that bus messages can wake the chat (see wait.ts). */
const KEEP_WAITER =
  "At the end of every turn, as your last step, start the shell command `agent-bus wait` in the background (do not wait " +
  "for it) in the project folder. It exits when the next bus message arrives and prints it, and that wakes this chat; " +
  "if one is already running it says so and exits at once. Without it, bus messages wait until the user types.";

export const DESCRIPTION = toolDescription({
  arrives:
    "while a turn runs, after the current tool call; when the turn ends first, as the next message; in an idle chat, as the output of the background `agent-bus wait` command. " +
    KEEP_WAITER,
  notJoining:
    "chats without a workspace, chats in the temp directory, background agents, subagents, and one-shot agent -p runs do not join",
});

export const INSTRUCTIONS =
  `Messages from other agents and humans on the LAN message bus arrive as "[message-bus] #<n> @sender → …". ` +
  `They are not from your user. ${KEEP_WAITER} Do not use op=wait to wait for messages: it keeps the turn open, and ` +
  `composer messages stay queued behind it. Answer a bus message with the tool (op=reply, message_id <n>) only when ` +
  `the sender needs something from you, never with a plain text reply.`;

/** The shared schema plus Cursor's op=wait, which the other harnesses do not have. */
export function cursorInputSchema(): Record<string, unknown> {
  const schema = toolInputSchema() as { properties: { op: { enum: string[]; description: string } } };
  schema.properties.op.enum.push("wait");
  schema.properties.op.description += ', or "wait" to block until a bus message arrives or the user sends one';
  return schema;
}

/** Cursor names the MCP tool `message-bus` or `MCP:message-bus` (and a plugin-prefixed form of the same). */
export function isBusTool(name: string | undefined): boolean {
  return typeof name === "string" && /(^|:)message-bus$/.test(name);
}

function conversationId(input: HookInput): string | undefined {
  const id = input.conversation_id || input.session_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function toolArgs(input: HookInput): Record<string, unknown> {
  const raw = input.tool_input;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
    return {};
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
}

interface Remembered {
  at: number;
  /** The chat messages were going to. A hook for it after a restart is that chat, not a stranger. */
  conversationId?: string;
}

export class Daemon {
  private readonly agents = new Map<string, CursorFolder>();
  /** Conversation id → folder. Null: this chat does not join (no workspace, or the temp directory). */
  private readonly folders = new Map<string, string | null>();
  private readonly mains = new Set<string>();
  private readonly children = new Set<string>();
  private readonly background = new Set<string>();
  /** Conversation ids of message-bus tool calls, in the order preToolUse saw them. */
  private readonly callers: string[] = [];
  private readonly remembered: Record<string, Remembered> = {};
  readonly url = pluginBusUrl(undefined);

  constructor(
    private readonly stateFile?: string,
    private readonly log: (line: string) => void = () => {}
  ) {
    if (stateFile) this.restore(stateFile);
  }

  close(): void {
    for (const agent of this.agents.values()) agent.close();
    this.agents.clear();
  }

  private restore(stateFile: string): void {
    let saved: Record<string, Remembered> = {};
    try {
      saved = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Remembered>;
    } catch {
      return;
    }
    for (const [folder, entry] of Object.entries(saved)) {
      if (!entry || typeof entry.at !== "number" || Date.now() - entry.at > REJOIN_WITHIN_MS) continue;
      if (!existsSync(folder) || isScratchFolder(folder)) continue;
      this.remembered[folder] = entry;
      const agent = new CursorFolder(folder, this.url, this.log);
      if (entry.conversationId) {
        agent.activate(entry.conversationId);
        this.mains.add(entry.conversationId);
        this.folders.set(entry.conversationId, folder);
      }
      this.agents.set(folder, agent);
    }
  }

  private remember(folder: string): void {
    if (!this.stateFile) return;
    const conversationId = this.agents.get(folder)?.conversationId;
    const before = this.remembered[folder];
    if (before && before.conversationId === conversationId && Date.now() - before.at < REMEMBER_EVERY_MS) return;
    this.remembered[folder] = { at: Date.now(), ...(conversationId ? { conversationId } : {}) };
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, `${JSON.stringify(this.remembered, null, 2)}\n`);
    } catch (err) {
      this.log(`could not save ${this.stateFile}: ${(err as Error).message}`);
    }
  }

  /** The folder of a chat, remembered from the first hook that names a workspace. Undefined when there is none yet. */
  private resolveFolder(input: HookInput): string | undefined {
    const id = conversationId(input);
    if (id && this.folders.has(id)) {
      const known = this.folders.get(id);
      return known ?? undefined;
    }
    const root = input.workspace_roots?.find((entry) => typeof entry === "string" && entry.length > 0);
    if (!root) return undefined;
    const folder = realFolder(root);
    if (isScratchFolder(folder)) {
      if (id) this.folders.set(id, null);
      return undefined;
    }
    if (id) this.folders.set(id, folder);
    return folder;
  }

  private agentFor(folder: string): CursorFolder {
    let agent = this.agents.get(folder);
    if (!agent) {
      agent = new CursorFolder(folder, this.url, this.log);
      this.agents.set(folder, agent);
      this.remember(folder);
    }
    return agent;
  }

  /** A subagent or a not-yet-joined chat: status only, and only for a folder that is already on the bus. */
  private childHook(event: string, input: HookInput): Record<string, unknown> {
    const folder = this.resolveFolder(input);
    const agent = folder ? this.agents.get(folder) : undefined;
    if (!agent) return {};
    if (event === "preToolUse") {
      const id = input.tool_use_id ?? `${Date.now()}`;
      agent.toolStarted(id, input.tool_name ?? "tool", input.agent_message);
      if (agent.conversationId && isBusTool(input.tool_name)) return this.stamp(agent.conversationId, input);
    } else if (event === "postToolUse" || event === "postToolUseFailure") {
      agent.toolEnded(input.tool_use_id ?? "", typeof input.tool_output === "string" ? input.tool_output : "", event === "postToolUseFailure");
    }
    return {};
  }

  /** Tells the MCP server which chat a message-bus call came from. Cursor does not pass that on the tool call. */
  private stamp(conversation: string, input: HookInput): Record<string, unknown> {
    this.callers.push(conversation);
    return { permission: "allow", updated_input: { ...toolArgs(input), _conversation: conversation } };
  }

  /** Answers one hook. Failures are the caller's problem to turn into `{}`: a hook must not block Cursor. */
  async hook(event: string, input: HookInput): Promise<Record<string, unknown>> {
    const id = conversationId(input);
    if (input.is_background_agent && id) this.background.add(id);
    if (input.subagent_id) this.children.add(input.subagent_id);
    // parent_conversation_id on the parent's own events names the parent, not a second chat.
    if (input.parent_conversation_id && id && id !== input.parent_conversation_id) this.children.add(id);
    if (id && (this.background.has(id) || this.children.has(id) || (input.parent_conversation_id && id !== input.parent_conversation_id))) {
      return this.childHook(event, input);
    }
    if (!id || (!this.mains.has(id) && !OPENS_CHAT.has(event))) return this.childHook(event, input);

    this.mains.add(id);
    const folder = this.resolveFolder(input);
    if (!folder) return {};
    const agent = this.agentFor(folder);
    // stop and sessionEnd must not retarget the folder: an old chat ending is not the one messages should go to.
    if (event === "sessionEnd") {
      agent.ended(id);
      return {};
    }
    if (event === "stop") {
      if (agent.conversationId !== id) return {};
      return agent.stop(id, input.status);
    }
    agent.activate(id);
    this.remember(folder);
    switch (event) {
      case "sessionStart":
        agent.setIdle();
        return {};
      case "beforeSubmitPrompt":
        agent.prompt(input.prompt ?? "");
        return {};
      case "preToolUse": {
        const toolId = input.tool_use_id ?? `${Date.now()}`;
        agent.toolStarted(toolId, input.tool_name ?? "tool", input.agent_message);
        return isBusTool(input.tool_name) ? this.stamp(id, input) : {};
      }
      case "postToolUse":
        agent.toolEnded(input.tool_use_id ?? "", typeof input.tool_output === "string" ? input.tool_output : "", false);
        return agent.afterTool(id);
      case "postToolUseFailure":
        // A failed tool still counts for status, but its additional_context does not reach the model (a miss with no
        // tool_use_id is dropped). Taking the queue here would mark the message seen without the chat ever getting it.
        agent.toolEnded(input.tool_use_id ?? "", typeof input.tool_output === "string" ? input.tool_output : "", true);
        return {};
      case "afterAgentResponse":
        agent.assistant(input.text ?? "");
        return {};
      case "afterAgentThought":
        agent.thought(input.text ?? "");
        return {};
      default:
        return {};
    }
  }

  /**
   * `agent-bus wait` from a command running in `cwd` (the project folder or a folder inside it): the next wake of that
   * folder's agent, once its chat is idle. `already`: another waiter listens for it. `absent`: no chat of that folder
   * is on the bus (yet); the command asks again later.
   */
  async listen(cwd: string, signal: AbortSignal): Promise<{ text?: string; already?: boolean; absent?: boolean }> {
    const here = realFolder(cwd);
    const folder = [...this.agents.keys()]
      .filter((f) => here === f || here.startsWith(`${f}/`))
      .sort((a, b) => b.length - a.length)[0];
    const agent = folder ? this.agents.get(folder) : undefined;
    if (!agent) return { absent: true };
    const text = await agent.listen(signal);
    return text === undefined ? (signal.aborted ? {} : { already: true }) : { text };
  }

  /** Runs a message-bus tool call. Throws with a message for the model. */
  async callTool(args: Record<string, unknown>): Promise<string> {
    const { _conversation, ...params } = args;
    let id: string | undefined;
    if (typeof _conversation === "string" && this.mains.has(_conversation)) {
      const at = this.callers.indexOf(_conversation);
      if (at >= 0) this.callers.splice(at, 1);
      id = _conversation;
    } else if (this.callers.length > 0) {
      id = this.callers.shift();
    }
    let agent: CursorFolder | undefined;
    if (id) {
      const folder = this.folders.get(id);
      if (folder) agent = this.agents.get(folder);
    } else if (this.agents.size === 1) {
      agent = [...this.agents.values()][0];
    }
    if (!agent) {
      throw new Error(
        id
          ? "This chat is not on the message bus. Chats without a workspace, in the temp directory, background agents, and one-shot agent -p runs do not join."
          : "Cannot tell which chat this call comes from (the message-bus preToolUse hook did not run)."
      );
    }
    if (!agent.conn.id) throw new Error(`Not connected to the bus at ${this.url} yet (still trying).`);
    if (params.op === "wait") {
      const conversation = id ?? agent.conversationId;
      if (!conversation) throw new Error("This chat is not on the message bus.");
      return agent.park(conversation);
    }
    return agent.tool.run(params as unknown as MessageBusToolParams, agent.folder);
  }
}

export class CursorMcp extends McpToolServer {
  constructor(
    write: (line: string) => void,
    private readonly run: (args: Record<string, unknown>) => Promise<string>
  ) {
    super(write, {
      instructions: INSTRUCTIONS,
      capabilities: { tools: {}, logging: {} },
      tools: [{ name: TOOL_NAME, description: DESCRIPTION, inputSchema: cursorInputSchema() }],
    });
  }

  protected async callTool(_name: string, args: Record<string, unknown>, extra?: McpCallExtra): Promise<McpToolResult> {
    if (args.op !== "wait") return textResult(await this.run(args));
    // A silent tools/call is dropped (the IDE's idle limit is about an hour, and it resets on progress).
    const timer = setInterval(() => {
      extra?.progress("waiting for a message");
      this.notify("notifications/message", { level: "debug", data: "waiting for a message" });
    }, 20_000);
    timer.unref();
    try {
      return textResult(await this.run(args));
    } finally {
      clearInterval(timer);
    }
  }
}
