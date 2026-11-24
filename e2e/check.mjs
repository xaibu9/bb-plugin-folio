// Folio BB on a clean bb: bundled plugins only, then Thread Tree from the
// catalog, seeded threads, three looks (default dark/light, Nord dark).
// Run: npm run e2e   (screenshots go to e2e/out/)
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, createReport, log, openPage, pluginProblems, seedThreads, stagePlugin, startInstance } from "./lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "e2e", "out");
const report = createReport("folio-bb e2e");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const SIDEBAR = '[data-sidebar="sidebar"]';
const CARD = '[role="tree"] section[data-flip-key]';

async function sidebarShot(page, name) {
  const box = await page.locator(SIDEBAR).first().boundingBox();
  const height = page.viewportSize()?.height ?? 800;
  await page.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: Math.ceil((box?.x ?? 0) + (box?.width ?? 320)) + 1, height } });
}

/** Scrolls the card with the most rows so its header sits `offset` px past the list top. */
async function scrollCard(page, offset) {
  return page.evaluate(
    ([card, offset]) => {
      const sections = [...document.querySelectorAll(card)];
      const s = sections.sort((a, b) => b.querySelectorAll("[data-thread-row]").length - a.querySelectorAll("[data-thread-row]").length)[0];
      if (!s) return null;
      let sc = s.parentElement;
      while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (!sc) return null;
      sc.scrollTop += s.getBoundingClientRect().top - sc.getBoundingClientRect().top + offset;
      return true;
    },
    [CARD, offset],
  );
}

async function headerState(page) {
  return page.evaluate((card) => {
    const s = [...document.querySelectorAll(card)].sort((a, b) => b.querySelectorAll("[data-thread-row]").length - a.querySelectorAll("[data-thread-row]").length)[0];
    const h = s?.querySelector(":scope > [data-drag-image]");
    if (!s || !h) return null;
    const hs = getComputedStyle(h);
    const hr = h.getBoundingClientRect();
    const sr = s.getBoundingClientRect();
    return {
      position: hs.position,
      top: hs.borderTopWidth,
      sides: hs.borderLeftWidth === "1px" && hs.borderRightWidth === "1px",
      radius: hs.borderTopLeftRadius,
      cardTop: getComputedStyle(s).borderTopWidth,
      aligned: Math.abs(hr.left - sr.left) < 1 && Math.abs(hr.right - sr.right) < 1,
      stuck: hr.top > sr.top + 1,
    };
  }, CARD);
}

