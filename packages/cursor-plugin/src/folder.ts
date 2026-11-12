// One Cursor workspace on the bus (the same identity rule as omp: the folder names the agent). Cursor has no call that
// submits into an already-idle chat, so a delivery waits for a hook of the folder's latest chat, or for its waiter:
// - an idle chat that left `agent-bus wait` running in the background gets a wake as that command's output: the
//   command exits, and Cursor starts a turn when a background command the chat started finishes;
// - a turn parked in message-bus op=wait gets a wake as that tool's result;
// - otherwise a running turn gets it after the current tool succeeds (postToolUse additional_context); a failed tool does not;
// - a turn that ends first gets it as the next user message (stop followup_message), which starts another turn.
// A completed turn is not asked to call op=wait. That follow-up is another user message, so answering it starts
// another turn and the hook sends it again. Quiet @all and receipt notices never start one and never unblock a wait.
import * as os from "node:os";
import { ActivityLog } from "../../client/src/activity";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { HeldQueue, UnseenSeqs } from "../../client/src/held";
import { StatusTracker } from "../../client/src/status";
import { BusTool, deliveryText } from "../../client/src/tool";
import { replyAddress, shouldWake } from "../../protocol/src/address";
import { DEFAULT_AGENT_SETTINGS, type ReceiptFrame } from "../../protocol/src/types";

/** How long the first hook waits for the startup inbox recovery before answering without it (the bus may be down). */
const STARTUP_WAIT_MS = 800;

/**
 * The IDE drops a tool call that stays quiet for about an hour, and progress pings only reset the idle timer.
 * Returning on our own, with time to spare, lets the model call wait again.
 */
const PARK_MS = 45 * 60_000;

/**
 * Submitted as the next user message when a turn finishes with nothing that should wake the chat. The model calls
 * op=wait. `prompt` compares against this exact text so that follow-up does not count as the user reaching the composer.
 */
export const WAIT_FOLLOWUP =
  "Call the message-bus tool with op=wait, then stop. It returns when a bus message arrives or when you send a message.";

const WAIT_USER =
  "The user just submitted a composer message. If that message is already in this turn, answer it. If it is not, stop without answering so it can be delivered next. Do not call wait again in this turn.";

const WAIT_AGAIN = "No bus message yet. Call message-bus with op=wait again.";

type ParkReason = "wake" | "user" | "again" | "closed";

export class CursorFolder {
  readonly conn: BusConnection;
  readonly tool: BusTool;
  /** The latest main chat in this folder. Bus messages are handed to its hooks. */
  conversationId: string | undefined;

  private readonly unseen: UnseenSeqs;
  private readonly held: HeldQueue;
  private readonly status: StatusTracker;
  private readonly activity: ActivityLog;
  private resolveStartup: () => void = () => {};
  // Not Promise.withResolvers: the bundled plugin runs on Node 20, which lacks it.
  private readonly startup = new Promise<void>((resolve) => (this.resolveStartup = resolve));
  private startupWait?: Promise<void>;
  private restoring = false;
  /** Seqs recovered from the inbox at startup: their live delivery (a replay) is not held twice. */
  private readonly restored = new Set<number>();
  private turnKey = "";
  private thinking = "";
  /** The composer submitted while op=wait was blocked. That stop does not also submit a follow-up. */
  private yieldToUser = false;
  /** The wait tool's own postToolUse must not take the queue: that turn was told to stop for the user. */
  private handoffPaused = false;
  private waiter?: (reason: ParkReason) => void;
  /** The `agent-bus wait` command running in the background of this folder's chat, if any (one at a time). */
  private listener?: (text: string) => void;

