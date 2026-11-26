// Crash and problem reports reach the Hub (Ümit #17132, #17141), which logs them and passes them to the agent named by
// `serve --bug-reports-to`. Script errors are caught by the small script at the top of index.html, so a page that dies
// while starting still reports. This module adds what that script cannot see:
// - a page that ended without closing: iOS kills a Home Screen app's page when it runs out of memory or hangs, and no
//   script runs then. The page keeps a heartbeat while open and marks a normal close (hidden or closed); the next start
//   finds an unmarked heartbeat and reports it, with the view that was open. Any age up to a day counts: a person who
//   force-quits a frozen app may reopen it minutes later (the first version's 60 s limit missed Ümit's, #17310);
// - a freeze the page recovers from: the heartbeat falls far behind while the page stays visible;
// - Tools → Report a problem, for anything a person notices.
import { postJson } from "./api";

const ALIVE_KEY = "agent-bus.page-alive";

type Kind = "crash" | "ended" | "freeze" | "report";

function report(kind: Kind, text: string, stack?: string): Promise<{ sent: boolean }> {
  return postJson<{ sent: boolean }>("/api/bug-reports", {
    kind,
    text,
    stack,
    where: location.hash,
    device: navigator.userAgent,
    standalone: matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true,
  });
}

/** Called once the app has drawn its first view: the start-up watchdog in index.html stops waiting. */
export function startCrashLog(): void {
  (window as { agentHubStarted?: boolean }).agentHubStarted = true;
  try {
    const last = JSON.parse(localStorage.getItem(ALIVE_KEY) ?? "null") as { at?: number; where?: string; closed?: boolean } | null;
    if (last && !last.closed && typeof last.at === "number" && Date.now() - last.at < 24 * 3600_000) {
      const ago = Math.round((Date.now() - last.at) / 60_000);
      void report("ended", `The page stopped while it was open, without closing, about ${ago} min before this start (a crash, a freeze ended by force-quitting, or a forced reload).`, `last view ${last.where ?? "?"}`).catch(() => undefined);
    }
  } catch {
    // A broken record is just replaced.
  }
  const beat = (closed: boolean): void => localStorage.setItem(ALIVE_KEY, JSON.stringify({ at: Date.now(), where: location.hash, closed }));
  beat(false);
  let lastBeat = Date.now();
  let freezes = 0;
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    const gap = Date.now() - lastBeat;
    // Hidden pages' timers pause, so only a gap between two visible beats is a freeze of the page itself.
    if (gap > 15_000 && freezes < 3) {
      freezes += 1;
      void report("freeze", `The page did not respond for about ${Math.round(gap / 1000)} s while it was open, then recovered.`).catch(() => undefined);
    }
    lastBeat = Date.now();
    beat(false);
  }, 5_000);
  document.addEventListener("visibilitychange", () => {
    lastBeat = Date.now();
  });
  // Hidden or closed normally: a later start must not count it as a crash.
  document.addEventListener("visibilitychange", () => beat(document.visibilityState === "hidden"));
  window.addEventListener("pagehide", () => beat(true));
}

/** Tools → Report a problem: what the person describes, with where they were and on which device. */
export async function reportProblem(): Promise<void> {
  const text = prompt("What went wrong? Say what you did and what you saw:");
  if (!text?.trim()) return;
  try {
    const result = await report("report", text.trim());
    alert(result.sent ? "Thanks: the report was sent to the agent that maintains this Hub." : "Thanks: the report is in the Hub's log.");
  } catch (error) {
    alert(`The report could not be sent: ${error instanceof Error ? error.message : String(error)}`);
  }
}
