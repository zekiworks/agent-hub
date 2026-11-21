// Browser notifications for the ●● messages (mentions of me, conversations of two), and the tab title and icon that
// show how many are unread.
import type { Conversation, Message } from "@agent-bus/protocol";
import { BRAND, BRAND_ICON } from "./brand";
import { dom } from "./dom";
import { el } from "./html";
import { navigate } from "./routing";
import { conversationTitle, isCurrent, state } from "./state";
import { pushOnHere, pushState, turnPushOn } from "./push";

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
    btn.title =
      "Get a notification for DMs, messages that name you and replies to you, also while Agent Hub is closed (Settings → Notifications on this device)";
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
  // Allowed before notifications while closed existed (Ümit #13975, #13976): one click still turns those on here.
  if (s === "granted") {
    void pushState().then((state) => {
      btn.hidden = state !== "off";
      btn.textContent = "🔔 Notifications when closed";
      btn.title = "Also get them while Agent Hub is closed: DMs, messages that name you, replies to you";
    });
  }
}

dom.notifyBtn.addEventListener("click", () => {
  // One click: the permission (asked at once, inside the click: Safari allows it only then) and, where the browser can,
  // the bus's notifications while Agent Hub is closed (push.ts).
  const s = notifyState();
  if (s === "default" || s === "granted") void turnPushOn().then(renderNotifyButton, renderNotifyButton);
  else alert(dom.notifyBtn.title);
});

export function notify(message: Message, conv: Conversation): void {
  if (notifyState() !== "granted" || (isCurrent(conv.id) && document.hasFocus())) return;
  // This device gets the bus's notifications (push.ts): the same message must not show twice.
  if (pushOnHere()) return;
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

/**
 * The tab icon (Agent Hub's logo, or `--brand-icon`), with a red dot while messages are unread. Safari shows the icon
 * the page came with and drops any it is given later: with messages unread (always, for a busy person) its tab showed
 * a letter instead of the logo (Ümit #13435, #13459). So Safari keeps the page's own icon; the title's "(62)" says
 * what is unread. Other browsers get the dot: Agent Hub's own icon with it is a file (logo-64-unread.png), a brand's
 * icon gets it drawn here.
 */
let iconImage: HTMLImageElement | undefined;
const OWN_ICON = "/logo-64.png?v=2";
const OWN_UNREAD_ICON = "/logo-64-unread.png?v=1";
const SAFARI = /^((?!chrome|chromium|crios|android|edg|firefox|fxios).)*safari/i.test(navigator.userAgent);
function setFavicon(link: HTMLLinkElement, attention: boolean): void {
  if (SAFARI) return;
  const put = (href: string) => {
    link.href = href;
  };
  if (!attention) return put(BRAND_ICON);
  if (BRAND_ICON === OWN_ICON) return put(OWN_UNREAD_ICON);
  const draw = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const g = canvas.getContext("2d");
    if (!g || !iconImage) return;
    g.drawImage(iconImage, 0, 0, 64, 64);
    // In the corner below the right leaf, as in logo-64-unread.png (at the top right it covered a leaf, #13425).
    g.beginPath();
    g.arc(53, 53, 10, 0, Math.PI * 2);
    g.fillStyle = "#e5484d";
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = "#fff";
    g.stroke();
    if (faviconState) put(canvas.toDataURL("image/png"));
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