  constructor(
    readonly folder: string,
    busUrl: string,
    private readonly log: (line: string) => void
  ) {
    this.unseen = new UnseenSeqs((seq) => this.conn.markSeen(seq));
    this.held = new HeldQueue(this.unseen);
    this.status = new StatusTracker(log);
    this.activity = new ActivityLog((events, replay) => this.conn.sendActivity(events, replay));
    this.conn = new BusConnection({
      url: busUrl,
      host: os.hostname(),
      harness: "cursor",
      path: folder,
      onDeliver: async (delivery) => {
        await this.startup;
        if (!this.restored.delete(delivery.message.seq)) await this.hold(delivery);
      },
      onReceipt: (receipt) => this.receipt(receipt),
      onWatch: (on) => this.activity.setWatching(on),
      onJoined: (id) => {
        this.log(`on the bus as @${id} (${folder})`);
        if (this.restoring) return;
        this.restoring = true;
        void this.restoreHeld(id)
          .catch((err: Error) => this.log(`restore inbox: ${err.message}`))
          .finally(() => this.resolveStartup());
      },
      onLog: log,
    });
    this.tool = new BusTool(this.conn);
    this.conn.connect();
    this.status.attach(this.conn);
  }

  /** The first hook that can hand text over waits, once, so a restart's inbox is included. Later hooks don't. */
  waitForStartup(): Promise<void> {
    return (this.startupWait ??= new Promise((resolve) => {
      const timer = setTimeout(resolve, STARTUP_WAIT_MS);
      void this.startup.then(() => {
        clearTimeout(timer);
        resolve();
      });
    }));
  }

  close(): void {
    this.resolveStartup();
    this.waiter?.("closed");
    this.activity.dispose();
    this.status.detach();
    this.conn.close();
  }

  activate(conversationId: string): void {
    this.conversationId = conversationId;
  }

  /** A new chat, or the turn ended with nothing left that should start another. */
  setIdle(): void {
    this.status.setIdle();
    this.wakeListener();
  }

