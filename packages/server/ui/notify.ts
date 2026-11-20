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

/** The tab icon (Agent Hub's logo, or `--brand-icon`), with a red dot drawn over it while messages are unread. */
let iconImage: HTMLImageElement | undefined;
function setFavicon(link: HTMLLinkElement, attention: boolean): void {
  if (!attention) {
    link.href = BRAND_ICON;
    return;
  }
  const draw = () => {
    const canvas = document.createElement("canvas");
    // 64 px, as the icon itself: drawn at 32 it came out blurred on sharp screens.
    canvas.width = canvas.height = 64;
    const g = canvas.getContext("2d");
    if (!g || !iconImage) return;
    g.drawImage(iconImage, 0, 0, 64, 64);
    g.beginPath();
    g.arc(52, 12, 12, 0, Math.PI * 2);
    g.fillStyle = "#e5484d";
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = "#fff";
    g.stroke();
    if (faviconState) link.href = canvas.toDataURL("image/png");
  };
  if (iconImage?.complete) return draw();
  iconImage = new Image(64, 64);
  iconImage.addEventListener("load", draw, { once: true });
  iconImage.src = BRAND_ICON;
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
    setFavicon(el<HTMLLinkElement>("favicon"), faviconState);
  }
}

/** The tab title without the unread marks: the open conversation's. */
export function setTitleBase(text: string): void {
  titleBase = text;
  applyTitle();
}
