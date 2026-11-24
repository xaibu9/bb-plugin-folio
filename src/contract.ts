import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const ACTIVITY_TAG = "activity";
export const THEME_ACCENT = "theme";
export const accentSchema = z.union([z.literal(THEME_ACCENT), z.string().regex(/^#[0-9a-f]{6}$/i)]);

export const contract = defineRpcContract({
  activity: {
    input: z.null(),
    /** Epoch ms of each thread's latest turn event, by thread id. */
    output: z.object({ at: z.record(z.string(), z.number()) }),
    tags: () => [ACTIVITY_TAG],
  },
  /** Saves the accent setting from the settings page picker. */
  setAccent: {
    input: z.object({ accent: accentSchema }),
    output: z.object({ accent: accentSchema }),
  },
});
