// The conversation's width (Can #14526): its right edge is a divider like the Workspace's. The message column is 80
// characters by default (--column, styles.css); dragging the edge sets it to anything from MIN to the room the page
// has, so a wide table reads without opening the Workspace. Kept per browser; double-click or Home gives 80 back.
// With the Workspace open the conversation fills the room left of the Workspace's own divider instead (styles.css).
import { dom } from "./dom";

const KEY = "agent-bus.columnWidth";
const MIN = 480;
const STEP = 16;

/** The widest the conversation can be: its area, less the margins around the box. */
function maxWidth(): number {
  const area = dom.chat.parentElement?.getBoundingClientRect().width ?? innerWidth;
  return Math.max(MIN, Math.round(area - 40));
}

function setWidth(px: number): void {
  const width = Math.round(Math.min(Math.max(px, MIN), maxWidth()));
  dom.app.style.setProperty("--column", `${width}px`);
  dom.chatResize.setAttribute("aria-valuenow", String(width));
  dom.chatResize.setAttribute("aria-valuemin", String(MIN));
  dom.chatResize.setAttribute("aria-valuemax", String(maxWidth()));
}

function reset(): void {
  localStorage.removeItem(KEY);
  dom.app.style.removeProperty("--column");
  dom.chatResize.removeAttribute("aria-valuenow");
}

const saved = Number(localStorage.getItem(KEY));
if (saved > 0) setWidth(saved);

const save = () => localStorage.setItem(KEY, String(Math.round(dom.chat.getBoundingClientRect().width)));

// A second press within 400 ms gives the usual width back: the browser sends no dblclick after a pointerdown whose
// default was prevented (needed so a drag selects no text).
let lastDown = 0;
dom.chatResize.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const now = performance.now();
  const second = now - lastDown < 400;
  lastDown = second ? 0 : now;
  if (second) return reset();
  dom.chatResize.setPointerCapture(event.pointerId);
  dom.app.classList.add("ws-resizing");
  const left = dom.chat.getBoundingClientRect().left;
  let moved = false;
  const move = (e: PointerEvent) => {
    moved = true;
    setWidth(e.clientX - left);
  };
  const finish = () => {
    dom.chatResize.removeEventListener("pointermove", move);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) dom.chatResize.removeEventListener(type, finish);
    dom.app.classList.remove("ws-resizing");
    if (moved) save();
  };
  dom.chatResize.addEventListener("pointermove", move);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) dom.chatResize.addEventListener(type, finish);
});

dom.chatResize.addEventListener("keydown", (event) => {
  const now = Math.round(dom.chat.getBoundingClientRect().width);
  if (event.key === "ArrowRight") setWidth(now + STEP);
  else if (event.key === "ArrowLeft") setWidth(now - STEP);
  else if (event.key === "Home") return reset();
  else return;
  event.preventDefault();
  save();
});
