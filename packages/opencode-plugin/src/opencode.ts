// The slice of OpenCode V2's promise plugin API (`@opencode/plugin` 2.3) this plugin uses, written out so the repo
// needs no OpenCode packages: OpenCode gives its plugins `@opencode/plugin` at runtime, and `Plugin.define` there is
// the identity, so a plain `{ id, setup }` default export is the same plugin. A change in OpenCode's API is caught by
// the smoke test against a real OpenCode (tests/smoke/opencode.ts), not by the compiler.

export interface Registration {
  dispose(): Promise<void>;
}

export interface SessionInfo {
  id: string;
  parentID?: string;
  location: { directory: string };
  time: { archived?: number };
}

export interface SyntheticInput {
  sessionID: string;
  text: string;
  /** "steer": at the next step boundary, without interrupting a running tool. */
  delivery: "steer";
  /** Whether it starts a turn when the session is idle. */
  resume: boolean;
  metadata?: Record<string, unknown>;
}

interface SessionHooks {
  prompt: { sessionID: string; messageID: string; prompt: { text: string } };
  /** Before each model request: `messages` is what the model gets. */
  context: { sessionID: string; messages: unknown };
}

interface ToolHooks {
  "execute.before": { sessionID: string; id: string; tool: string; input: unknown };
  "execute.after":
    | { sessionID: string; id: string; tool: string; status: "completed"; result: { content: unknown } }
    | { sessionID: string; id: string; tool: string; status: "failed"; error: unknown };
}

export interface ToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  /** codemode: callable from Code Mode as `tools["name"](input)`. */
  options?: { codemode?: boolean };
  execute(input: unknown, context: { sessionID: string }): Promise<{ content: string }>;
}

interface EventData {
  "session.created": { sessionID: string };
  "session.viewed": { sessionID: string };
  "session.deleted": { sessionID: string };
  "session.archived": { sessionID: string };
  "session.unarchived": { sessionID: string };
  "session.moved": { sessionID: string };
  "session.execution.started": { sessionID: string };
  "session.execution.succeeded": { sessionID: string };
  "session.execution.failed": { sessionID: string };
  "session.execution.interrupted": { sessionID: string };
  "session.tool.progress": { sessionID: string; id: string; metadata: { output?: unknown } };
  "session.text.delta": { sessionID: string; assistantMessageID: string; ordinal: number; delta: string };
  "session.text.ended": { sessionID: string; assistantMessageID: string; ordinal: number; text: string };
  "session.reasoning.delta": { sessionID: string; assistantMessageID: string; ordinal: number; delta: string };
  "session.reasoning.ended": { sessionID: string; assistantMessageID: string; ordinal: number; text: string };
  "server.heartbeat": Record<string, never>;
}

/** An event from `ctx.event.subscribe`; other types the plugin ignores carry no `sessionID` it reads. */
export type OpenCodeEvent = { [Type in keyof EventData]: { type: Type; created: number; data: EventData[Type] } }[keyof EventData];

export interface Context {
  readonly location: { directory: string };
  readonly options: Record<string, unknown>;
  readonly session: {
    get(input: { sessionID: string }): Promise<SessionInfo>;
    synthetic(input: SyntheticInput): Promise<unknown>;
    hook<Name extends keyof SessionHooks>(name: Name, handler: (event: SessionHooks[Name]) => void | Promise<void>): Promise<Registration>;
  };
  readonly tool: {
    transform(transform: (editor: { add(tool: ToolDefinition): void }) => void): Promise<Registration>;
    hook<Name extends keyof ToolHooks>(name: Name, handler: (event: ToolHooks[Name]) => void | Promise<void>): Promise<Registration>;
  };
  readonly event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent>;
  };
}

/** What OpenCode loads: the default export of a V2 plugin package. */
export interface Plugin {
  readonly id: string;
  setup(context: Context): Promise<(() => Promise<void> | void) | void>;
}
