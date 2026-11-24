// Tracks each thread's latest turn event so the sidebar can show and sort by real activity.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accentSchema, ACTIVITY_TAG, contract, THEME_ACCENT } from "./src/contract";

const STORE_KEY = "activity-v1";
const SEED_CONCURRENCY = 4;
const INVALIDATE_MS = 2_000;
// Turn traffic only: plugin state, rate limits and reads must not count as activity.
const TURN_EVENTS = [
  "client/turn/requested",
  "turn/input/accepted",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "system/thread/interrupted",
  "system/error",
  "provider/error",
] as const;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    accent: {
      type: "string",
      label: "Accent color",
      description: "\"theme\" follows the active bb theme; or a color as #rrggbb. The settings section below has a picker.",
      experimental_schema: accentSchema,
      default: THEME_ACCENT,
    },
    language: {
      type: "select",
      label: "Language",
      options: ["auto", "en", "ru"],
      experimental_optionLabels: { auto: "Auto (browser language)", en: "English", ru: "Русский" },
      default: "auto",
    },
    pageSize: {
      type: "number",
      label: "Threads per project card",
      description: "Root threads a card shows before \"Show N more\". 0 shows every thread.",
      experimental_schema: z.number().int().min(0).max(100),
      default: 5,
    },
    projectCards: { type: "boolean", label: "Project folders as cards with a sticky header", default: true },
    activitySort: { type: "boolean", label: "Sort threads in project folders by last activity and show its age", default: true },
    providerIcons: { type: "boolean", label: "Provider icon in place of the gray dot on thread rows", default: true },
    newThreadButton: { type: "boolean", label: "Full-width New thread button", default: true },
    hideCounters: { type: "boolean", label: "Hide status counters and static key hints", default: true },
    statusBadges: {
      type: "boolean",
      label: "Status badges",
      description: "A dot on the AI icon of each thread and a rollup left of each folder's count: working, failed, waiting for you, finished.",
      default: true,
    },
    activeFolder: {
      type: "boolean",
      label: "Highlight the open thread's folder",
      default: true,
    },
    needsYouAccent: {
      type: "boolean",
      label: "Needs you in the accent color",
      description: "Off: the theme's attention color. On: the theme accent (gray in the default theme).",
      default: false,
    },
  });

  const at: Record<string, number> = (await bb.storage.kv.get<Record<string, number>>(STORE_KEY).catch(() => undefined)) ?? {};
  let disposed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (disposed) return;
      bb.rpc.experimental_invalidate([ACTIVITY_TAG]);
      void bb.storage.kv.set(STORE_KEY, at).catch(() => undefined);
    }, INVALIDATE_MS);
  };

  const record = (threadId: string, time: number) => {
    if ((at[threadId] ?? 0) >= time) return;
    at[threadId] = time;
    flush();
  };

  const latestTurnEvent = async (threadId: string): Promise<number | null> => {
    const rows = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: [...TURN_EVENTS] });
    return rows[0]?.createdAt ?? null;
  };

  // bb's local API fails now and then while the server is busy ("fetch failed"); one retry, then
  // the next event or seed catches up, so this is not worth a warning.
  const refresh = async (threadId: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const time = await latestTurnEvent(threadId);
        if (time !== null) record(threadId, time);
        return;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/\b404\b|not found/i.test(message)) return;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        else bb.log.debug(`activity ${threadId}: ${message}`);
      }
    }
  };

  const seed = async () => {
    const ids: string[] = [];
    for (let offset = 0; !disposed; offset += 200) {
      const page = await bb.sdk.threads.list({ archived: false, limit: 200, offset });
      ids.push(...page.map((thread) => thread.id));
      if (page.length < 200) break;
    }
    let next = 0;
    const worker = async () => {
      while (!disposed && next < ids.length) await refresh(ids[next++]!);
    };
    await Promise.all(Array.from({ length: SEED_CONCURRENCY }, worker));
    if (disposed) return;
    const live = new Set(ids);
    for (const id of Object.keys(at)) if (!live.has(id)) delete at[id];
    flush();
    bb.log.info(`activity seeded for ${ids.length} threads`);
  };

  bb.events.on("experimental_thread.events", ({ thread }) => void refresh(thread.id));
  bb.events.on("thread.created", ({ thread }) => record(thread.id, thread.createdAt));

  bb.rpc.register(contract, {
    activity: () => ({ at }),
    setAccent: async ({ accent }) => ({ accent: (await settings.experimental_set({ accent })).accent as string }),
  });

  void seed().catch((cause: unknown) => bb.log.warn(`activity seed failed: ${cause instanceof Error ? cause.message : String(cause)}`));

  bb.onDispose(() => {
    disposed = true;
    if (flushTimer !== null) clearTimeout(flushTimer);
  });
}
