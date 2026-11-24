// Re-labels and re-orders thread-tree rows by real activity without touching its React tree:
// labels go into a data attribute (shown by CSS), order goes into the flex `order` property.

export interface RowActivity {
  at: number;
  working: boolean;
}

export type Lang = "en" | "ru";

/** A thread's or a folder's status as the badges show it. */
export type BadgeState = "working" | "error" | "waiting" | "done";

/** A project folder's rollup over every thread in it, children and folded ones included. */
export interface FolderState {
  working: boolean;
  error: boolean;
  waiting: boolean;
  done: boolean;
}

export interface SyncOptions {
  /** Rollup by folder key (`project:<id>`). */
  folderOf?: (key: string) => FolderState | null;
  /** Folder key of the open thread's project. */
  activeFolder?: string | null;
  lang: Lang;
  /** Root threads per project card before the "more" bar; 0 shows all. */
  pageSize: number;
  /** Relabel ages and reorder rows by activity. */
  sort: boolean;
}

const STRINGS = {
  en: { now: "now", under: "<1m", m: "m", h: "h", d: "d", more: (n: number) => `Show ${n} more`, less: "Show less" },
  ru: { now: "сейчас", under: "<1м", m: "м", h: "ч", d: "д", more: (n: number) => `Ещё ${n}`, less: "Свернуть" },
} as const;

interface TreeNode {
  row: HTMLElement;
  level: number;
  key: number;
  index: number;
  extras: HTMLElement[];
  children: TreeNode[];
  parent: TreeNode | null;
}

const AGE_ATTR = "data-sp-age";
const HIDDEN_ATTR = "data-sp-hidden";
const MORE_ATTR = "data-sp-more";
const PAGING_KEY = "folio-bb:paging";
const GUIDES_ATTR = "data-sp-guides";
const GUIDE_VARS = ["--sp-guide-img", "--sp-guide-size", "--sp-guide-pos"] as const;
const GLYPH_CENTER_PX = 8;
const LINE = "linear-gradient(var(--sp-guide-color), var(--sp-guide-color))";

export function formatAgo(ms: number, lang: Lang = "en"): string {
  const t = STRINGS[lang];
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t.under;
  if (minutes < 60) return `${minutes}${t.m}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${t.h}`;
  return `${Math.floor(hours / 24)}${t.d}`;
}

let options: SyncOptions = { lang: "en", pageSize: 5, sort: true };
const pageSize = () => (options.pageSize > 0 ? options.pageSize : Infinity);

// Roots shown per project folder, by the section's group key; lives for the window session.
const limits = new Map<string, number>(readLimits());
let requestSync: () => void = () => {};

function readLimits(): [string, number][] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(PAGING_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number") : [];
  } catch {
    return [];
  }
}

function setLimit(key: string, limit: number): void {
  if (limit <= pageSize()) limits.delete(key);
  else limits.set(key, limit);
  try {
    sessionStorage.setItem(PAGING_KEY, JSON.stringify([...limits]));
  } catch {
    // Storage may be unavailable; paging still works for this page.
  }
  requestSync();
}

/** Glyphs Thread Tree draws for a thread that is doing work right now. */
const WORKING_GLYPHS = new Set(["runtime", "working-draft", "workflow", "background-agent", "background-command"]);
const ERROR_GLYPHS = new Set(["unread-error", "queued-failed"]);
const WAITING_GLYPHS = new Set(["waiting-for-input", "queued-waiting"]);
const STATE_ATTR = "data-sp-state";
const FOLDER_ATTR = "data-sp-folder";
const FOLDER_ERROR_ATTR = "data-sp-folder-error";
const ACTIVE_ATTR = "data-sp-active";

/** The badge for a row, from the glyph Thread Tree draws (a folded parent's glyph covers its subtree). */
function rowBadge(row: HTMLElement): BadgeState | null {
  const glyph = row.querySelector("[data-status-glyph]")?.getAttribute("data-status-glyph");
  if (glyph == null) return null;
  if (WORKING_GLYPHS.has(glyph) || glyph === "plan-mode") return "working";
  if (ERROR_GLYPHS.has(glyph)) return "error";
  if (WAITING_GLYPHS.has(glyph)) return "waiting";
  if (glyph === "unread-success") return "done";
  return null;
}

