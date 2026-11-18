import { expect, test } from "bun:test";
import type { Participant } from "@agent-bus/protocol";
import { planUp } from "../packages/cli/src/up";

const NOW = Date.parse("2026-11-15T09:00:00Z");
const DAY = 86_400_000;

function agent(id: string, extra: Partial<Participant> = {}): Participant {
  return {
    id,
    kind: "agent",
    harness: "omp",
    host: "host1",
    path: `/home/x/code/${id}`,
    online: false,
    connections: 0,
    lastSeenAt: NOW - DAY,
    settings: { all: "quiet" },
    ...extra,
  };
}

test("agent-bus up: this machine's resumable agents, each in its folder, once; the rest named with the reason", () => {
  const participants: Participant[] = [
    agent("logic"),
    agent("planner", { harness: "pi" }),
    agent("builder", { host: "Host1.lan" }), // same machine, other spelling
    agent("reader"), // already has a window
    agent("old-test", { lastSeenAt: NOW - 30 * DAY }),
    agent("gone"), // folder deleted
    agent("agent-hub@host1", { harness: "opencode" }),
    agent("mac-agent", { host: "macbook-pro-2.home" }), // other machine: not listed at all
    agent("grading", { harness: "hermes", path: undefined, host: "host1" }),
    { id: "can", kind: "human", online: false, connections: 0, lastSeenAt: NOW, settings: { all: "quiet" } },
  ];
  const plan = planUp(participants, [{ name: "hd", path: "/home/x/code/reader" }], {
    host: "host1",
    now: NOW,
    sinceDays: 7,
    exists: (p) => !p.endsWith("/gone"),
    real: (p) => p,
  });
  expect(plan.start).toEqual([
    { id: "builder", path: "/home/x/code/builder", command: "omp -c" },
    { id: "logic", path: "/home/x/code/logic", command: "omp -c" },
    { id: "planner", path: "/home/x/code/planner", command: "pi -c" },
  ]);
  expect(Object.fromEntries(plan.skipped.map((s) => [s.id, s.why]))).toEqual({
    "agent-hub@host1": "opencode harness: start it yourself",
    gone: "/home/x/code/gone is missing",
    grading: "no folder",
    reader: "already has a window in its folder",
    "old-test": "last seen 30 days ago",
  });
});

test("agent-bus up: a window in the same folder through a symlink counts as there", () => {
  const plan = planUp([agent("translator", { path: "/home/x/T7/translator" })], [{ name: "tr", path: "/mnt/t7/translator" }], {
    host: "host1",
    now: NOW,
    sinceDays: 7,
    exists: () => true,
    real: (p) => p.replace("/home/x/T7", "/mnt/t7"),
  });
  expect(plan.start).toEqual([]);
});
