// Agents' own web pages in the website's right pane (docs/right-pane.md): `serve --ext gpudash=http://127.0.0.1:3420`
// makes /ext/gpudash/<key>/… forward to that page. A frame cannot send the sign-in header, so the key rides in the
// path: the signed file key the website already holds (a day long, only while its person's session is). Relative
// URLs on the page carry it along. GET and HEAD only; streams (server-sent events) pass through as they come.
import type { HumanAuth } from "./auth";
import { CORS_HEADERS } from "./http";

/** Response headers passed back from the page's server; the rest (cookies, its own security headers) stay behind. */
const KEPT_HEADERS = ["content-type", "cache-control", "last-modified", "etag", "content-length"];

/** `/ext/<name>/<key>/<path>` → the page's answer, or undefined when the path is not one of these. */
export async function forwardExtension(
  req: Request,
  url: URL,
  extensions: Record<string, string>,
  auth: HumanAuth
): Promise<Response | undefined> {
  const match = /^\/ext\/([a-z0-9][a-z0-9_-]*)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match?.[1] || !match[2]) return undefined;
  const target = extensions[match[1]];
  if (!target) return new Response("Unknown extension", { status: 404 });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Only GET", { status: 405 });
  if (!auth.checkFileKey(decodeURIComponent(match[2]))) return new Response("Sign in again (the key ran out)", { status: 401 });
  // Without the trailing slash the page's relative URLs would lose the key: send it to the slashed address.
  if (match[3] === undefined) return Response.redirect(`${url.pathname}/${url.search}`, 302);
  const headers = new Headers();
  for (const name of ["accept", "last-event-id", "if-none-match", "if-modified-since"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  let res: Response;
  try {
    res = await fetch(`${target.replace(/\/+$/, "")}${match[3]}${url.search}`, { method: req.method, headers, signal: req.signal, redirect: "manual" });
  } catch (error) {
    return new Response(`${match[1]} is not answering: ${error instanceof Error ? error.message : String(error)}`, { status: 502 });
  }
  const out = new Headers(CORS_HEADERS);
  for (const name of KEPT_HEADERS) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  // The frame runs without the website's origin (sandbox), so its requests are cross-origin: allowed above (CORS).
  out.set("X-Content-Type-Options", "nosniff");
  if (res.headers.get("content-type")?.startsWith("text/event-stream")) out.set("X-Accel-Buffering", "no");
  return new Response(res.body, { status: res.status, headers: out });
}