async function checkLook(bb, theme, mode) {
  const tag = `${theme}-${mode}`;
  await bb.cli(["theme", "set", theme]);
  const { browser, page, errors } = await openPage(bb.base, { mode });
  try {
    await page.waitForSelector(`${CARD} [data-thread-row]`, { timeout: 60_000 });
    await page.waitForTimeout(4000);
    await sidebarShot(page, `${tag}-top`);

    const button = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="sidebar-header-slot"] button[aria-keyshortcuts], [data-sidebar-navigation-item="__bb__/new-thread"] > button');
      return b ? Math.round(b.getBoundingClientRect().height) : null;
    });
    report.check(`${tag}: New thread button is the tall outlined one`, button === 44, `height ${button}`);

    const cards = await page.locator(CARD).count();
    report.check(`${tag}: project folders are cards`, cards >= 2, `${cards} cards`);
    const more = await page.locator("[data-sp-more] > button[data-sp-action=more]:not([hidden])").allInnerTexts();
    report.check(`${tag}: a card with 7 threads folds after 5`, more.some((t) => /^Show 2 more$/.test(t)), JSON.stringify(more));
    const ages = await page.$$eval("[data-sp-age]", (els) => els.map((el) => el.getAttribute("data-sp-age")));
    report.check(`${tag}: rows show activity age`, ages.length >= 5 && ages.every((a) => /^(now|<1m|\d+[mhd])$/.test(a ?? "")), `${ages.length} ages, e.g. ${ages.slice(0, 3).join(" ")}`);
    const icons = await page.$$eval("[data-thread-row] [data-provider-icon]", (els) =>
      els.filter((el) => getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0).length,
    );
    report.check(`${tag}: idle rows show the provider icon`, icons >= 5, `${icons} visible icons`);
    const sorted = await page.evaluate((card) => {
      const s = [...document.querySelectorAll(card)].find((x) => x.querySelectorAll("[data-thread-row]").length >= 5);
      const rows = [...(s?.querySelectorAll(":scope [data-thread-row][data-thread-id]:not([data-sp-hidden])") ?? [])];
      const orders = rows.map((r) => Number(r.style.order));
      return orders.length > 0 && orders.every((o, i) => i === 0 || o >= 0);
    }, CARD);
    report.check(`${tag}: rows carry the activity order`, sorted);

    await page.locator("[data-sp-more] > button[data-sp-action=more]:not([hidden])").first().click();
    await page.waitForTimeout(800);
    const less = await page.locator("[data-sp-more] > button[data-sp-action=less]:not([hidden])").count();
    report.check(`${tag}: Show more opens the rest and offers Show less`, less >= 1);
    await page.locator("[data-sp-more] > button[data-sp-action=less]:not([hidden])").first().click();
    await page.waitForTimeout(500);

    await scrollCard(page, -8);
    await page.waitForTimeout(500);
    const rest = await headerState(page);
    await sidebarShot(page, `${tag}-cards`);
    report.check(
      `${tag}: card header at rest has one top edge`,
      rest && rest.position === "sticky" && rest.top === "1px" && rest.cardTop === "0px" && rest.sides && rest.aligned,
      JSON.stringify(rest),
    );
    // Short window and an open card so the list scrolls and the header can stick.
    await page.locator("[data-sp-more] > button[data-sp-action=more]:not([hidden])").first().click().catch(() => {});
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.waitForTimeout(500);
    await scrollCard(page, 90);
    await page.waitForTimeout(500);
    const stuck = await headerState(page);
    await sidebarShot(page, `${tag}-sticky`);
    await page.setViewportSize({ width: 1280, height: 800 });
    report.check(
      `${tag}: stuck header keeps its whole outline`,
      stuck && stuck.stuck && stuck.top === "1px" && stuck.sides && stuck.aligned && stuck.radius !== "0px",
      JSON.stringify(stuck),
    );
    report.check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
  }
}