  /**
   * `agent-bus wait` (a command the chat leaves running in the background): resolves with the next wake once the
   * chat is idle, taken from the queue (so it counts as seen when the command prints it). While a turn runs, its hooks
   * hand messages over instead. Resolves undefined at once when another waiter already listens: the command then
   * exits within the turn that started it, so a second waiter never stacks up. `signal` aborts when the command dies.
   */
  listen(signal: AbortSignal): Promise<string | undefined> {
    if (this.listener) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const done = (text: string | undefined): void => {
        if (this.listener === give) this.listener = undefined;
        signal.removeEventListener("abort", aborted);
        resolve(text);
      };
      const give = (text: string): void => done(text);
      const aborted = (): void => done(undefined);
      signal.addEventListener("abort", aborted);
      this.listener = give;
      this.wakeListener();
    });
  }

  /** Hands the held messages to the background waiter when there is a wake among them and no turn is running. */
  private wakeListener(): void {
    if (!this.listener || this.status.busy || this.waiter || !this.held.hasWake()) return;
    const text = this.held.take();
    if (text) this.listener(text);
  }

  /** The user closed this chat. A different chat in the folder keeps the agent. */
  ended(conversationId: string): void {
    if (this.conversationId !== conversationId) return;
    this.conversationId = undefined;
    this.waiter?.("closed");
    this.setIdle();
  }

  prompt(text: string): void {
    this.status.setBusy();
    this.turnKey = `t:${Date.now()}`;
    this.thinking = "";
    if (text.trim()) this.activity.user(Date.now(), text, this.turnKey);
    // The follow-up that asks the model to park is not the user reaching the composer.
    if (this.waiter && text.trim() !== WAIT_FOLLOWUP) this.waiter("user");
  }

  /**
   * message-bus op=wait. Blocks until a wake is held, the user submits in the composer, or PARK_MS elapses.
   * A wake's text is the tool result (and is marked seen). Quiet items ride along with it. The other two
   * results leave the queue for a later hook.
   */
  park(conversationId: string): Promise<string> {
    if (conversationId !== this.conversationId) {
      return Promise.reject(new Error("This chat is not the one the folder's bus messages go to."));
    }
    this.waiter?.("again");
    return new Promise((resolve, reject) => {
      let settled = false;
      let finish: (reason: ParkReason) => void = () => {};
      const timer = setTimeout(() => finish("again"), PARK_MS);
      timer.unref();
      finish = (reason: ParkReason): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.waiter === finish) this.waiter = undefined;
        if (reason === "closed") {
          reject(new Error("The chat left the bus."));
          return;
        }
        if (reason === "user") {
          this.yieldToUser = true;
          this.handoffPaused = true;
          resolve(WAIT_USER);
          return;
        }
        if (reason === "wake") {
          resolve(this.held.take() ?? WAIT_AGAIN);
          return;
        }
        resolve(WAIT_AGAIN);
      };
      if (this.held.hasWake()) {
        finish("wake");
        return;
      }
      this.waiter = finish;
      if (this.held.hasWake()) finish("wake");
    });
  }

  toolStarted(id: string, name: string, intent?: string): void {
    this.status.setBusy();
    this.status.toolStarted(id, name, intent);
    this.activity.toolStart(id, name, undefined, intent);
  }

  toolEnded(id: string, output: string, failed: boolean): void {
    this.status.toolEnded(id);
    this.activity.toolOutput(id, output, failed ? "error" : "done");
  }

  thought(text: string): void {
    if (!text.trim()) return;
    this.thinking = text;
    this.activity.assistant(Date.now(), "", text, false, `a:${this.turnKey || Date.now()}`);
  }

  assistant(text: string): void {
    this.activity.assistant(Date.now(), text, this.thinking, true, `a:${this.turnKey || Date.now()}`);
  }

  /** postToolUse: held text joins the running turn. Nothing, when this isn't the chat messages are for. */
  async afterTool(conversationId: string): Promise<Record<string, unknown>> {
    if (conversationId !== this.conversationId) return {};
    if (this.handoffPaused) {
      this.handoffPaused = false;
      return {};
    }
    await this.waitForStartup();
    const text = this.held.take();
    return text ? { additional_context: text } : {};
  }

  /**
   * stop: a wake still held becomes the next user message (Cursor submits followup_message). An aborted or failed
   * turn does not start another; the user stopped it, or starting one on an error would loop. Nothing else is
   * submitted. Asking the model to call op=wait made a follow-up on every completed turn, and answering it started
   * the next one. Quiet messages stay held.
   */
  async stop(conversationId: string, status: string | undefined): Promise<Record<string, unknown>> {
    if (conversationId !== this.conversationId) return {};
    await this.waitForStartup();
    const yieldToUser = this.yieldToUser;
    this.yieldToUser = false;
    // The composer message is already queued. A follow-up here would be sent ahead of it.
    if (status !== "completed" || yieldToUser) {
      this.setIdle();
      return {};
    }
    if (this.held.hasWake()) {
      const text = this.held.take();
      if (text) {
        this.status.setBusy();
        return { followup_message: text };
      }
    }
    this.setIdle();
    return {};
  }

  private async hold(delivery: Delivery): Promise<void> {
    const text = await deliveryText(this.conn, delivery);
    this.unseen.add(delivery.message.seq);
    this.held.push({ text, seq: delivery.message.seq, wake: delivery.wake });
    if (delivery.wake) {
      this.waiter?.("wake");
      this.wakeListener();
    }
  }

  private receipt(receipt: ReceiptFrame): void {
    const text = this.tool.receiptNotice(receipt);
    if (text) this.held.push({ text, wake: false });
  }

  // The bus replays unacknowledged deliveries. Recover the complementary case on restart: a previous process
  // acknowledged the delivery, but no hook ever handed it to the model.
  private async restoreHeld(id: string): Promise<void> {
    const { messages, conversations } = await this.conn.inbox(0, 100);
    const settings = this.conn.participants.find((participant) => participant.id === id)?.settings ?? DEFAULT_AGENT_SETTINGS;
    for (const message of messages) {
      const receipt = message.receipts.find((item) => item.to === id);
      if (!receipt?.deliveredAt || receipt.seenAt !== null) continue;
      const conversation = conversations.find((item) => item.id === message.conversationId);
      if (!conversation) continue;
      await this.hold({
        type: "deliver",
        message,
        conversation,
        replyTo: replyAddress(conversation, id),
        wake: shouldWake(conversation.kind, message.fromKind, settings),
      });
      this.restored.add(message.seq);
    }
  }
}
