// The GPUs dialog: who holds each shared resource now and next, what runs on it, and booking, releasing and
// extending for the signed-in person (POST /api/reservations…, the same schedule the agents' tool uses).
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
          li.append(h("span", "gpu-mine-text", `${resource?.label ?? r.resourceId}: ${holdText(r, resource)}`));
          const actions = h("span", "gpu-actions");
          if (r.state !== "queued") actions.append(actionButton("+2 h", `Extend ${r.id} by 2 hours`, () => postJson(`/api/reservations/${r.id}/extend`, { from: state.me, hours: 2 })));
          actions.append(
            actionButton(r.state === "planned" || r.state === "queued" ? "Cancel" : "Release", `End ${r.id} now`, () =>
              postJson(`/api/reservations/${r.id}/release`, { from: state.me })
            )
          );
          li.append(actions);
          return li;
        })),
  );

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

dom.gpuBtn.addEventListener("click", () => {
  hideError();
  dom.gpuDialog.showModal();
  void load().catch((err) => showError(errorText(err)));
});
dom.gpuClose.addEventListener("click", () => dom.gpuDialog.close());
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