/** A thread that works for ~40 s: Recent Activity puts it first with "now"; once done it reads "<1m" at once. */
async function checkRunning(bb) {
  const projects = await bb.cli(["project", "list"], { json: true });
  const project = (Array.isArray(projects) ? projects : projects.projects ?? []).find((p) => p.name === "api");
  const thread = await bb.cli(
    [
      "thread", "spawn", "--project", project.id, "--provider", "claude-code", "--model", process.env.BB_E2E_MODEL ?? "claude-haiku-4-5-20251001",
      "--permission-mode", "full", "--title", "Long running check",
      "--prompt", "Run the shell command `sleep 40` with your Bash tool, then reply with the single word ok.",
    ],
    { json: true },
  );
  const { browser, page, errors } = await openPage(bb.base, { mode: "dark" });
  try {
    await page.waitForSelector('section[aria-label="Recent activity"] [data-thread-row]', { timeout: 60_000 });
    const recent = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('section[aria-label="Recent activity"] [data-thread-row][data-thread-id]')]
          .sort((a, b) => Number(a.style.order || 0) - Number(b.style.order || 0))
          .map((r) => ({ id: r.dataset.threadId, glyph: r.querySelector("[data-status-glyph]")?.getAttribute("data-status-glyph"), age: r.querySelector("[data-row-age]")?.getAttribute("data-sp-age") })),
      );
    let rows = [];
    for (let i = 0; i < 40; i++) {
      rows = await recent();
      if (rows.find((r) => r.id === thread.id)?.glyph === "runtime") break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(1500);
    rows = await recent();
    await sidebarShot(page, "running-recent");
    const mine = rows.find((r) => r.id === thread.id);
    report.check("a working thread is first in Recent Activity", rows[0]?.id === thread.id && mine?.glyph === "runtime", JSON.stringify(rows.slice(0, 3)));
    report.check("a working thread reads 'now'", mine?.age === "now", JSON.stringify(mine));
    const badge = await badgeOf(page, thread.id);
    report.check("a working thread has a spinning badge on its AI icon", badge?.state === "working" && badge.animation === "sp-spin", JSON.stringify(badge));
    const folder = await folderOf(page, "api");
    report.check("its folder shows a spinner left of the count", folder?.state === "working" && folder.animation === "sp-spin", JSON.stringify(folder));
    await toggleFolder(page, "api");
    const collapsed = await folderOf(page, "api");
    await sidebarShot(page, "status-collapsed-working");
    report.check("a collapsed folder keeps its spinner", collapsed?.collapsed === true && collapsed.state === "working", JSON.stringify(collapsed));
    await toggleFolder(page, "api");
    await bb.cli(["thread", "wait", thread.id, "--timeout", "180"], { allowFail: true });
    let after = null;
    for (let i = 0; i < 20; i++) {
      after = (await recent()).find((r) => r.id === thread.id);
      if (after && after.glyph !== "runtime") break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(3000);
    after = (await recent()).find((r) => r.id === thread.id);
    report.check("a finished thread stops reading 'now' at once", after?.age === "<1m", JSON.stringify(after));
    const done = await badgeOf(page, thread.id);
    const success = await page.evaluate(() => { const p = document.createElement("span"); p.style.color = "var(--success)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    report.check("a finished, unread thread gets the green badge", done?.state === "done" && done.color === success, JSON.stringify({ done, success }));
    const folderDone = await folderOf(page, "api");
    report.check("its folder rolls up to finished once nothing works", folderDone?.state === "done" || folderDone?.state === "waiting", JSON.stringify(folderDone));
    await sidebarShot(page, "status-done");
    report.check("no page errors (running thread)", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
  }
}

/** The badge drawn on a thread row's AI icon. */
function badgeOf(page, threadId) {
  return page.evaluate((id) => {
    const row = [...document.querySelectorAll(`[data-thread-row][data-thread-id="${id}"]`)].find((r) => r.querySelector("[data-provider-icon]"));
    const icon = row?.querySelector("[data-provider-icon]");
    if (!row || !icon) return null;
    const after = getComputedStyle(icon, "::after");
    return { state: row.getAttribute("data-sp-state"), content: after.content, animation: after.animationName, color: after.backgroundColor, visible: after.content !== "none" && parseFloat(after.width) > 0 };
  }, threadId);
}

/** A project folder's rollup badge, by project name. */
function folderOf(page, name) {
  return page.evaluate((name) => {
    const section = [...document.querySelectorAll('[role="tree"] section[data-flip-key^="project:"]')].find((s) => s.querySelector("[data-drag-image] button")?.textContent?.trim().startsWith(name));
    const tail = section?.querySelector(":scope > [data-drag-image] [data-section-tail]");
    if (!section || !tail) return null;
    const before = getComputedStyle(tail, "::before");
    return {
      state: section.getAttribute("data-sp-folder"),
      active: section.hasAttribute("data-sp-active"),
      collapsed: section.querySelector(":scope > [data-drag-image] button[aria-expanded]")?.getAttribute("aria-expanded") === "false",
      badge: before.content !== "none",
      animation: before.animationName,
      border: getComputedStyle(section).borderLeftColor,
    };
  }, name);
}

async function toggleFolder(page, name) {
  await page.locator('[role="tree"] section[data-flip-key^="project:"] > [data-drag-image] > button', { hasText: name }).first().click();
  await page.waitForTimeout(800);
}

/** The open thread's folder is outlined, collapsed or not. */
async function checkActiveFolder(bb) {
  const { browser, page, errors } = await openPage(bb.base, { mode: "dark" });
  try {
    await page.waitForSelector(`${CARD} [data-thread-row]`, { timeout: 60_000 });
    await page.waitForTimeout(3000);
    const idle = await folderOf(page, "api");
    await page.locator(`${CARD} [data-thread-row] a`, { hasText: "Refactor billing webhooks" }).first().click();
    await page.waitForTimeout(2000);
    const open = await folderOf(page, "web-app");
    report.check("the open thread's folder is highlighted", open?.active === true && open.border !== idle?.border, JSON.stringify({ open, other: idle }));
    report.check("other folders are not highlighted", idle?.active === false && (await folderOf(page, "api"))?.active === false);
    await toggleFolder(page, "web-app");
    const folded = await folderOf(page, "web-app");
    await sidebarShot(page, "active-folder-collapsed");
    report.check("a collapsed folder stays highlighted", folded?.collapsed === true && folded.active === true, JSON.stringify(folded));
    await toggleFolder(page, "web-app");
    await sidebarShot(page, "active-folder-open");
    report.check("no page errors (active folder)", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
  }
}

async function checkSettings(bb) {
  const { browser, page, errors } = await openPage(bb.base, { mode: "dark", path: "/settings/plugins/folio-bb", height: 900 });
  try {
    await page.waitForSelector(".sp-accent-picker", { timeout: 60_000 });
    await page.screenshot({ path: join(OUT, "settings.png") });
    report.check("settings page shows the accent picker", true);
    const accentOf = () =>
      page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--folio-accent)";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
    const settle = async (expected) => {
      for (let i = 0; i < 30; i++) {
        const now = await accentOf();
        if (now === expected) return now;
        await page.waitForTimeout(500);
      }
      return accentOf();
    };
    const themed = await accentOf();
    await page.locator('.sp-swatch[aria-label="#7aa2f7"]').click();
    const picked = await settle("rgb(122, 162, 247)");
    report.check("a picked swatch becomes the public accent", picked === "rgb(122, 162, 247)", `${themed} -> ${picked}`);
    const saved = await bb.cli(["plugin", "config", "folio-bb"]);
    report.check("the pick is saved as the accent setting", /accent = "#7aa2f7"/.test(saved));
    await page.locator(".sp-hex").fill("#FF8800");
    await page.locator(".sp-hex").press("Enter");
    report.check("a typed hex is applied", (await settle("rgb(255, 136, 0)")) === "rgb(255, 136, 0)");
    await page.locator(".sp-swatch-theme").click();
    const back = await settle(themed);
    report.check("the first circle returns to the theme accent", back === themed, `${back} vs ${themed}`);
    report.check("settings page has no errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
  }
}

const bb = await startInstance({ label: "clean bb" });
try {
  // 1. Bundled plugins only, then the pack: only the New thread button applies.
  const staged = await stagePlugin(bb, ROOT);
  await bb.cli(["plugin", "install", staged, "--yes"]);
  await bb.cli(["plugin", "config", "folio-bb", "set", "language", "en"]);
  {
    const { browser, page, errors } = await openPage(bb.base);
    await page.waitForSelector(SIDEBAR, { timeout: 60_000 });
    await page.waitForTimeout(4000);
    const height = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="sidebar-header-slot"] button[aria-keyshortcuts], [data-sidebar-navigation-item="__bb__/new-thread"] > button');
      return b ? Math.round(b.getBoundingClientRect().height) : null;
    });
    await sidebarShot(page, "without-thread-tree");
    report.check("without Thread Tree: the New thread button still applies", height === 44, `height ${height}`);
    report.check("without Thread Tree: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await browser.close();
  }

  // 2. Thread Tree from the catalog, as a new user installs it, and some threads.
  // A fresh instance loads the community catalog in the background; retry until it resolves.
  for (let attempt = 0; ; attempt++) {
    const done = await bb.cli(["plugin", "install", "thread-tree", "--yes"], { timeout: 900_000, allowFail: attempt < 18 });
    if (done !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  // Recent Activity is off in a fresh Thread Tree; the pack sorts it, so turn it on.
  await bb.cli(["plugin", "config", "thread-tree", "set", "showRecent", "true"]);
  await seedThreads(bb);

  for (const [theme, mode] of [
    ["default", "dark"],
    ["default", "light"],
    ["nord", "dark"],
  ]) {
    await checkLook(bb, theme, mode);
  }
  await checkRunning(bb);
  await checkActiveFolder(bb);
  await checkSettings(bb);

  const problems = await pluginProblems(bb, "folio-bb");
  report.check("folio-bb log has no warnings or errors", problems.length === 0, problems.slice(0, 3).join(" | "));
} catch (cause) {
  report.check("run completed", false, cause instanceof Error ? cause.message : String(cause));
} finally {
  await bb.stop();
  if (!process.env.BB_E2E_KEEP) cleanup(bb.dir);
  log(`screenshots: ${OUT}`);
  report.finish();
}
