// Static sidebar styles plus a headless overlay that relabels and re-sorts thread rows by activity.
import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useBbContext,
  useRpc,
  useSettings,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { contract, THEME_ACCENT } from "./src/contract";
import { clearSidebar, syncSidebar, type FolderState, type Lang, type RowActivity, type SyncOptions } from "./src/sidebarSync";
import "./app.css";

const TICK_MS = 30_000;
const SYNC_THROTTLE_MS = 250;
/** The indicators Thread Tree treats as working; a held runtime ("active" status) alone is not work. */
const WORKING_INDICATORS = new Set(["runtime", "background-agent", "background-command", "workflow", "working-draft"]);
const OFF_ATTR = "data-folio-off";
const ACCENT_ATTR = "data-folio-needs-accent";
const ACCENT_VAR = "--sp-accent-custom";
const SWATCHES = ["#b795f3", "#7aa2f7", "#8be9fd", "#50fa7b", "#ff79c6", "#ffb86c"];
/** Boolean settings that switch a CSS part off, by the token CSS matches in OFF_ATTR. */
const PARTS = {
  projectCards: "cards",
  activitySort: "sort",
  providerIcons: "icons",
  newThreadButton: "button",
  hideCounters: "counters",
  statusBadges: "status",
  activeFolder: "active",
} as const;

/** One thread's share of its folder's rollup, from the same indicators Thread Tree's glyphs use. */
function folderShare(thread: PluginSidebarThread): FolderState {
  const indicator: string = thread.indicator;
  return {
    // bb's indicator is already folded by priority (an unread result outranks a lingering
    // background command), so the folder agrees with the badges on its rows.
    working: WORKING_INDICATORS.has(indicator) || indicator === "plan-mode",
    error: indicator === "unread-error" || indicator === "queued-failed" || thread.status === "error",
    waiting: indicator === "waiting-for-input" || indicator === "queued-waiting" || thread.hasPendingInteraction,
    done: indicator === "unread-success",
  };
}

function resolveLang(value: unknown): Lang {
  if (value === "en" || value === "ru") return value;
  const browser = typeof navigator === "undefined" ? "" : navigator.language;
  return /^ru\b/i.test(browser) ? "ru" : "en";
}

function readOptions(values: Record<string, unknown> | undefined): SyncOptions {
  const size = values?.pageSize;
  return {
    lang: resolveLang(values?.language),
    pageSize: typeof size === "number" && Number.isFinite(size) && size >= 0 ? Math.floor(size) : 5,
    sort: values?.activitySort !== false,
  };
}

function isWorking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    WORKING_INDICATORS.has(thread.indicator) ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.workflows > 0
  );
}

function ActivitySync() {
  const { values, isLoading } = useSettings();
  const settings = values as Record<string, unknown> | undefined;
  // Until the saved settings arrive nothing is touched, so a non-default setup does not flash.
  const ready = !isLoading && settings !== undefined;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const settingsKey = JSON.stringify(settings ?? null);
  const options = useRef<SyncOptions>(readOptions(settings));
  const query = experimental_useRpcQuery({ contract, method: "activity", input: null });
  const { threads } = experimental_useSidebarThreads();
  const { threadId: openThreadId } = useBbContext();
  const [now, setNow] = useState(() => Date.now());
  const lookup = useRef<(threadId: string) => RowActivity | null>(() => null);
  const schedule = useRef<() => void>(() => {});
  const folderState = useRef<Pick<SyncOptions, "folderOf" | "activeFolder">>({});

  useEffect(() => {
    if (!ready) return;
    options.current = readOptions(settings);
    const off = Object.entries(PARTS)
      .filter(([key]) => settings?.[key] === false)
      .map(([, token]) => token);
    if (off.length > 0) document.documentElement.setAttribute(OFF_ATTR, off.join(" "));
    else document.documentElement.removeAttribute(OFF_ATTR);
    document.documentElement.toggleAttribute(ACCENT_ATTR, settings?.needsYouAccent === true);
    const accent = typeof settings?.accent === "string" ? settings.accent.toLowerCase() : THEME_ACCENT;
    if (/^#[0-9a-f]{6}$/.test(accent)) document.documentElement.style.setProperty(ACCENT_VAR, accent);
    else document.documentElement.style.removeProperty(ACCENT_VAR);
    schedule.current();
  }, [settingsKey, ready]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const folders = new Map<string, FolderState>();
    for (const thread of threads) {
      const key = `project:${thread.projectId}`;
      const share = folderShare(thread);
      const sum = folders.get(key) ?? { working: false, error: false, waiting: false, done: false };
      folders.set(key, {
        working: sum.working || share.working,
        error: sum.error || share.error,
        waiting: sum.waiting || share.waiting,
        done: sum.done || share.done,
      });
    }
    const open = openThreadId ? byId.get(openThreadId) : undefined;
    folderState.current = { folderOf: (key) => folders.get(key) ?? null, activeFolder: open ? `project:${open.projectId}` : null };
    const seen = query.data?.at ?? {};
    lookup.current = (threadId) => {
      const thread = byId.get(threadId);
      if (!thread) return null;
      const at = Math.max(seen[threadId] ?? 0, thread.latestAttentionAt, thread.createdAt);
      return { at, working: isWorking(thread) };
    };
    schedule.current();
  }, [threads, query.data, now, openThreadId]);

  useEffect(() => {
    let timer: number | null = null;
    const run = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (!readyRef.current) return;
      syncSidebar(document, (id) => lookup.current(id), Date.now(), { ...options.current, ...folderState.current }, () => run());
    };
    schedule.current = () => {
      if (timer === null) timer = window.setTimeout(run, SYNC_THROTTLE_MS);
    };
    const observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (!target?.closest('[data-sidebar="sidebar"], [data-sidebar="panel"]')) continue;
        relevant = true;
        // New rows get their order before paint instead of flashing at the top of the group.
        for (const node of mutation.addedNodes) {
          if (node instanceof Element && (node.matches("[data-thread-row]") || node.querySelector("[data-thread-row]"))) {
            run();
            return;
          }
        }
      }
      if (relevant) schedule.current();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    schedule.current();
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
      schedule.current = () => {};
      clearSidebar(document);
      document.documentElement.removeAttribute(OFF_ATTR);
      document.documentElement.removeAttribute(ACCENT_ATTR);
      document.documentElement.style.removeProperty(ACCENT_VAR);
    };
  }, []);

  return null;
}

