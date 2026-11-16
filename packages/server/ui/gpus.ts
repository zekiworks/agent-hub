// The GPU booking dialog: who holds each shared resource now and next, what runs on it, and booking, releasing,
// extending, shared/private and notices for the signed-in person (POST /api/reservations…, the same schedule the
// agents' tool uses). A Workspace page (gpudash's) can open it at a GPU or a hold (#10194); the person acts here.
import type { Reservation, ReservationResponse, ReservationState, Resource, ResourcesResponse } from "@agent-bus/protocol";
import { api, postJson } from "./api";
import { dom } from "./dom";
import { errorText } from "./format";
import { h } from "./html";
import { state } from "./state";

/** Reservations not over yet. */
const OPEN: Record<ReservationState, boolean> = {
  planned: true,
  queued: true,
  active: true,
  overdue: true,
  released: false,
  expired: false,
  reclaimed: false,
  cancelled: false,
};
let listing: ResourcesResponse | undefined;

const timeFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const when = (ms: number | undefined): string => (ms === undefined ? "?" : timeFormat.format(ms));

function holdText(r: Reservation, resource: Resource | undefined): string {
  const part = r.amount === undefined || !resource ? "" : ` (${Math.round(r.amount / 1024)} GB)`;
  const span =
    r.state === "queued"
      ? `queued, ${Math.round(r.durationMs / 3_600_000)} h once free`
      : r.state === "planned"
        ? `${when(r.start)} – ${when(r.end)}`
        : `until ${when(r.end)}${r.state === "overdue" ? " (overdue)" : ""}`;
  return `@${r.holder}${part}: ${span}${r.private ? " · private" : ""} — ${r.purpose}`;
}

function render(): void {
  if (!listing) return;
  const open = listing.reservations.filter((r) => OPEN[r.state]);
  const byResource = (id: string) => open.filter((r) => r.resourceId === id).sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  const resources = [...listing.resources].sort((a, b) => Number(a.kind !== "gpu") - Number(b.kind !== "gpu") || a.label.localeCompare(b.label));
  dom.gpuFleetSummary.textContent = `All GPUs (${resources.length})`;
  dom.gpuList.replaceChildren(
    ...resources.map((resource) => {
      const li = h("li", "gpu-row");
      const seen = listing?.observed[resource.id];
      const head = h("div", "gpu-row-head");
      head.append(h("span", "gpu-label", resource.label));
      if (resource.model) head.append(h("span", "gpu-model", resource.model));
      if (seen) head.append(h("span", "gpu-use", `${Math.round(seen.memoryUsed / 1024)} GB used · ${seen.utilization}% busy`));
      li.append(head);
      const holds = byResource(resource.id);
      if (holds.length === 0) li.append(h("div", "gpu-free", "free: nobody has booked it"));
      for (const r of holds) li.append(h("div", `gpu-hold gpu-${r.state}`, `${r.state === "active" || r.state === "overdue" ? "now" : "next"} ${holdText(r, resource)}`));
      for (const p of seen?.processes ?? []) {
        if (p.reservationId || p.agentId) continue;
        li.append(h("div", "gpu-unbooked", `runs without a booking: ${p.container ?? p.command.slice(0, 60)} (${Math.round(p.memory / 1024)} GB)`));
      }
      return li;
    })
  );

  const mine = open.filter((r) => r.holder === state.me);
  dom.gpuMine.replaceChildren(
    ...(mine.length === 0
      ? [h("li", "gpu-free", "none")]
      : mine.map((r) => {
          const resource = listing?.resources.find((x) => x.id === r.resourceId);
          const li = h("li", "gpu-row gpu-mine-row");
          li.dataset.reservation = r.id;
          li.append(h("span", "gpu-mine-text", `${resource?.label ?? r.resourceId}: ${holdText(r, resource)}`));
          const actions = h("span", "gpu-actions");
          if (r.state !== "queued") actions.append(actionButton("+2 h", `Extend ${r.id} by 2 hours`, () => postJson(`/api/reservations/${r.id}/extend`, { from: state.me, hours: 2 })));
          actions.append(
            actionButton(r.state === "planned" || r.state === "queued" ? "Cancel" : "Release", `End ${r.id} now`, () =>
              postJson(`/api/reservations/${r.id}/release`, { from: state.me })
            )
          );
          actions.append(
            actionButton(r.private ? "Make shared" : "Make private", r.private ? "Others may send requests to your servers on it" : "Only you use it", () =>
              postJson(`/api/reservations/${r.id}/mode`, { from: state.me, mode: r.private ? "shared" : "private" })
            )
          );
          li.append(actions);
          return li;
        })),
  );

  dom.gpuSubscribe.checked = listing.subscriptions.some((sub) => sub.subscriber === state.me);

  const picked = dom.gpuResource.value;
  dom.gpuResource.replaceChildren(
    ...resources.map((resource) => {
      const option = h("option", undefined, resource.label + (byResource(resource.id).some((r) => r.state === "active" || r.state === "overdue") ? " (taken now)" : ""));
      option.value = resource.id;
      return option;
    })
  );
  if (picked) dom.gpuResource.value = picked;
  dom.gpuHours.max = String(listing.rules.maxHoldMs / 3_600_000);
}

