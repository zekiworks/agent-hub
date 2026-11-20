import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installModel, isBetter, peopleOf, previousOf, weeklySchedule } from "../packages/complete-ext/finetune/train-suggestions";

const ENV = { PATH: "/home/maya/.local/bin:/usr/bin", HOME: "/home/maya" };
const COMMAND = ["/home/maya/.local/bin/agent-bus", "train-suggestions", "--data-dir", "/home/maya/.agent-bus", "--model-out", "/home/maya/models/50% off.gguf"];

test("the people are the hub's humans", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE participants (id TEXT PRIMARY KEY, kind TEXT NOT NULL)");
  db.exec("INSERT INTO participants VALUES ('uma', 'human'), ('webapp', 'agent'), ('carol', 'human')");
  expect(peopleOf(db)).toEqual(["carol", "uma"]);
});

test("a candidate is better only with more shown & right and more paired wins than losses", () => {
  expect(isBetter({ cuts: 100, shownRight: { base: 10, tuned: 12 }, rightWins: 5, rightLosses: 3 })).toBe(true);
  expect(isBetter({ cuts: 100, shownRight: { base: 10, tuned: 12 }, rightWins: 3, rightLosses: 3 })).toBe(false);
  expect(isBetter({ cuts: 100, shownRight: { base: 12, tuned: 12 }, rightWins: 5, rightLosses: 3 })).toBe(false);
  expect(isBetter({ cuts: 0, shownRight: { base: 0, tuned: 0 }, rightWins: 0, rightLosses: 0 })).toBe(false);
});

test("the replaced model is kept beside it", () => {
  expect(previousOf("/m/LFM3-1.7B-suggestions-BF16.gguf")).toBe("/m/LFM3-1.7B-suggestions-BF16.previous.gguf");
  expect(previousOf("/m/model")).toBe("/m/model.previous");
});

test("a better model replaces the file, which stays beside it; the first one just lands", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "train-suggestions-"));
  try {
    const out = path.join(dir, "models", "m.gguf");
    writeFileSync(path.join(dir, "a.gguf"), "first");
    expect(installModel(path.join(dir, "a.gguf"), out)).toBeUndefined();
    writeFileSync(path.join(dir, "b.gguf"), "second");
    expect(installModel(path.join(dir, "b.gguf"), out)).toBe(path.join(dir, "models", "m.previous.gguf"));
    expect(readFileSync(out, "utf8")).toBe("second");
    expect(readFileSync(path.join(dir, "models", "m.previous.gguf"), "utf8")).toBe("first");
    expect(readdirSync(dir).sort()).toEqual(["models"]);
    expect(readdirSync(path.join(dir, "models")).sort()).toEqual(["m.gguf", "m.previous.gguf"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("weekly on Linux: a systemd user timer it does not turn on, with specifiers escaped", () => {
  const plan = weeklySchedule("linux", true, COMMAND, ENV, "/home/maya/.agent-bus/suggest-training/weekly.log");
  expect(plan.files.map((f) => f.path)).toEqual([
    "/home/maya/.config/systemd/user/agent-bus-train-suggestions.service",
    "/home/maya/.config/systemd/user/agent-bus-train-suggestions.timer",
  ]);
  expect(plan.files[0]!.text).toContain('ExecStart="/home/maya/.local/bin/agent-bus" "train-suggestions"');
  expect(plan.files[0]!.text).toContain('"/home/maya/models/50%% off.gguf"');
  expect(plan.files[0]!.text).toContain('Environment="PATH=/home/maya/.local/bin:/usr/bin"');
  expect(plan.files[1]!.text).toContain("OnCalendar=Sun *-*-* 04:00:00");
  expect(plan.instructions).toContain("systemctl --user daemon-reload && systemctl --user enable --now agent-bus-train-suggestions.timer");
});

test("weekly on macOS: a launchd agent; elsewhere a cron line", () => {
  const mac = weeklySchedule("darwin", false, COMMAND, { PATH: "/usr/bin", HOME: "/Users/maya" }, "/Users/maya/.agent-bus/suggest-training/weekly.log");
  expect(mac.files[0]!.path).toBe("/Users/maya/Library/LaunchAgents/com.agent-hub.train-suggestions.plist");
  expect(mac.files[0]!.text).toContain("<string>/home/maya/models/50% off.gguf</string>");
  expect(mac.files[0]!.text).toContain("<key>Weekday</key><integer>0</integer>");
  const cron = weeklySchedule("linux", false, COMMAND, ENV, "/tmp/weekly.log");
  expect(cron.files).toEqual([]);
  expect(cron.instructions).toContain("0 4 * * 0 PATH=/home/maya/.local/bin:/usr/bin /home/maya/.local/bin/agent-bus train-suggestions");
  expect(cron.instructions).toContain("'/home/maya/models/50\\% off.gguf' >> /tmp/weekly.log 2>&1");
});