/** Working shows as a spinner; otherwise error > waiting for you > finished. */
export function folderBadge(state: FolderState | null): BadgeState | null {
  if (state === null) return null;
  if (state.working) return "working";
  if (state.error) return "error";
  if (state.waiting) return "waiting";
  if (state.done) return "done";
  return null;
}

function syncFolders(root: ParentNode, opts: SyncOptions): void {
  for (const section of root.querySelectorAll<HTMLElement>('section[data-flip-key^="project:"]')) {
    const key = section.getAttribute("data-flip-key")!;
    const state = opts.folderOf?.(key) ?? null;
    setAttr(section, FOLDER_ATTR, folderBadge(state));
    setAttr(section, FOLDER_ERROR_ATTR, state?.working && state.error ? "" : null);
    setAttr(section, ACTIVE_ATTR, opts.activeFolder === key ? "" : null);
  }
}

/**
 * What the row itself shows wins over thread data: "now" and the top place only
 * while the row draws a working glyph. A folded parent's glyph speaks for its
 * subtree, so it falls back to the thread's own data.
 */
function withRowGlyph(row: HTMLElement, activity: RowActivity | null): RowActivity | null {
  if (activity === null || row.hasAttribute("data-rollup")) return activity;
  const glyph = row.querySelector("[data-status-glyph]")?.getAttribute("data-status-glyph");
  return glyph == null ? activity : { ...activity, working: WORKING_GLYPHS.has(glyph) };
}

/** Lists the plugin reorders: project folders and Recent Activity. Pinned, Orchestrations and search keep Thread Tree's order. */
function sortedList(parent: HTMLElement): boolean {
  if (parent.closest('section[aria-label="Recent activity"]')) return true;
  return Boolean(parent.closest('[role="tree"]')) && !parent.closest('[aria-label="Pinned threads"]');
}

export function syncSidebar(root: ParentNode, activityOf: (threadId: string) => RowActivity | null, now: number, opts: SyncOptions, onChange: () => void = () => {}): void {
  requestSync = onChange;
  options = opts;
  const t = STRINGS[opts.lang];
  const containers = new Set<HTMLElement>();
  const byRow = new Map<string, RowActivity | null>();
  const rowActivity = (id: string) => (byRow.has(id) ? byRow.get(id)! : activityOf(id));
  for (const row of root.querySelectorAll<HTMLElement>("[data-thread-row][data-thread-id]")) {
    const activity = withRowGlyph(row, activityOf(row.dataset.threadId!));
    byRow.set(row.dataset.threadId!, activity);
    setAttr(row, STATE_ATTR, rowBadge(row));
    const age = row.querySelector<HTMLElement>("[data-row-age]");
    if (age) setAttr(age, AGE_ATTR, activity && opts.sort ? (activity.working ? t.now : formatAgo(now - activity.at, opts.lang)) : null);
    const parent = row.parentElement;
    if (parent && sortedList(parent)) containers.add(parent);
  }
  for (const container of containers) syncContainer(container, rowActivity, now);
  syncFolders(root, opts);
  // A folder whose rows all moved away (archived, or into "Older threads") keeps no bar.
  for (const bar of root.querySelectorAll<HTMLElement>(`[${MORE_ATTR}]`)) {
    if (!containers.has(bar.parentElement!)) bar.remove();
  }
}