function actionButton(label: string, title: string, run: () => Promise<unknown>): HTMLButtonElement {
  const button = h("button", "btn gpu-action", label);
  button.type = "button";
  button.title = title;
  button.addEventListener("click", async () => {
    button.disabled = true;
    hideError();
    try {
      await run();
      await load();
    } catch (err) {
      showError(errorText(err));
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function showError(text: string): void {
  dom.gpuError.textContent = text;
  dom.gpuError.hidden = false;
}

function hideError(): void {
  dom.gpuError.hidden = true;
}

async function load(): Promise<void> {
  listing = await api<ResourcesResponse>("/api/resources");
  render();
}

/** The schedule changed (a viewer frame): refresh while the dialog is open. */
export function resourcesChanged(): void {
  if (dom.gpuDialog.open) void load().catch(() => undefined);
}

type GpuAction = "book" | "release" | "extend" | "mode" | "subscribe";
const ACTIONS: readonly GpuAction[] = ["book", "release", "extend", "mode", "subscribe"];

/** The section that leads when a page asked for an action (#10403). */
const SECTION: Record<GpuAction, string> = {
  book: "gpu-sec-book",
  release: "gpu-sec-mine",
  extend: "gpu-sec-mine",
  mode: "gpu-sec-mine",
  subscribe: "gpu-sec-subscribe",
};
/** The usual order, opened from Tools. */
const SECTIONS = ["gpu-sec-fleet", "gpu-sec-mine", "gpu-sec-subscribe", "gpu-sec-book"];

/**
 * Opens the dialog: for one asked action, led by it (its section first, the fleet folded last); opened from Tools,
 * the whole overview in the usual order. The sections move in the page itself, so Tab follows what is seen.
 */
function openDialog(action?: GpuAction): Promise<void> {
  hideError();
  const order = action ? [SECTION[action], ...SECTIONS.filter((id) => id !== SECTION[action] && id !== "gpu-sec-fleet"), "gpu-sec-fleet"] : SECTIONS;
  for (const id of order) {
    const section = document.getElementById(id);
    if (section) dom.gpuDialog.append(section);
  }
  dom.gpuFleet.open = !action;
  dom.gpuFocus.hidden = true;
  if (!dom.gpuDialog.open) dom.gpuDialog.showModal();
  return load().catch((err) => showError(errorText(err)));
}

dom.gpuBtn.addEventListener("click", () => {
  askingFrame = undefined;
  void openDialog();
});
dom.gpuClose.addEventListener("click", () => dom.gpuDialog.close());

/** Draws the eye to `target` and puts the keyboard on `control` (#10402): the person presses it, nothing else does. */
function point(target: Element | null | undefined, control: HTMLElement | null | undefined = target as HTMLElement): void {
  for (const old of dom.gpuDialog.querySelectorAll(".gpu-pointed")) old.classList.remove("gpu-pointed");
  if (!(target instanceof HTMLElement)) return;
  target.classList.add("gpu-pointed");
  target.scrollIntoView({ block: "nearest" });
  control?.focus();
}

function lead(text: string): void {
  dom.gpuFocus.textContent = text;
  dom.gpuFocus.hidden = false;
}

/**
 * A page in the Workspace asked for `action` (#10194): the dialog opens led by it (#10403), a line naming it and its
 * GPU, then that GPU's form (book), that hold of yours with its buttons (release, extend, mode) or the notices switch
 * (subscribe). Nothing happens until the person clicks; a GPU or hold that is not there (any more), or not yours, says so.
 */
async function openAt(action: GpuAction, resource: string | undefined, reservation: string | undefined): Promise<void> {
  await openDialog(action);
  if (!listing) return;
  if (action === "subscribe") {
    lead("Get a notice when a GPU is free");
    return point(dom.gpuSubscribe.closest("label"), dom.gpuSubscribe);
  }
  if (action === "book") {
    const wanted = listing.resources.find((r) => r.id === resource || r.label === resource);
    if (resource && !wanted) return showError(`That GPU ("${resource}") is no longer there.`);
    if (wanted) dom.gpuResource.value = wanted.id;
    lead(`Book ${wanted?.label ?? "a GPU"}`);
    return point(dom.gpuPurpose);
  }
  const hold = listing.reservations.find((r) => r.id === reservation);
  const row = reservation ? dom.gpuMine.querySelector(`[data-reservation="${CSS.escape(reservation)}"]`) : null;
  if (!hold || !row) return showError("That hold is no longer there, or it is not yours.");
  const where = listing.resources.find((r) => r.id === hold.resourceId)?.label ?? hold.resourceId;
  const verb = action === "extend" ? "Extend by 2 h" : action === "mode" ? (hold.private ? "Make shared" : "Make private") : "Release";
  lead(`${verb}: your hold on ${where}`);
  const label = action === "extend" ? "+2 h" : action === "mode" ? "Make" : undefined;
  const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
  const button = label ? buttons.find((b) => b.textContent?.startsWith(label)) : buttons.find((b) => /^(Release|Cancel)$/.test(b.textContent ?? ""));
  point(button);
}

/** The page that asked, so the keyboard goes back to it when the dialog closes (#10402). */
let askingFrame: HTMLIFrameElement | undefined;

// Only a frame the website made for a Workspace page may ask, and only to open the dialog (agentpages.ts).
window.addEventListener("message", (event) => {
  const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe.agent-page")];
  const frame = frames.find((f) => f.contentWindow === event.source);
  if (!frame) return;
  const data = event.data as { type?: unknown; action?: unknown; resource?: unknown; reservation?: unknown } | null;
  if (data?.type !== "agent-bus:gpu" || !ACTIONS.includes(data.action as GpuAction)) return;
  const text = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : undefined);
  askingFrame = frame;
  void openAt(data.action as GpuAction, text(data.resource), text(data.reservation));
});

// When the dialog closes, the pages refresh what they show of the schedule at once; the one that asked gets the
// keyboard back (inside it, its own button keeps its focus).
dom.gpuDialog.addEventListener("close", () => {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe.agent-page")) {
    frame.contentWindow?.postMessage({ type: "agent-bus:resources-changed" }, "*");
  }
  if (askingFrame?.isConnected) askingFrame.focus();
  askingFrame = undefined;
});
dom.gpuSubscribe.addEventListener("change", async () => {
  hideError();
  dom.gpuSubscribe.disabled = true;
  try {
    await postJson(dom.gpuSubscribe.checked ? "/api/subscriptions" : "/api/subscriptions/remove", { from: state.me });
    await load();
  } catch (err) {
    showError(errorText(err));
    dom.gpuSubscribe.checked = !dom.gpuSubscribe.checked;
  } finally {
    dom.gpuSubscribe.disabled = false;
  }
});

dom.gpuStart.addEventListener("change", () => {
  dom.gpuAtLabel.hidden = dom.gpuStart.value !== "at";
  dom.gpuAt.required = dom.gpuStart.value === "at";
});

dom.gpuForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError();
  const start = dom.gpuStart.value === "next" ? "next" : dom.gpuStart.value === "at" ? new Date(dom.gpuAt.value).getTime() : undefined;
  if (typeof start === "number" && !Number.isFinite(start)) return showError("Pick when it should start.");
  dom.gpuBook.disabled = true;
  try {
    await postJson<ReservationResponse>("/api/reservations", {
      from: state.me,
      resource: dom.gpuResource.value,
      hours: Number(dom.gpuHours.value),
      purpose: dom.gpuPurpose.value,
      ...(start !== undefined ? { start } : {}),
      ...(dom.gpuPrivate.checked ? { private: true } : {}),
    });
    dom.gpuPurpose.value = "";
    await load();
  } catch (err) {
    showError(errorText(err));
  } finally {
    dom.gpuBook.disabled = false;
  }
});
