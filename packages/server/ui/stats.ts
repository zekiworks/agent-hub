// The Stats dialog: messages written and agent turns started, per participant and per day (GET /api/stats).
import type { ParticipantStats, StatsResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { dom } from "./dom";
import { errorText } from "./format";
import { h } from "./html";

type Column = keyof Omit<ParticipantStats, "id" | "kind">;

const COLUMNS: Array<{ key: Column; label: string; title: string }> = [
  { key: "written", label: "Written", title: "Messages it wrote" },
  { key: "turns", label: "Turns", title: "Agents: messages that woke it" },
  { key: "quiet", label: "Quiet", title: "Agents: messages taken in at its next turn" },
  { key: "caused", label: "Caused", title: "Turns its messages woke in agents" },
];

let stats: StatsResponse | undefined;
let sortBy: Column = "turns";

function render(): void {
  if (!stats) return;
  const head = h("tr");
  head.append(h("th", "", "Participant"));
  for (const column of COLUMNS) {
    const th = h("th", column.key === sortBy ? "num sorted" : "num", column.label);
    th.title = `${column.title} (click to sort)`;
    th.addEventListener("click", () => {
      sortBy = column.key;
      render();
    });
    head.append(th);
  }
  dom.statsHead.replaceChildren(head);
  const rows = [...stats.participants].sort((a, b) => b[sortBy] - a[sortBy] || a.id.localeCompare(b.id));
  const total = h("tr", "stats-total");
  total.append(h("td", "", "Total"));
  for (const column of COLUMNS) {
    total.append(h("td", "num", String(stats.participants.reduce((n, p) => n + p[column.key], 0))));
  }
  dom.statsBody.replaceChildren(
    ...rows.map((p) => {
      const tr = h("tr");
      tr.append(h("td", "", `${p.kind === "human" ? "" : "@"}${p.id}`));
      for (const column of COLUMNS) {
        const value = p[column.key];
        tr.append(h("td", value === 0 ? "num zero" : "num", String(value)));
      }
      return tr;
    }),
    total
  );
  const most = Math.max(1, ...stats.daily.map((d) => d.turns));
  dom.statsDaily.replaceChildren(
    ...stats.daily.map((d) => {
      const li = h("li");
      const bar = h("span", "stats-bar");
      bar.style.width = `${(100 * d.turns) / most}%`;
      const track = h("span", "stats-track");
      track.append(bar);
      li.append(h("span", "stats-day", d.day.slice(5)), track, h("span", "stats-day-text", `${d.messages} msgs · ${d.turns} turns`));
      return li;
    })
  );
}

async function load(): Promise<void> {
  try {
    stats = await api<StatsResponse>(`/api/stats?days=${dom.statsDays.value}`);
    render();
  } catch (err) {
    dom.statsBody.replaceChildren(h("tr", "", `Could not load the stats: ${errorText(err)}`));
  }
}

dom.statsBtn.addEventListener("click", () => {
  dom.statsDialog.showModal();
  void load();
});
dom.statsClose.addEventListener("click", () => dom.statsDialog.close());
dom.statsDays.addEventListener("change", () => void load());
