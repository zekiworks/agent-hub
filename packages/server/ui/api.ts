// HTTP calls and the browser-wide keys shared by the conversations page (app.ts) and the sign-in page (auth.ts).
import { isJsonObject } from "@agent-bus/protocol";

/** The human this browser writes as (set at passkey sign-in). */
export const PROFILE_KEY = "agent-bus.profile";
/** The passkey session (set by the sign-in page, /auth), sent with every request: the bus answers only signed-in people. */
export const SESSION_KEY = "agent-bus.session";

/** The key file links carry (GET /api/auth/state hands it out; an <img> cannot send the session header). */
let fileKey = "";

export function setFileKey(key: string): void {
  fileKey = key;
}

export function fileUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}${fileKey ? `?k=${encodeURIComponent(fileKey)}` : ""}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const session = localStorage.getItem(SESSION_KEY);
  const headers = new Headers(init?.headers);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const error = isJsonObject(body) && typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
    throw new Error(error);
  }
  return body as T;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