/** Swatches and a hex field for the accent setting; "theme" follows the bb theme. */
function AccentSettings() {
  const { values } = useSettings();
  const rpc = useRpc<typeof contract>();
  const saved = typeof values?.accent === "string" ? values.accent.toLowerCase() : THEME_ACCENT;
  const [accent, setAccent] = useState(saved);
  const [draft, setDraft] = useState(saved === THEME_ACCENT ? "" : saved);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setAccent(saved);
    setDraft(saved === THEME_ACCENT ? "" : saved);
  }, [saved]);
  const save = (next: string) => {
    setAccent(next);
    setDraft(next === THEME_ACCENT ? "" : next);
    setError(null);
    rpc.call("setAccent", { accent: next }).catch((cause: unknown) => {
      setAccent(saved);
      setError(cause instanceof Error ? cause.message : "Not saved");
    });
  };
  const commitDraft = () => {
    const hex = `#${draft.trim().replace(/^#/, "").toLowerCase()}`;
    if (/^#[0-9a-f]{6}$/.test(hex)) save(hex);
    else setDraft(accent === THEME_ACCENT ? "" : accent);
  };
  const custom = accent !== THEME_ACCENT && !SWATCHES.includes(accent);
  return (
    <div>
      <div className="sp-accent-picker" role="group" aria-label="Accent color">
        <button type="button" className="sp-swatch sp-swatch-theme" aria-pressed={accent === THEME_ACCENT} aria-label="Theme accent" title="Theme accent" onClick={() => save(THEME_ACCENT)} />
        {SWATCHES.map((color) => (
          <button type="button" key={color} className="sp-swatch" style={{ background: color }} aria-pressed={accent === color} aria-label={color} title={color} onClick={() => save(color)} />
        ))}
        <label className="sp-swatch sp-swatch-custom" aria-pressed={custom} title="Custom color" style={custom ? { background: accent } : undefined}>
          <input type="color" aria-label="Custom color" value={accent === THEME_ACCENT ? "#888888" : accent} onChange={(e) => save(e.target.value.toLowerCase())} />
        </label>
        <input
          className="sp-hex"
          value={draft}
          placeholder="#rrggbb"
          aria-label="Accent color as #rrggbb"
          spellCheck={false}
          maxLength={7}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDraft();
          }}
        />
      </div>
      <p className="sp-accent-note">{error ?? "The first circle follows the active bb theme. Needs you uses this color when \"Needs you in the accent color\" is on."}</p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "accent", title: "Accent color", component: AccentSettings });
  app.contentScripts.register({ id: "folio-bb", mount: () => {} });
  app.slots.experimental_appOverlay({ id: "sidebar-activity", component: ActivitySync });
});