function syncContainer(container: HTMLElement, activityOf: (threadId: string) => RowActivity | null, now: number): void {
  const style = getComputedStyle(container);
  if (!style.display.includes("flex") || !style.flexDirection.startsWith("column")) return clearContainer(container);

  const head: HTMLElement[] = [];
  const tail: HTMLElement[] = [];
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  let last: TreeNode | null = null;
  const children = [...container.children] as HTMLElement[];
  for (const [index, el] of children.entries()) {
    if (el.hasAttribute(MORE_ATTR)) continue;
    if (el.matches("[data-thread-row][data-thread-id]")) {
      // Anything but a fold line between rows means a layout we don't understand.
      if (tail.length > 0) return clearContainer(container);
      const level = Number(el.getAttribute("aria-level")) || 1;
      const activity = activityOf(el.dataset.threadId!);
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      const parent = stack[stack.length - 1] ?? null;
      const node: TreeNode = { row: el, level, key: !options.sort ? -index : activity ? (activity.working ? now : activity.at) : 0, index, extras: [], children: [], parent };
      (parent ? parent.children : roots).push(node);
      stack.push(node);
      last = node;
    } else if (last && tail.length === 0 && el.matches("[data-fold-line]")) {
      last.extras.push(el);
    } else if (last) {
      tail.push(el);
    } else {
      head.push(el);
    }
  }

  let childOrderChanged = false;
  const sortSiblings = (nodes: TreeNode[], isChildLevel: boolean) => {
    const before = nodes.map((node) => node.index).join();
    nodes.sort((a, b) => b.key - a.key || a.index - b.index);
    if (isChildLevel && nodes.map((node) => node.index).join() !== before) childOrderChanged = true;
    for (const node of nodes) sortSiblings(node.children, true);
  };
  sortSiblings(roots, false);

  let order = 0;
  for (const el of head) setOrder(el, order++);
  const all: TreeNode[] = [];
  const place = (node: TreeNode) => {
    all.push(node);
    setOrder(node.row, order++);
    for (const extra of node.extras) setOrder(extra, order++);
    for (const child of node.children) place(child);
  };
  for (const node of roots) place(node);
  const barOrder = order++;
  for (const el of tail) setOrder(el, order++);

  const pagingKey = pagingKeyOf(container);
  let hidden = 0;
  // A folder opened under a smaller page size never shows fewer rows than the current one.
  const limit = pagingKey === null ? Infinity : Math.max(limits.get(pagingKey) ?? 0, pageSize());
  for (const [rank, node] of roots.entries()) {
    const hide = rank >= limit && !mustShow(node, activityOf);
    if (hide) hidden++;
    markHidden(node, hide);
  }
  syncBar(container, pagingKey, hidden, limit, barOrder);

  for (const node of all) {
    const redraw = childOrderChanged && node.row.getAttribute("role") === "treeitem";
    if (redraw && node.parent) drawGuides(node.row, node, true);
    else clearGuides(node.row);
    // A fold line hangs under its row as that row's last child.
    for (const extra of node.extras) {
      if (redraw) drawGuides(extra, node, false);
      else clearGuides(extra);
    }
  }
}

/** A project folder's own rows group; the "Older threads" fold and other lists are not paged. */
function pagingKeyOf(container: HTMLElement): string | null {
  if (container.getAttribute("role") !== "group" || container.hasAttribute("aria-label")) return null;
  const section = container.parentElement?.parentElement;
  return section?.tagName === "SECTION" ? section.getAttribute("data-flip-key") : null;
}

/** The open thread and running work never hide behind the "more" bar. */
function mustShow(node: TreeNode, activityOf: (threadId: string) => RowActivity | null): boolean {
  if (node.row.getAttribute("aria-selected") === "true" || node.row.querySelector('[aria-current="page"]')) return true;
  if (activityOf(node.row.dataset.threadId!)?.working) return true;
  return node.children.some((child) => mustShow(child, activityOf));
}

function markHidden(node: TreeNode, hidden: boolean): void {
  for (const el of [node.row, ...node.extras]) {
    if (hidden) setAttr(el, HIDDEN_ATTR, "");
    else el.removeAttribute(HIDDEN_ATTR);
  }
  for (const child of node.children) markHidden(child, hidden);
}

