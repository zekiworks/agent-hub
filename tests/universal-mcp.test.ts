import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const homes: string[] = [];

async function agentBus(home: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "packages/cli/src/bin.ts", ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${stdout}${stderr}`);
}

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "agent-hub-universal-mcp-"));
  homes.push(value);
  return value;
}

afterEach(() => {
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("universal MCP adapter configuration", () => {
  test("Qwen reinstall and uninstall restore the prior settings byte for byte", async () => {
    const root = home();
    const settings = join(root, ".qwen", "settings.json");
    const before = `{
  "theme": "dark",
  "mcpServers": {
    "existing-tool": {
      "command": "printf",
      "args": ["keep-me"]
    }
  }
}
`;
    await Bun.write(settings, before);

    await agentBus(root, "install", "qwen", "--url", "http://127.0.0.1:7800", "--build-only");
    await agentBus(root, "install", "qwen", "--url", "http://127.0.0.1:7800", "--build-only");
    await agentBus(root, "uninstall", "qwen");

    expect(readFileSync(settings, "utf8")).toBe(before);
  }, 30_000);

  test("Qwen uninstall removes a settings file created only for Agent Hub", async () => {
    const root = home();
    const settings = join(root, ".qwen", "settings.json");

    await agentBus(root, "install", "qwen", "--url", "http://127.0.0.1:7800", "--build-only");
    expect(existsSync(settings)).toBe(true);
    await agentBus(root, "uninstall", "qwen");

    expect(existsSync(settings)).toBe(false);
  }, 30_000);
});
