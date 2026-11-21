// Notifications while Agent Hub is closed (Ümit #13927, #13934): this device subscribes to the bus's Web Push, and the
// service worker (sw.js) shows them, as a banner on the iPhone or a desktop notification. On an iPhone only a site added
// to the Home Screen and opened from there may (iOS 16.4+). Off until turned on in Settings, per device.
import type { PushKeyResponse } from "@agent-bus/protocol";
import { api, postJson } from "./api";
import { noteAttention } from "./attention";

/** This device is subscribed: the page's own notifications (notify.ts) step aside so nothing shows twice. */
const PUSH_KEY = "agent-bus.push";

export type PushState =
  /** No service workers or push here (an old browser, or a page not on https/localhost). */
  | "unsupported"
  /** An iPhone or iPad in Safari: notifications need the Home Screen app. */
  | "home-screen-first"
  | "denied"
  | "off"
  | "on";

const APPLE_TOUCH = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

const supported = (): boolean => window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** The service worker, registered at every page load (it updates itself; nothing is shown unless a device subscribed). */
const registration: Promise<ServiceWorkerRegistration | undefined> =
  window.isSecureContext && "serviceWorker" in navigator
    ? navigator.serviceWorker.register("/sw.js").catch(() => undefined)
    : Promise.resolve(undefined);

// A tap on a notification while the website is open: go to its conversation here.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; url?: string } | undefined;
    if (data?.type !== "open" || !data.url) return;
    const url = new URL(data.url);
    const seq = Number(url.searchParams.get("n"));
    if (seq) noteAttention(seq, "notification");
    location.hash = url.hash;
  });
}

export function pushOnHere(): boolean {
  return localStorage.getItem(PUSH_KEY) === "1";
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await registration;
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function pushState(): Promise<PushState> {
  if (APPLE_TOUCH && !standalone()) return "home-screen-first";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const sub = await subscription();
  if (!sub) localStorage.removeItem(PUSH_KEY);
  return sub ? "on" : "off";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Asks for permission (from the click itself: iPhones allow it only then), subscribes, and tells the bus. */
export async function turnPushOn(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration;
  if (!reg) return "unsupported";
  const { publicKey } = await api<PushKeyResponse>("/api/push/key");
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await postJson("/api/push/subscribe", { subscription: sub.toJSON() });
  localStorage.setItem(PUSH_KEY, "1");
  return "on";
}

export async function turnPushOff(): Promise<void> {
  const sub = await subscription();
  localStorage.removeItem(PUSH_KEY);
  if (!sub) return;
  await postJson("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

/** Has the bus send this device a test notification; throws when the push service refused it. */
export async function testPush(): Promise<void> {
  const sub = await subscription();
  if (!sub) throw new Error("This device is not subscribed");
  const { status } = await postJson<{ status: number }>("/api/push/test", { endpoint: sub.endpoint });
  if (status < 200 || status >= 300) throw new Error(`the push service answered HTTP ${status}`);
}