function syncBar(container: HTMLElement, key: string | null, hidden: number, limit: number, order: number): void {
  let bar = container.querySelector<HTMLElement>(`:scope > [${MORE_ATTR}]`);
  const canCollapse = key !== null && limit > pageSize();
  if (key === null || (hidden === 0 && !canCollapse)) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.setAttribute(MORE_ATTR, "");
    bar.setAttribute("role", "none");
    const more = document.createElement("button");
    more.type = "button";
    more.dataset.spAction = "more";
    const less = document.createElement("button");
    less.type = "button";
    less.dataset.spAction = "less";
    bar.append(more, less);
    for (const type of ["pointerdown", "mousedown"]) bar.addEventListener(type, (event) => event.stopPropagation());
    // The section is draggable; pressing the bar must not start a project reorder.
    bar.draggable = true;
    bar.addEventListener("dragstart", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    bar.addEventListener("click", (event) => {
      event.stopPropagation();
      const action = (event.target as Element).closest<HTMLElement>("[data-sp-action]")?.dataset.spAction;
      const current = Number(bar!.dataset.spLimit) || pageSize();
      const groupKey = bar!.dataset.spKey;
      if (!groupKey) return;
      if (action === "more") setLimit(groupKey, current + pageSize());
      if (action === "less") setLimit(groupKey, pageSize());
      // Keep keyboard focus when the pressed button hides itself.
      const pressed = (event.target as Element).closest<HTMLElement>("button");
      if (pressed?.hidden) {
        const visible = bar!.querySelector<HTMLElement>("button:not([hidden])");
        const rows = container.querySelectorAll<HTMLElement>(`:scope > [data-thread-row]:not([${HIDDEN_ATTR}]) a`);
        (visible ?? rows[rows.length - 1])?.focus();
      }
    });
    container.append(bar);
  }
  bar.dataset.spKey = key;
  bar.dataset.spLimit = String(limit);
  setOrder(bar, order);
  const more = bar.querySelector<HTMLElement>('[data-sp-action="more"]')!;
  const t = STRINGS[options.lang];
  const label = t.more(hidden);
  if (more.textContent !== label) more.textContent = label;
  more.hidden = hidden === 0;
  const less = bar.querySelector<HTMLElement>('[data-sp-action="less"]')!;
  if (less.textContent !== t.less) less.textContent = t.less;
  less.hidden = !canCollapse;
}

function clearContainer(container: HTMLElement): void {
  container.querySelector(`:scope > [${MORE_ATTR}]`)?.remove();
  for (const el of container.children as HTMLCollectionOf<HTMLElement>) {
    el.removeAttribute(HIDDEN_ATTR);
    if (el.hasAttribute("data-sp-order")) {
      el.style.removeProperty("order");
      el.removeAttribute("data-sp-order");
    }
    clearGuides(el);
  }
}

/** Vertical tree lines for the new sibling order; thread-tree's own bend stays. `own` draws the half line below the target's own bend. */
function drawGuides(target: HTMLElement, node: TreeNode, own: boolean): void {
  const images: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  for (let current: TreeNode | null = node; current?.parent; current = current.parent) {
    const siblings = current.parent.children;
    if (siblings.indexOf(current) === siblings.length - 1) continue;
    const x = (parseFloat(current.parent.row.style.paddingLeft) || 0) + GLYPH_CENTER_PX;
    images.push(LINE);
    if (own && current === node) {
      sizes.push("1px calc(50% + 1px)");
      positions.push(`${x}px 100%`);
    } else {
      sizes.push("1px 100%");
      positions.push(`${x}px 0`);
    }
  }
  setAttr(target, GUIDES_ATTR, "");
  setVar(target, "--sp-guide-img", images.length > 0 ? images.join(", ") : "none");
  setVar(target, "--sp-guide-size", sizes.join(", ") || "0 0");
  setVar(target, "--sp-guide-pos", positions.join(", ") || "0 0");
}

function clearGuides(row: HTMLElement): void {
  if (!row.hasAttribute(GUIDES_ATTR)) return;
  row.removeAttribute(GUIDES_ATTR);
  for (const name of GUIDE_VARS) row.style.removeProperty(name);
}

export function clearSidebar(root: ParentNode): void {
  requestSync = () => {};
  for (const el of root.querySelectorAll(`[${MORE_ATTR}]`)) el.remove();
  for (const el of root.querySelectorAll(`[${HIDDEN_ATTR}]`)) el.removeAttribute(HIDDEN_ATTR);
  for (const el of root.querySelectorAll<HTMLElement>(`[${AGE_ATTR}]`)) el.removeAttribute(AGE_ATTR);
  for (const name of [STATE_ATTR, FOLDER_ATTR, FOLDER_ERROR_ATTR, ACTIVE_ATTR]) {
    for (const el of root.querySelectorAll(`[${name}]`)) el.removeAttribute(name);
  }
  for (const el of root.querySelectorAll<HTMLElement>(`[${GUIDES_ATTR}]`)) clearGuides(el);
  for (const el of root.querySelectorAll<HTMLElement>("[data-sp-order]")) {
    el.style.removeProperty("order");
    el.removeAttribute("data-sp-order");
  }
}

function setOrder(el: HTMLElement, order: number): void {
  const value = String(order);
  if (el.style.order !== value) el.style.order = value;
  if (!el.hasAttribute("data-sp-order")) el.setAttribute("data-sp-order", "");
}

function setAttr(el: HTMLElement, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}
