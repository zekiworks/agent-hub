import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StateResponse } from "@agent-bus/protocol";
import { busFetch, startBus } from "./helpers";

// The agent's page: echoes the path it was asked for, and a stream that sends one event.
const page = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/stream") {
      return new Response("event: snapshot\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream", "Set-Cookie": "x=1" } });
    }
    return new Response(`page ${url.pathname}${url.search}`, { headers: { "Content-Type": "text/plain", "Set-Cookie": "x=1" } });
  },
});
const dir = mkdtempSync(path.join(tmpdir(), "bus-ext-"));
const bus = startBus({ host: "127.0.0.1", port: 0, dataDir: dir, humans: ["carol"], extensions: { dash: `http://127.0.0.1:${page.port}` } });
afterAll(() => {
  bus.stop();
  page.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("an agent's page: listed in the state, served under /ext/<name>/<key>/ to signed-in people only, GET only", async () => {
  expect(((await (await busFetch(bus, "/api/state", {}, "carol")).json()) as StateResponse).extensions).toEqual(["dash"]);
  const key = ((await (await busFetch(bus, "/api/auth/state", {}, "carol")).json()) as { fileKey: string }).fileKey;
  const at = (rest: string, init?: RequestInit) => fetch(`${bus.url}/ext/dash/${encodeURIComponent(key)}${rest}`, { ...init, redirect: "manual" });

  const res = await at("/app.js?v=2");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("page /app.js?v=2"); // the key is stripped, the rest forwarded as is
  expect(res.headers.get("set-cookie")).toBeNull(); // the page cannot set cookies on the bus's site
  expect(res.headers.get("access-control-allow-origin")).toBe("*"); // the sandboxed frame is cross-origin
  expect(await (await at("/api/stream")).text()).toContain("event: snapshot");
  // Without the slash, relative URLs would lose the key: redirected.
  expect((await at("")).headers.get("location")).toEndWith(`/ext/dash/${encodeURIComponent(key)}/`);
  expect((await at("/x", { method: "POST" })).status).toBe(405);
  // Without a valid key, or for a page not configured: refused.
  expect((await fetch(`${bus.url}/ext/dash/${encodeURIComponent(`${key}x`)}/`)).status).toBe(401);
  expect((await fetch(`${bus.url}/ext/other/${encodeURIComponent(key)}/`)).status).toBe(404);
  // Signing out ends the key too.
  await busFetch(bus, "/api/auth/logout", { method: "POST" }, "carol");
  expect((await at("/")).status).toBe(401);
});
