// OpenCode V2 server plugin. One bus connection per active main session, not per shared server or location.
// Native synthetic inbox messages steer at a step boundary; resume:false keeps broadcasts/receipts quiet.
import * as os from "node:os";
import { ActivityLog, contentText } from "../../client/src/activity";
import { BusConnection } from "../../client/src/connection";
import { UnseenSeqs } from "../../client/src/held";
import { envBusUrl, realFolder } from "../../client/src/runtime";
import { StatusTracker } from "../../client/src/status";
import { BusTool, deliveryText, isScratchFolder, TOOL_NAME, toolDescription, toolInputSchema, type MessageBusToolParams } from "../../client/src/tool";
import type { Context, OpenCodeEvent, Plugin, SessionInfo } from "./opencode";

export type { Context } from "./opencode";

interface Binding {
  directory: string;
  connection: BusConnection;
  tool: BusTool;
  unseen: UnseenSeqs;
  status: StatusTracker;
  activity: ActivityLog;
  parts: Map<string, { at: number; text: string; thinking: string }>;
}

// A plain `{ id, setup }`: OpenCode's `Plugin.define` returns its argument unchanged (see ./opencode.ts).
const plugin: Plugin = {
  id: "agent-bus",
  async setup(ctx) {
    const log = (line: string): void => console.error(`[message-bus] ${line}`);
    const bindings = new Map<string, Binding>();
    const joining = new Map<string, Promise<Binding | undefined>>();
    const generation = new Map<string, number>();
    const stopped = new Set<string>();
    const controller = new AbortController();
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    let closed = false;

    const closeSession = (sessionID: string): void => {
      generation.set(sessionID, (generation.get(sessionID) ?? 0) + 1);
      const binding = bindings.get(sessionID);
      if (!binding) return;
      bindings.delete(sessionID);
      binding.status.detach();
      binding.activity.dispose();
      binding.connection.close();
    };

    const eligible = (info: SessionInfo): boolean =>
      !info.parentID && info.time.archived === undefined &&
      realFolder(info.location.directory) === realFolder(ctx.location.directory) &&
      !isScratchFolder(info.location.directory);

    const join = async (sessionID: string): Promise<Binding | undefined> => {
      if (closed || stopped.has(sessionID)) return undefined;
      const existing = bindings.get(sessionID);
      if (existing) return existing;
      const pending = joining.get(sessionID);
      if (pending) return pending;
      const version = generation.get(sessionID);
      const task = (async () => {
        const info = await ctx.session.get({ sessionID });
        if (closed || stopped.has(sessionID) || generation.get(sessionID) !== version || !eligible(info)) return undefined;
        const directory = realFolder(info.location.directory);
        const synthetic = (text: string, resume: boolean) => ctx.session.synthetic({
          sessionID, text, delivery: "steer", resume, metadata: { source: "agent-bus" },
        });
        const status = new StatusTracker(log);
        const parts: Binding["parts"] = new Map();
        const activity = new ActivityLog((events, replay) => connection.sendActivity(events, replay));
        const unseen = new UnseenSeqs((seq) => connection.markSeen(seq));
        const connection = new BusConnection({
          url: typeof ctx.options.busUrl === "string" && !process.env.AGENT_BUS_URL?.trim()
            ? ctx.options.busUrl.replace(/\/+$/, "") : envBusUrl(),
          host: os.hostname(),
          harness: "opencode",
          path: directory,
          async onDeliver(delivery) {
            if (closed || bindings.get(sessionID)?.connection !== connection) throw new Error("session left the bus");
            const text = await deliveryText(connection, delivery);
            unseen.add(delivery.message.seq);
            await synthetic(text, delivery.wake);
          },
          onReceipt(receipt) {
            const text = tool.receiptNotice(receipt);
            if (text) void synthetic(text, false).catch((error) => log(`receipt: ${error}`));
          },
          onWatch: (on) => activity.setWatching(on),
          onJoined: (id) => log(`OpenCode ${sessionID}: on the bus as @${id}`),
          onLog: log,
        });
        const tool = new BusTool(connection);
        const binding: Binding = { directory, connection, tool, unseen, status, activity, parts };
        bindings.set(sessionID, binding);
        status.attach(connection);
        connection.connect();
        return binding;
      })();
      joining.set(sessionID, task);
      try {
        return await task;
      } finally {
        if (joining.get(sessionID) === task) joining.delete(sessionID);
      }
    };

    registrations.push(await ctx.session.hook("prompt", async (event) => {
      const binding = await join(event.sessionID);
      binding?.activity.user(Date.now(), event.prompt.text, event.messageID);
    }));
    registrations.push(await ctx.session.hook("context", async (event) => {
      const binding = await join(event.sessionID);
      binding?.status.setBusy();
      binding?.unseen.seenIn(JSON.stringify(event.messages));
    }));
    registrations.push(await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        description: toolDescription({
          arrives: "at the next step boundary, without interrupting a running tool",
          notJoining: "subagents and sessions in the temp directory do not join",
        }),
        input: toolInputSchema(),
        options: { codemode: true },
        async execute(input, context) {
          const binding = await join(context.sessionID);
          if (!binding) throw new Error("This session is not on the message bus: subagents and sessions in the temp directory do not join.");
          return { content: await binding.tool.run(input as MessageBusToolParams, binding.directory) };
        },
      });
    }));
    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      const binding = await join(event.sessionID);
      if (!binding) return;
      binding.status.setBusy();
      binding.status.toolStarted(event.id, event.tool);
      binding.activity.toolStart(event.id, event.tool, event.input, undefined);
    }));
    registrations.push(await ctx.tool.hook("execute.after", (event) => {
      const binding = bindings.get(event.sessionID);
      if (!binding) return;
      binding.status.toolEnded(event.id);
      binding.activity.toolOutput(event.id,
        event.status === "completed" ? contentText(event.result.content) : String(event.error),
        event.status === "completed" ? "done" : "error");
    }));

    const onEvent = async (event: OpenCodeEvent): Promise<void> => {
      if (!("sessionID" in event.data)) return;
      const sessionID = event.data.sessionID;
      switch (event.type) {
        case "session.deleted":
        case "session.archived":
          stopped.add(sessionID);
          closeSession(sessionID);
          return;
        case "session.unarchived":
          stopped.delete(sessionID);
          return;
        case "session.moved":
          closeSession(sessionID);
          return; // The destination location's plugin joins when the session next runs or is viewed.
        case "session.created":
        case "session.viewed":
        case "session.execution.started": {
          const binding = await join(sessionID);
          if (event.type === "session.execution.started") binding?.status.setBusy();
          return;
        }
      }
      const binding = bindings.get(sessionID);
      if (!binding) return;
      switch (event.type) {
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          binding.status.setIdle();
          break;
        case "session.tool.progress":
          if (typeof event.data.metadata.output === "string") {
            binding.activity.toolOutput(event.data.id, event.data.metadata.output, "running");
          }
          break;
        case "session.text.delta":
        case "session.text.ended":
        case "session.reasoning.delta":
        case "session.reasoning.ended": {
          const reasoning = event.type.startsWith("session.reasoning.");
          const id = `${event.data.assistantMessageID}:${reasoning ? "r" : "t"}:${event.data.ordinal}`;
          const part = binding.parts.get(id) ?? { at: event.created, text: "", thinking: "" };
          const field = reasoning ? "thinking" : "text";
          part[field] = ("delta" in event.data ? part[field] + event.data.delta : event.data.text).slice(0, 20_000);
          binding.parts.set(id, part);
          if (binding.parts.size > 60) binding.parts.delete(binding.parts.keys().next().value!);
          binding.activity.assistant(part.at, part.text, part.thinking, event.type.endsWith(".ended"), id);
          break;
        }
      }
    };
    // Subscribe before setup returns: new sessions cannot fall into a startup gap. Never enumerate/join stored history.
    const events = ctx.event.subscribe({ signal: controller.signal });
    const listening = (async () => {
      for await (const event of events) {
        if (closed) break;
        try {
          await onEvent(event);
        } catch (error) {
          log(`OpenCode event ${event.type}: ${error}`);
        }
      }
    })().catch((error) => {
      if (!closed) log(`OpenCode event stream: ${error}`);
    });

    return async () => {
      closed = true;
      controller.abort();
      for (const sessionID of bindings.keys()) closeSession(sessionID);
      await Promise.allSettled(registrations.map((registration) => registration.dispose()));
      await listening;
    };
  },
};

export default plugin;
