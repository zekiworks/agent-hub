// Browser notifications for the ●● messages (mentions of me, conversations of two), and the tab title and icon that
// show how many are unread.
import type { Conversation, Message } from "@agent-bus/protocol";
import { BRAND, BRAND_ICON } from "./brand";
import { dom } from "./dom";
import { el } from "./html";
import { navigate } from "./routing";
import { conversationTitle, isCurrent, state } from "./state";

type NotifyState = "unsupported" | "insecure" | NotificationPermission;

function notifyState(): NotifyState {
  if (!("Notification" in window)) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return Notification.permission;
}

export function renderNotifyButton(): void {
  const s = notifyState();
  const btn = dom.notifyBtn;
  btn.hidden = s === "granted" || s === "unsupported";
  if (s === "default") {
    btn.textContent = "🔔 Enable notifications";
    btn.title = "Get a browser notification for messages that mention you, and in your conversations of two (the ●● ones)";
  } else if (s === "denied") {
    btn.textContent = "🔕 Notifications blocked";
    btn.title = "Allow notifications for this site in the browser's site settings (icon left of the address bar), then reload.";
  } else if (s === "insecure") {
    btn.textContent = "🔕 Notifications unavailable";
    btn.title =
      "Browsers allow notifications only on https:// or localhost pages. In Chrome: open " +
      "chrome://flags/#unsafely-treat-insecure-origin-as-secure, add " +
      `${location.origin}, set it to Enabled and relaunch.`;
  }
}

dom.notifyBtn.addEventListener("click", () => {
  if (notifyState() === "default") void Notification.requestPermission().then(renderNotifyButton);
  else alert(dom.notifyBtn.title);
});

export function notify(message: Message, conv: Conversation): void {
  if (notifyState() !== "granted" || (isCurrent(conv.id) && document.hasFocus())) return;
  const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
  const n = new Notification(`${message.from} · ${conversationTitle(conv)}`, {
    body: `${message.text.slice(0, 300)}${files}`,
    tag: `agent-bus-${message.seq}`,
  });
  n.addEventListener("click", () => {
    window.focus();
    navigate({ kind: "conversation", id: conv.id });
    n.close();
  });
}

let titleBase = BRAND;

/** Tab icon: the header's ⇄ mark in its colours (lilac, dark arrows); a red dot while messages for me are unread. */
function faviconHref(attention: boolean): string {
  const dot = attention ? '<circle cx="26" cy="6" r="6" fill="#e5484d" stroke="#fff" stroke-width="2"/>' : "";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect x="1" y="1" width="30" height="30" rx="7" fill="#b8a6dc"/>' +
    '<path d="M8 12h14l-4-4M24 20H10l4 4" fill="none" stroke="#1b1b1b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
    dot +
    "</svg>";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** With this bus's own tab icon (`--brand-icon`): the icon, the red dot drawn over it while messages are unread. */
let brandIcon: HTMLImageElement | undefined;
function setBrandFavicon(link: HTMLLinkElement, attention: boolean): void {
  if (!BRAND_ICON) return;
  if (!attention) {
    link.href = BRAND_ICON;
    return;
  }
  const draw = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const g = canvas.getContext("2d");
    if (!g || !brandIcon) return;
    g.drawImage(brandIcon, 0, 0, 32, 32);
    g.beginPath();
    g.arc(26, 6, 6, 0, Math.PI * 2);
    g.fillStyle = "#e5484d";
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = "#fff";
    g.stroke();
    if (faviconState) link.href = canvas.toDataURL("image/png");
  };
  if (brandIcon?.complete) return draw();
  brandIcon = new Image();
  brandIcon.addEventListener("load", draw, { once: true });
  brandIcon.src = BRAND_ICON;
}

let faviconState: boolean | undefined;

export function applyTitle(): void {
  let n = 0;
  for (const count of state.attention.values()) n += count;
  let urgent = 0;
  for (const count of state.urgent.values()) urgent += count;
  document.title = n > 0 ? `${urgent > 0 ? "●●" : "●"} (${n}) ${titleBase}` : titleBase;
  if (faviconState !== n > 0) {
    faviconState = n > 0;
    const link = el<HTMLLinkElement>("favicon");
    if (BRAND_ICON) setBrandFavicon(link, faviconState);
    else link.href = faviconHref(faviconState);
  }
}

/** The tab title without the unread marks: the open conversation's. */
export function setTitleBase(text: string): void {
  titleBase = text;
  applyTitle();
}
