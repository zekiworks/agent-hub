// One message-bus call for shell-only harnesses such as mini-SWE-agent.
import * as os from "node:os";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { realFolder } from "../../client/src/runtime";
import { BusTool, deliveryText, type MessageBusToolParams } from "../../client/src/tool";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

async function main(): Promise<void> {
  const raw = arg("--params") ?? process.argv.at(-1);
  if (!raw || raw.startsWith("--")) throw new Error("Pass one message-bus JSON object, e.g. '{\"op\":\"inbox\"}'");
  const params = JSON.parse(raw) as MessageBusToolParams;
  const harness = arg("--harness") ?? "mini-swe-agent";
  const url = arg("--url") ?? process.env.AGENT_BUS_URL ?? "http://127.0.0.1:7800";
  const deliveries: Array<{ text: string; release(): void }> = [];
  let joined!: () => void;
  const ready = new Promise<void>((resolve) => (joined = resolve));
  const connection = new BusConnection({
    url,
    host: os.hostname(),
    harness,
    path: realFolder(process.cwd()),
    async onDeliver(delivery: Delivery) {
      const text = await deliveryText(connection, delivery);
      await new Promise<void>((release) => deliveries.push({ text, release }));
    },
    onJoined: joined,
    onLog: (line) => process.stderr.write(`[agent-hub] ${line}\n`),
  });
  connection.connect();
  const timer = setTimeout(() => joined(), 10_000);
  await ready;
  clearTimeout(timer);
  if (!connection.id) throw new Error(`Could not join Agent Hub at ${url}`);
  const result = await new BusTool(connection).run(params, process.cwd());
  const pending = deliveries.splice(0);
  process.stdout.write(`${pending.length > 0 ? `${pending.map((item) => item.text).join("\n\n")}\n\n` : ""}${result}\n`);
  for (const item of pending) item.release();
  connection.close();
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
