// The splits of build.ts's items: TEST (the latest 30%, marked by build.ts); in the training period, DEV = the latest 15%
// of it by time (to choose the phrasing and the epochs; nothing from the dev window or later trains), FIT = the rest.
import type { Item } from "./build.ts";

export const DATA = `${process.env.HOME}/.agent-bus/finetune/needs-you/data`;
const DEV_SHARE = 0.15;
/** The dev items asked (a seeded random sample of the dev window, the natural mix). */
export const DEV_SAMPLE = 800;

export async function loadItems(): Promise<Item[]> {
  return (await Bun.file(`${DATA}/items.jsonl`).text()).trim().split("\n").map((l) => JSON.parse(l));
}

/** A seeded shuffle (Park–Miller), the same order every run. */
export function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function splits(items: Item[]): { fit: Item[]; dev: Item[]; devSample: Item[]; test: Item[] } {
  const train = items.filter((x) => x.split === "train");
  const devStart = train[Math.round(train.length * (1 - DEV_SHARE))]!.at;
  const dev = train.filter((x) => x.at >= devStart);
  return {
    fit: train.filter((x) => x.at < devStart), dev,
    devSample: shuffled(dev, 13719).slice(0, DEV_SAMPLE).sort((a, b) => a.at - b.at),
    test: items.filter((x) => x.split === "test"),
  };
}
