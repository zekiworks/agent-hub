// Qwen Code's UserPromptSubmit hook: put unseen Agent Hub deliveries in front of the model before a turn.
import * as os from "node:os";
import { replyAddress } from "../../protocol/src/address";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { realFolder } from "../../client/src/runtime";
import { deliveryText, isScratchFolder } from "../../client/src/tool";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

// Installs before 25 Nov ran the Qwen hook without --harness.
const harness = (arg("--harness") ?? "qwen").trim().toLowerCase();
const title = harness.charAt(0).toUpperCase() + harness.slice(1);

async function main(): Promise<void> {
  const folder = realFolder(process.cwd());
  const url = (arg("--url") ?? process.env.AGENT_BUS_URL ?? "http://127.0.0.1:7800").replace(/\/+$/, "");
  if (isScratchFolder(folder)) return;
  let joined!: () => void;
  const ready = new Promise<void>((resolve) => (joined = resolve));
  const connection = new BusConnection({
    url,
    host: os.hostname(),
    harness,
    path: folder,
    // The hook reads all unseen messages through Inbox below. Resolve live deliveries immediately so this short-lived
    // connection never holds the bus delivery queue open while the harness waits for the hook process to exit.
    onDeliver: async () => {},
    onJoined: () => joined(),
    onLog: (line) => process.stderr.write(`[agent-hub] ${line}\n`),
  });
  connection.connect();
  // The harness owns the command deadline. This hook waits only for the join event: it never polls Agent Hub or
  // schedules a background timer between turns.
  await ready;
  if (!connection.id) throw new Error(`Agent Hub did not accept the ${title} Inbox hook connection`);

  const inbox = await connection.inbox(0, 100, true);
  const conversations = new Map(inbox.conversations.map((conversation) => [conversation.id, conversation]));
  const unseen = inbox.messages.filter((message) => {
    const receipt = message.receipts.find((candidate) => candidate.to === connection.id);
    return receipt !== undefined && receipt.seenAt === null && receipt.expired !== true;
  });
  const injected: string[] = [];
  for (const message of unseen) {
    const conversation = conversations.get(message.conversationId);
    if (!conversation) continue;
    const delivery: Delivery = {
      type: "deliver",
      message,
      conversation,
      replyTo: replyAddress(conversation, connection.id),
      wake: message.wake?.includes(connection.id) ?? false,
    };
    injected.push(await deliveryText(connection, delivery));
    connection.markSeen(message.seq);
  }
  if (injected.length > 0) process.stdout.write(`${injected.join("\n\n")}\n`);
  connection.close();
}

void main().catch((error) => {
  // Inbox availability must never block the user's prompt. Hook diagnostics go to stderr, not model context.
  process.stderr.write(`[agent-hub] ${title} Inbox hook: ${error instanceof Error ? error.message : String(error)}\n`);
});
