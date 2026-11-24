---
name: folio-bb
description: Settings and behavior of the Folio BB plugin (id folio-bb) that restyles the bb thread sidebar - project cards, activity sort, provider icons, New thread button. Use when asked to change how many threads a project card shows, switch a sidebar part off, or explain why sidebar rows are ordered or labeled the way they are.
---

# Folio BB

Restyles the Thread Tree sidebar. All colors come from the active bb theme. The accent is the theme's `--primary` unless the `accent` setting holds a `#rrggbb` color (`bb plugin config folio-bb set accent '#7aa2f7'`, or the picker on the plugin's settings page; `theme` goes back).

Settings (`bb plugin config folio-bb set <key> <value>`):

- `language` — `auto` | `en` | `ru`: labels for ages and "Show N more".
- `pageSize` — root threads per project card before "Show N more" (default 5, `0` shows all).
- `projectCards`, `activitySort`, `providerIcons`, `newThreadButton`, `hideCounters` — `true`/`false`, each switches one part on or off.
- `needsYouAccent` — `true` tints Needs you with the theme accent instead of the theme's attention color (default `false`; the default theme's accent is gray).

Behavior:

- Order and age inside project folders come from each thread's latest turn event (sent, started, completed, item, interrupted, error), not from attention time. Pinned, Recent Activity, Orchestrations and search results keep Thread Tree's own order.
- Keyboard order (⌘1–9, arrow keys) still follows Thread Tree's internal order.
- The open thread and running threads are never hidden behind "Show N more".
- Without the Thread Tree plugin only the New thread button changes.
