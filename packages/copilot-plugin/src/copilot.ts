// The part of the Copilot CLI extension SDK (`@github/copilot-sdk/extension`) this plugin uses. The CLI resolves
// that module for extension processes, so it is never installed or bundled; see the SDK's extension.d.ts.

export interface SessionEvent {
  type: string;
  id: string;
  timestamp: string;
  /** Set on events from subagents; the plugin follows only the main agent. */
  agentId?: string;
  data: Record<string, unknown>;
}

export interface ToolResult {
  textResultForLlm: string;
  resultType?: "success" | "failure" | "rejected" | "denied";
}

export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  skipPermission?: boolean;
  handler: (args: Record<string, unknown>, invocation: { sessionId: string }) => Promise<string | ToolResult>;
}

export interface HookContext {
  additionalContext?: string;
}

export interface Hooks {
  /** `agentId` is set when a subagent's turn or tool call runs the hook. */
  onUserPromptSubmitted?: (input: { prompt: string; agentId?: string }) => Promise<HookContext | void>;
  onPostToolUse?: (input: { toolName: string; agentId?: string }) => Promise<HookContext | void>;
  onSessionStart?: (input: { source: string }) => Promise<HookContext | void>;
}

export interface MessageOptions {
  prompt: string;
  /** "enqueue" waits for the running turn; "immediate" steers it (or starts a turn when idle). */
  mode?: "enqueue" | "immediate";
  source?: "user" | "system" | `agent-${string}`;
  displayPrompt?: string;
}

export interface CopilotSession {
  readonly sessionId: string;
  send(options: MessageOptions): Promise<string>;
  log(message: string, options?: { level?: "info" | "warning" | "error"; ephemeral?: boolean }): Promise<void>;
  on(handler: (event: SessionEvent) => void): () => void;
}

export interface JoinSessionConfig {
  tools?: Tool[];
  hooks?: Hooks;
}

export type JoinSession = (config: JoinSessionConfig) => Promise<CopilotSession>;
