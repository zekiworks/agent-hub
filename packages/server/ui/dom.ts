// The conversations page's elements (index.html), looked up once at load, and the message list's scrolling.
import { el } from "./html";

export const dom = {
  linkStatus: el<HTMLSpanElement>("link-status"),
  newGroupBtn: el<HTMLButtonElement>("new-group-btn"),
  unreadBtn: el<HTMLButtonElement>("unread-btn"),
  offlineBtn: el<HTMLButtonElement>("offline-btn"),
  conversationList: el<HTMLUListElement>("conversation-list"),
  groupList: el<HTMLUListElement>("group-list"),
  roomList: el<HTMLUListElement>("room-list"),
  otherRoomsBtn: el<HTMLButtonElement>("other-rooms-btn"),
  otherRoomsList: el<HTMLUListElement>("other-rooms-list"),
  groupFolds: el<HTMLDivElement>("group-folds"),
  newProjectBtn: el<HTMLButtonElement>("new-project-btn"),
  browseBtn: el<HTMLButtonElement>("browse-btn"),
  browseList: el<HTMLUListElement>("browse-list"),
  mentionSection: el<HTMLElement>("mention-section"),
  mentionList: el<HTMLUListElement>("mention-list"),
  mentionCount: el<HTMLSpanElement>("mention-count"),
  agentList: el<HTMLUListElement>("agent-list"),
  agentsToggle: el<HTMLButtonElement>("agents-toggle"),
  projectsSection: el<HTMLElement>("projects-section"),
  projectsToggle: el<HTMLButtonElement>("projects-toggle"),
  groupsSection: el<HTMLElement>("groups-section"),
  groupsToggle: el<HTMLButtonElement>("groups-toggle"),
  agentCount: el<HTMLSpanElement>("agent-count"),
  main: el<HTMLElement>("main"),
  convTitle: el<HTMLSpanElement>("conv-title"),
  convSubtitle: el<HTMLDivElement>("conv-subtitle"),
  convParent: el<HTMLSpanElement>("conv-parent"),
  subgroupsPanel: el<HTMLDetailsElement>("subgroups-panel"),
  subgroupsSummary: el<HTMLElement>("subgroups-summary"),
  subgroupsList: el<HTMLUListElement>("subgroups-list"),
  messageScroll: el<HTMLDivElement>("message-scroll"),
  jumpBtn: el<HTMLButtonElement>("jump-btn"),
  loadEarlier: el<HTMLDivElement>("load-earlier"),
  loadEarlierBtn: el<HTMLButtonElement>("load-earlier-btn"),
  messageList: el<HTMLOListElement>("message-list"),
  messageEmpty: el<HTMLDivElement>("message-empty"),
  workingLine: el<HTMLDivElement>("working-line"),
  composer: el<HTMLFormElement>("composer"),
  composerError: el<HTMLDivElement>("composer-error"),
  stagedFiles: el<HTMLUListElement>("staged-files"),
  attachBtn: el<HTMLButtonElement>("attach-btn"),
  backBtn: el<HTMLButtonElement>("back-btn"),
  backBadge: el<HTMLSpanElement>("back-badge"),
  detailsBtn: el<HTMLButtonElement>("details-btn"),
  fileInput: el<HTMLInputElement>("file-input"),
  mentionMenu: el<HTMLUListElement>("mention-menu"),
  input: el<HTMLTextAreaElement>("composer-input"),
  composerGrip: el<HTMLDivElement>("composer-grip"),
  composerSize: el<HTMLButtonElement>("composer-size"),
  sendBtn: el<HTMLButtonElement>("send-btn"),
  dropOverlay: el<HTMLDivElement>("drop-overlay"),
  profileDialog: el<HTMLDialogElement>("profile-dialog"),
  profileChoices: el<HTMLDivElement>("profile-choices"),
  groupDialog: el<HTMLDialogElement>("group-dialog"),
  groupForm: el<HTMLFormElement>("group-form"),
  groupChoices: el<HTMLUListElement>("group-choices"),
  groupError: el<HTMLDivElement>("group-error"),
  groupCancel: el<HTMLButtonElement>("group-cancel"),
  groupHeading: el<HTMLHeadingElement>("group-heading"),
  groupOpen: el<HTMLButtonElement>("group-open"),
  newRoomBtn: el<HTMLButtonElement>("new-room-btn"),
  roomFields: el<HTMLDivElement>("room-fields"),
  roomName: el<HTMLInputElement>("room-name"),
  roomAddress: el<HTMLParagraphElement>("room-address"),
  roomParent: el<HTMLSelectElement>("room-parent"),
  roomFirst: el<HTMLTextAreaElement>("room-first"),
  notifyBtn: el<HTMLButtonElement>("notify-btn"),
  authLink: el<HTMLAnchorElement>("auth-link"),
  convFilter: el<HTMLDivElement>("conv-filter"),
  lightbox: el<HTMLDialogElement>("lightbox"),
  lightboxImg: el<HTMLImageElement>("lightbox-img"),
  lightboxName: el<HTMLSpanElement>("lightbox-name"),
  lightboxDownload: el<HTMLAnchorElement>("lightbox-download"),
  lightboxHint: el<HTMLSpanElement>("lightbox-hint"),
  lightboxPrev: el<HTMLButtonElement>("lightbox-prev"),
  lightboxNext: el<HTMLButtonElement>("lightbox-next"),
  app: el<HTMLDivElement>("app"),
  pane: el<HTMLElement>("pane"),
  paneTabs: el<HTMLDivElement>("pane-tabs"),
  paneSource: el<HTMLButtonElement>("pane-source"),
  paneClose: el<HTMLButtonElement>("pane-close"),
  paneBody: el<HTMLDivElement>("pane-body"),
  paneBtn: el<HTMLButtonElement>("pane-btn"),
  checklistBtn: el<HTMLButtonElement>("checklist-btn"),
  checklistCount: el<HTMLSpanElement>("checklist-count"),
  wsBack: el<HTMLButtonElement>("ws-back"),
  wsForward: el<HTMLButtonElement>("ws-forward"),
  wsResize: el<HTMLDivElement>("ws-resize"),
  wsReset: el<HTMLButtonElement>("ws-reset"),
  replyBar: el<HTMLDivElement>("reply-bar"),
  replyBarText: el<HTMLSpanElement>("reply-bar-text"),
  replyCancel: el<HTMLButtonElement>("reply-cancel"),
  nobodyBar: el<HTMLDivElement>("nobody-bar"),
  holdBar: el<HTMLDivElement>("hold-bar"),
  holdBarText: el<HTMLSpanElement>("hold-bar-text"),
  holdSelect: el<HTMLSelectElement>("hold-select"),
  voiceBtn: el<HTMLButtonElement>("voice-btn"),
  voiceBar: el<HTMLDivElement>("voice-bar"),
  voiceRec: el<HTMLDivElement>("voice-rec"),
  voiceDelete: el<HTMLButtonElement>("voice-delete"),
  voiceTime: el<HTMLSpanElement>("voice-time"),
  voiceWave: el<HTMLCanvasElement>("voice-wave"),
  voiceHint: el<HTMLSpanElement>("voice-hint"),
  voicePause: el<HTMLButtonElement>("voice-pause"),
  inputWrap: el<HTMLDivElement>("composer-input-wrap"),
  settingsBtn: el<HTMLButtonElement>("settings-btn"),
  settingsDialog: el<HTMLDialogElement>("settings-dialog"),
  convMenuBtn: el<HTMLButtonElement>("conv-menu-btn"),
  convDialog: el<HTMLDialogElement>("conv-dialog"),
  statsBtn: el<HTMLButtonElement>("stats-btn"),
  statsDialog: el<HTMLDialogElement>("stats-dialog"),
  statsDays: el<HTMLSelectElement>("stats-days"),
  statsClose: el<HTMLButtonElement>("stats-close"),
  statsHead: el<HTMLTableSectionElement>("stats-head"),
  statsBody: el<HTMLTableSectionElement>("stats-body"),
  statsDaily: el<HTMLUListElement>("stats-daily"),
  gpuBtn: el<HTMLButtonElement>("gpu-btn"),
  inboxBtn: el<HTMLButtonElement>("inbox-btn"),
  bookmarksBtn: el<HTMLButtonElement>("bookmarks-btn"),
  inboxRow: el<HTMLButtonElement>("inbox-row"),
  inboxRowCount: el<HTMLSpanElement>("inbox-row-count"),
  inboxReturn: el<HTMLButtonElement>("inbox-return"),
  bookmarksRow: el<HTMLButtonElement>("bookmarks-row"),
  bookmarksRowCount: el<HTMLSpanElement>("bookmarks-row-count"),
  bookmarksReturn: el<HTMLButtonElement>("bookmarks-return"),
  searchRow: el<HTMLButtonElement>("search-row"),
  searchReturn: el<HTMLButtonElement>("search-return"),
  tabRow: el<HTMLElement>("tab-row"),
  toolsBtn: el<HTMLButtonElement>("tools-btn"),
  toolsMenu: el<HTMLDivElement>("tools-menu"),
  launchers: el<HTMLSpanElement>("launchers"),
  gotoBtn: el<HTMLButtonElement>("goto-btn"),
  taskSelect: el<HTMLSelectElement>("task-select"),
  gpuDialog: el<HTMLDialogElement>("gpu-dialog"),
  gpuClose: el<HTMLButtonElement>("gpu-close"),
  gpuFocus: el<HTMLParagraphElement>("gpu-focus"),
  gpuFleet: el<HTMLDetailsElement>("gpu-fleet"),
  gpuFleetSummary: el<HTMLElement>("gpu-fleet-summary"),
  gpuList: el<HTMLUListElement>("gpu-list"),
  gpuMine: el<HTMLUListElement>("gpu-mine"),
  gpuSubscribe: el<HTMLInputElement>("gpu-subscribe"),
  gpuForm: el<HTMLFormElement>("gpu-form"),
  gpuResource: el<HTMLSelectElement>("gpu-resource"),
  gpuStart: el<HTMLSelectElement>("gpu-start"),
  gpuAtLabel: el<HTMLLabelElement>("gpu-at-label"),
  gpuAt: el<HTMLInputElement>("gpu-at"),
  gpuHours: el<HTMLInputElement>("gpu-hours"),
  gpuPurpose: el<HTMLInputElement>("gpu-purpose"),
  gpuPrivate: el<HTMLInputElement>("gpu-private"),
  gpuError: el<HTMLDivElement>("gpu-error"),
  gpuBook: el<HTMLButtonElement>("gpu-book"),
};

