// Generic command/action bridge for HTTP extensions. The bus owns identity, access, messages and live delivery;
// extensions own their rules and return small annotations the bus stores on messages.
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  Conversation,
  ExtensionAnnotation,
  ExtensionCommand,
  ExtensionCommandResponse,
  Message,
  PostMessageResponse,
  Task,
  TasksResponse,
} from "@agent-bus/protocol";
import { taskOf } from "@agent-bus/protocol";
import type { BusContext } from "./context";
import type { ParticipantRecord } from "./db";
import { mayRead } from "./conversations";
import { HttpError } from "./http";
import { recipientsFor } from "./messages";

const PROPOSAL_MS = 10 * 60_000;
const REQUEST_MS = 30_000;
const TASK_AGENT_ID = "task";

interface ManifestCommand {
  name: string;
  help: string;
  usage: string;
}

interface ExtensionManifest {
  v: number;
  name: string;
  commands: ManifestCommand[];
}

interface CommandPost {
  text: string;
  annotation: ExtensionAnnotation;
  wake?: string[];
}

interface CommandAnswer {
  post: CommandPost;
}

interface ActionAnswer {
  annotation: ExtensionAnnotation;
  notice?: { text: string; wake?: string[] };
}

interface Proposal extends CommandPost {
  id: string;
  extension: string;
  caller: string;
  conversationId: string;
  expiresAt: number;
}

function secretAt(file: string): string {
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!existsSync(file)) throw error;
    }
  }
  chmodSync(file, 0o600);
  const secret = readFileSync(file, "utf8").trim();
  if (secret.length < 32) throw new Error(`${file} must contain at least 32 characters`);
  return secret;
}

