// The viewer WebSocket (/ws/viewer): connects, reconnects with backoff, shows the link status.
import { isJsonObject, type ViewerClientFrame, type ViewerServerFrame } from "@agent-bus/protocol";
import { SESSION_KEY } from "./api";
import { dom } from "./dom";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export interface ViewerHandlers {
  /** The socket is open; `reconnected` when an earlier connection of this page was open before. */
  onOpen(reconnected: boolean): void;
  onFrame(frame: ViewerServerFrame): void;
}

let handlers: ViewerHandlers | undefined;
let socket: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: Timer | null = null;
let everConnected = false;

export function setLinkStatus(stateName: "connecting" | "live" | "offline", text: string): void {
  dom.linkStatus.dataset.state = stateName;
  dom.linkStatus.textContent = text;
}

/** Connects (once, at boot); the socket reconnects on its own after that. */
export function connectViewer(viewerHandlers: ViewerHandlers): void {
  handlers = viewerHandlers;
  connect();
}

/** Sends `frame` when the socket is open; false when it is not. */
export function sendViewer(frame: ViewerClientFrame): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function connect(): void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/viewer`;
  const ws = new WebSocket(url);
  socket = ws;
  setLinkStatus("connecting", everConnected ? "reconnecting…" : "connecting…");

  ws.addEventListener("open", () => {
    // The browser cannot send the session as a header here; the first frame signs in.
    ws.send(JSON.stringify({ type: "auth", session: localStorage.getItem(SESSION_KEY) ?? "" } satisfies ViewerClientFrame));
    reconnectDelay = RECONNECT_MIN_MS;
    setLinkStatus("live", "live");
    const reconnected = everConnected;
    everConnected = true;
    handlers?.onOpen(reconnected);
    sayVisible();
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isJsonObject(frame)) return;
    handlers?.onFrame(frame as ViewerServerFrame);
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    setLinkStatus("offline", `offline — retrying in ${Math.round(reconnectDelay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  });
}

window.addEventListener("online", () => {
  if (socket || reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connect();
});

/** Away longer than this, a page coming back reconnects rather than trust its socket. */
const RESUME_RECONNECT_MS = 5000;
let hiddenAt: number | undefined;

// A phone stops a page in the background (the Home Screen app above all) and its socket dies without a "close": back
// in front, the page said "live" and showed nothing new (Ümit #14473, #14475: no messages, the bus had no connection
// of hers). Coming back after a while it connects afresh; the fresh connection reloads what it missed (onOpen).
function resume(): void {
  const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
  hiddenAt = undefined;
  if (socket && socket.readyState === WebSocket.OPEN && away < RESUME_RECONNECT_MS) return;
  clearTimeout(reconnectTimer ?? undefined);
  reconnectTimer = null;
  const old = socket;
  socket = null;
  old?.close();
  reconnectDelay = RECONNECT_MIN_MS;
  connect();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") hiddenAt = Date.now();
  else resume();
  sayVisible();
});
// Back from the page cache (iOS keeps the whole page and its dead socket).
window.addEventListener("pageshow", (event) => {
  if (event.persisted) resume();
});

/**
 * Tells the bus whether this page is in front (shown and focused): while it is, the bus sends the person no phone or
 * desktop notification, the page shows the message already (Ümit #14595: a banner on top of the open app). Repeated
 * every 30 s while in front; the bus stops counting a page it has not heard from for a minute.
 */
function sayVisible(): void {
  sendViewer({ type: "visible", visible: document.visibilityState === "visible" && document.hasFocus() });
}
window.addEventListener("focus", sayVisible);
window.addEventListener("blur", sayVisible);
setInterval(() => {
  if (document.visibilityState === "visible" && document.hasFocus()) sayVisible();
}, 30_000);