/** The phone layout of styles.css (one screen at a time: the conversation list or a conversation). */
export const PHONE = window.matchMedia("(max-width: 640px)");

/**
 * A message I was just taken to (a link, a banner, search): for a few seconds the view keeps it in the middle instead
 * of following the bottom. Pictures loading under it, and the first load of the conversation, pulled the view back
 * down (Ümit #11931: a #/m/ link landed at the bottom). My own scrolling ends the hold.
 */
let held: { seq: number; until: number } | undefined;

/** Scrolls message `el` into the middle of the view, or to its top when it is taller than the view (so it starts on screen). */
export function showInView(el: HTMLElement, behavior: ScrollBehavior = "auto"): void {
  el.scrollIntoView({ block: el.offsetHeight > dom.messageScroll.clientHeight - 16 ? "start" : "center", behavior });
}

export function holdInView(seq: number): void {
  held = { seq, until: performance.now() + 3000 };
}

/** Whether a message is being held in view (scrollToBottom then centres it instead). */
export function holdingView(): boolean {
  return heldMessage() !== undefined;
}

function heldMessage(): HTMLElement | undefined {
  if (held && performance.now() < held.until) {
    const el = dom.messageList.querySelector<HTMLElement>(`.msg[data-seq="${held.seq}"]`);
    if (el) return el;
  }
  held = undefined;
  return undefined;
}

for (const kind of ["wheel", "touchstart", "keydown"] as const) dom.messageScroll.addEventListener(kind, () => (held = undefined), { passive: true });

export function nearBottom(): boolean {
  if (heldMessage()) return false;
  const s = dom.messageScroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

export function scrollToBottom(): void {
  const el = heldMessage();
  if (el) showInView(el);
  else dom.messageScroll.scrollTop = dom.messageScroll.scrollHeight;
}