/** One configured HTTP extension. The first implementation configures `task`; the transport is extension-neutral. */
export class ExtensionRuntime {
  private manifest: ExtensionManifest | undefined;
  private readonly proposals = new Map<string, Proposal>();
  private readonly secret: string;
  private readonly pendingEvents = new Map<number, { message: Message; conversation: Conversation; annotation: ExtensionAnnotation }>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ctx: BusContext,
    private readonly name: string,
    private readonly url: string,
    secretFile: string
  ) {
    this.secret = secretAt(secretFile);
  }

  async start(): Promise<void> {
    await this.loadManifest();
    // Replaying is idempotent. It seeds a new extension database and completes the built-in-task migration.
    for (const message of this.ctx.db.extensionMessages(this.name)) {
      const conversation = this.ctx.db.getConversation(message.conversationId);
      const annotation = message.ext?.[this.name];
      if (conversation && annotation) await this.event("posted", message, conversation, annotation);
    }
  }

  async commands(): Promise<ExtensionCommand[]> {
    const manifest = this.manifest ?? (await this.loadManifest());
    return manifest.commands.map((command) => ({ extension: manifest.name, ...command }));
  }

  /** Runs a person's slash command. It returns a proposal; it does not post. */
  async command(req: Request, person: string, body: Record<string, unknown>): Promise<ExtensionCommandResponse> {
    if (body.from !== person) throw new HttpError(403, `Signed in as @${person}, not @${String(body.from ?? "")}`);
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const conversation = this.ctx.db.getConversation(conversationId);
    if (!conversation || !mayRead(this.ctx, conversation, { id: person, kind: "human" })) {
      throw new HttpError(404, `Unknown conversation "${conversationId}"`);
    }
    const command = typeof body.command === "string" ? body.command : "";
    const manifest = this.manifest ?? (await this.loadManifest());
    if (!manifest.commands.some((entry) => entry.name === command)) throw new HttpError(404, `Unknown /${command} command`);
    const raw = typeof body.raw === "string" ? body.raw.trim() : "";
    const answer = await this.call<CommandAnswer>(`/commands/${encodeURIComponent(command)}`, {
      v: 1,
      caller: { id: person, kind: "person", verified: true },
      conversation,
      raw,
    });
    return this.keepProposal(manifest.name, person, conversation, answer.post);
  }

  /** Creates a task for an agent's existing message-bus API and posts its proposal immediately. */
  async agentTask(
    writer: ParticipantRecord,
    conversation: Conversation,
    text: string,
    given: unknown
  ): Promise<{ text: string; ext: Record<string, ExtensionAnnotation>; wake: string[] }> {
    if (!given || typeof given !== "object" || Array.isArray(given)) throw new HttpError(400, "task must be {type?, assignees?}");
    const value = given as { type?: unknown; assignees?: unknown };
    const taskType = value.type === undefined ? "task" : value.type;
    if (taskType !== "task" && taskType !== "approval") throw new HttpError(400, "task type must be task or approval");
    const assignees = value.assignees;
    if (assignees !== undefined && (!Array.isArray(assignees) || !assignees.every((id) => typeof id === "string"))) {
      throw new HttpError(400, "task assignees must be participant ids");
    }
    if (taskType === "approval" && (assignees as string[] | undefined)?.some((id) => !this.ctx.humans.includes(id.replace(/^@/, "")))) {
      throw new HttpError(400, "approvals may be assigned only to people");
    }
    const raw = `${(assignees as string[] | undefined)?.map((id) => `@${id.replace(/^@/, "")}`).join(" ") ?? ""} ${text}`.trim();
    const answer = await this.call<CommandAnswer>("/commands/task", {
      v: 1,
      caller: { id: writer.id, kind: "agent" },
      conversation,
      raw,
      taskType,
    });
    return { text: answer.post.text, ext: { [this.name]: answer.post.annotation }, wake: answer.post.wake ?? [] };
  }

  /** Consumes a reviewed human proposal while its message is written. */
  consume(id: unknown, caller: string, conversationId: string): { ext: Record<string, ExtensionAnnotation>; wake: string[] } | undefined {
    if (id === undefined || id === null) return undefined;
    if (typeof id !== "string") throw new HttpError(400, "proposal must be an id");
    const proposal = this.proposals.get(id);
    this.proposals.delete(id);
    if (!proposal || proposal.expiresAt < Date.now()) throw new HttpError(409, "That /task proposal expired; run /task again. Nothing was sent.");
    if (proposal.caller !== caller || proposal.conversationId !== conversationId) throw new HttpError(403, "That proposal belongs to another person or conversation");
    return { ext: { [proposal.extension]: proposal.annotation }, wake: proposal.wake ?? [] };
  }

  async action(req: Request, action: string, body: Record<string, unknown>): Promise<{ message: Message }> {
    if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
    const writer = this.ctx.hub.knownParticipant(body.from.trim().toLowerCase());
    if (!writer) throw new HttpError(400, `Unknown participant "${body.from}"`);
    const verified = this.ctx.checkWriter(req, writer);
    const seq = Number(body.message_id);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new HttpError(400, "message_id must be a message number");
    const message = this.ctx.db.getMessage(seq);
    const conversation = message ? this.ctx.db.getConversation(message.conversationId) : null;
    if (!message || !conversation || !mayRead(this.ctx, conversation, { id: writer.id, kind: writer.kind === "human" ? "human" : "agent" })) {
      throw new HttpError(404, `Unknown task #${seq}`);
    }
    const annotation = message.ext?.[this.name];
    if (!annotation || !taskOf(message)) throw new HttpError(400, `#${seq} is not a task`);
    const requested = action === "withdraw" ? "cancel" : action;
    if (!(annotation.allowed[writer.id] ?? []).includes(requested)) throw new HttpError(403, `@${writer.id} may not ${requested} #${seq}`);
    const reason = body.reason;
    const note = body.note;
    const eta = body.eta;
    for (const [key, value] of Object.entries({ reason, note, eta })) {
      if (value !== undefined && (typeof value !== "string" || value.length > 2000)) throw new HttpError(400, `${key} must be text up to 2000 characters`);
    }
    const answer = await this.call<ActionAnswer>(`/actions/${encodeURIComponent(requested)}`, {
      v: 1,
      seq,
      caller: { id: writer.id, kind: writer.kind === "human" ? "person" : "agent", verified },
      annotation,
      input: { reason, note, eta },
    });
    const changed = this.ctx.db.setExtension(seq, this.name, answer.annotation);
    if (!changed) throw new HttpError(404, `Unknown task #${seq}`);
    this.ctx.hub.messageChanged(changed, conversation);
    if (answer.notice) this.postNotice(changed, conversation, answer.notice.text, answer.notice.wake ?? []);
    return { message: changed };
  }

  async tasks(viewer: string, box: "mine" | "assigned", state: "open" | "all"): Promise<TasksResponse> {
    const who = this.ctx.hub.knownParticipant(viewer);
    if (!who) throw new HttpError(400, `Unknown participant "${viewer}"`);
    return this.call<TasksResponse>("/queries/tasks", { v: 1, viewer, box, state });
  }

  async posted(response: PostMessageResponse): Promise<void> {
    const annotation = response.message.ext?.[this.name];
    if (!annotation) return;
    try {
      await this.event("posted", response.message, response.conversation, annotation);
    } catch (error) {
      console.error(`[${this.name} extension] posted:${response.message.seq}: ${error instanceof Error ? error.message : String(error)}`);
      this.pendingEvents.set(response.message.seq, { message: response.message, conversation: response.conversation, annotation });
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.pendingEvents.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryPosted();
    }, 5000);
    this.retryTimer.unref?.();
  }

  private async retryPosted(): Promise<void> {
    for (const [seq, pending] of this.pendingEvents) {
      try {
        await this.event("posted", pending.message, pending.conversation, pending.annotation);
        this.pendingEvents.delete(seq);
      } catch {
        break;
      }
    }
    this.scheduleRetry();
  }

  private async event(type: "posted", message: Message, conversation: Conversation, annotation: ExtensionAnnotation): Promise<void> {
    await this.call("/events", { v: 1, id: `${type}:${message.seq}`, type, message, conversation, annotation });
  }

  private keepProposal(extension: string, caller: string, conversation: Conversation, post: CommandPost): ExtensionCommandResponse {
    const id = crypto.randomUUID();
    this.proposals.set(id, { id, extension, caller, conversationId: conversation.id, expiresAt: Date.now() + PROPOSAL_MS, ...post });
    return { proposal: { id, text: post.text, label: post.annotation.label } };
  }

  private async loadManifest(): Promise<ExtensionManifest> {
    const response = await fetch(`${this.url.replace(/\/+$/, "")}/bus-extension.json`, { signal: AbortSignal.timeout(REQUEST_MS) });
    if (!response.ok) throw new Error(`${this.name} manifest: ${response.status} ${await response.text()}`);
    const manifest = (await response.json()) as ExtensionManifest;
    if (manifest.v !== 1 || manifest.name !== this.name || !Array.isArray(manifest.commands)) throw new Error(`${this.name} returned an invalid extension manifest`);
    this.manifest = manifest;
    return manifest;
  }

  private async call<T = unknown>(pathname: string, value: unknown): Promise<T> {
    const body = JSON.stringify(value);
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    let response: Response;
    try {
      response = await fetch(`${this.url.replace(/\/+$/, "")}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bus-Signature": signature },
        body,
        signal: AbortSignal.timeout(REQUEST_MS),
      });
    } catch (error) {
      throw new HttpError(502, `${this.name} is not answering: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, (await response.text()) || `${this.name} failed`);
    return (await response.json()) as T;
  }

  private postNotice(taskMessage: Message, conversation: Conversation, text: string, wake: string[]): void {
    const writer = this.ctx.db.ensureBuiltInAgent(TASK_AGENT_ID, "extension");
    const recipients = recipientsFor(this.ctx, conversation, writer.id).map((participant) => participant.id);
    const message = this.ctx.db.insertMessage({
      conversationId: conversation.id,
      from: writer.id,
      fromKind: "agent",
      text,
      files: [],
      createdAt: Date.now(),
      recipients,
      replyToSeq: taskMessage.seq,
      wake: recipients.filter((id) => wake.includes(id)),
      expiresAt: Date.now() + 24 * 3600_000,
    });
    this.ctx.hub.publishMessage(message, conversation);
  }
}
