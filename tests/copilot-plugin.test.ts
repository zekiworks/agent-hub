import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { busFolder } from "../packages/copilot-plugin/src/extension";

test("Copilot app worktrees join as their repository; other folders as themselves", () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "copilot-home-")));
  const before = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    const worktrees = path.join(home, "copilot-worktrees");
    expect(busFolder(path.join(worktrees, "agent-hub", "cbasaran-congenial-bassoon"))).toBe(path.join(worktrees, "agent-hub"));
    expect(busFolder(path.join(worktrees, "agent-hub", "wt", "packages"))).toBe(path.join(worktrees, "agent-hub"));
    expect(busFolder("/Users/someone/code/agent-hub")).toBe("/Users/someone/code/agent-hub");
    expect(busFolder(worktrees)).toBe(worktrees);
  } finally {
    if (before === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = before;
  }
});
