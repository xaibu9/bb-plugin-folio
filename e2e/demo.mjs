// Demo screenshots on a clean bb (Dracula, neutral names): every status, a highlighted
// folder, collapsed folders with rollups and the Fuel BB strip.
// Run: node e2e/demo.mjs   (LIMITS_PANEL_DIR overrides ../bb-plugin-limits-public; output in announce/raw/)
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, DESKTOP_LAYOUT_CSS, log, openPage, stagePlugin, startInstance } from "./lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "announce", "raw");
const LIMITS = resolve(process.env.LIMITS_PANEL_DIR ?? join(ROOT, "..", "bb-plugin-limits-public"));
const MODEL = process.env.BB_E2E_MODEL ?? "claude-haiku-4-5-20251001";
mkdirSync(OUT, { recursive: true });
const { execFile } = await import("node:child_process");
const run = (await import("node:util")).promisify(execFile);

const PLAN = {
  "web-app": ["Fix flaky login test", "Refactor billing webhooks", "Add dark mode to settings", "Investigate slow search", "Write release notes", "Migrate cron jobs", "Update API docs"],
  api: ["Rate limit the public API", "Retry failed webhooks"],
  docs: ["Rewrite the quick start", "Document the CLI flags"],
  mobile: ["Fix push notification badge", "Profile cold start"],
  infra: ["Rotate staging certificates"],
};
const OK = "Reply with the single word ok. Do not use any tools.";

const bb = await startInstance({ label: "demo bb" });
try {
  await bb.cli(["theme", "set", "dracula"]);
  for (let attempt = 0; ; attempt++) {
    if ((await bb.cli(["plugin", "install", "thread-tree", "--yes"], { timeout: 900_000, allowFail: attempt < 18 })) !== null) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  await bb.cli(["plugin", "install", await stagePlugin(bb, ROOT), "--yes"]);
  await bb.cli(["plugin", "config", "folio-bb", "set", "language", "en"]);
  if (existsSync(join(LIMITS, "package.json"))) await bb.cli(["plugin", "install", await stagePlugin(bb, LIMITS), "--yes"]);

  const projects = {};
  for (const name of Object.keys(PLAN)) {
    const root = join(bb.dir, "projects", name);
    mkdirSync(root, { recursive: true });
    await run("git", ["init", "-q"], { cwd: root });
    await run("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
    projects[name] = (await bb.cli(["project", "create", "--name", name, "--root", root], { json: true })).id;
  }
  const spawn = (project, title, prompt, extra = []) =>
    bb.cli(["thread", "spawn", "--project", projects[project], "--provider", "claude-code", "--model", MODEL, "--title", title, "--prompt", prompt, ...extra], { json: true });

  const ids = {};
  for (const [project, titles] of Object.entries(PLAN)) {
    for (const title of titles) {
      if (title === "Investigate slow search" || title === "Retry failed webhooks" || title === "Profile cold start") continue;
      ids[title] = (await spawn(project, title, OK, ["--permission-mode", "accept-edits"])).id;
    }
  }
  for (const id of Object.values(ids)) await bb.cli(["thread", "wait", id, "--timeout", "180"], { allowFail: true });
  // Waiting for you: a question the agent asks before it starts.
  ids.waiting = (await spawn("web-app", "Investigate slow search", "Before doing anything else, ask me with your AskUserQuestion tool whether the search index should use Postgres or SQLite. Wait for my answer.", ["--permission-mode", "accept-edits"])).id;
  // Failed: a model the provider does not have.
  ids.failed = (await bb.cli(["thread", "spawn", "--project", projects.api, "--provider", "claude-code", "--model", "claude-does-not-exist", "--title", "Retry failed webhooks", "--prompt", OK], { json: true, allowFail: true }))?.id;
  ids.mobileDone = (await spawn("mobile", "Profile cold start", OK, ["--permission-mode", "accept-edits"])).id;
  await bb.cli(["thread", "wait", ids.mobileDone, "--timeout", "180"], { allowFail: true });
  await new Promise((r) => setTimeout(r, 15_000));
  // Read all but two, so Needs you stays short and two rows keep the "finished" badge.
  for (const [title, id] of Object.entries(ids)) {
    if (!["Migrate cron jobs", "Fix push notification badge", "waiting", "failed"].includes(title)) await bb.cli(["thread", "read", id], { allowFail: true });
  }
  const { browser, page } = await openPage(bb.base, { mode: "dark", width: 1280, height: 1180 });
  try {
    await page.waitForSelector('[role="tree"] section[data-flip-key] [data-thread-row]', { timeout: 60_000 });
    await page.addStyleTag({ content: "[data-bb-plugin=session-history]{display:none!important}" });
    const href = await page.locator('[role="tree"] [data-thread-row] a', { hasText: "Refactor billing webhooks" }).first().getAttribute("href");
    await page.goto(bb.base + href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[role="tree"] section[data-sp-active]', { timeout: 60_000 });
    await page.addStyleTag({ content: "[data-bb-plugin=session-history]{display:none!important}" });
    await page.addStyleTag({ content: DESKTOP_LAYOUT_CSS });
    await page.waitForTimeout(4000);
    const fold = async (name) => {
      await page.locator('[role="tree"] section[data-flip-key^="project:"] > [data-drag-image] > button', { hasText: name }).first().click();
      await page.waitForTimeout(700);
    };
    const sidebar = async (file) => {
      await page.mouse.move(900, 600);
      await page.waitForTimeout(400);
      const box = await page.locator('[data-sidebar="sidebar"]').first().boundingBox();
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-sidebar="sidebar"] *')) if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = 0;
      });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, file), clip: { x: 0, y: 0, width: Math.ceil(box.x + box.width) + 1, height: 1180 } });
    };
    // Strip: Gemini on (real quota through agy), Kimi off when it has no numbers yet.
    await page.locator(".lp-seg").first().click();
    await page.locator(".lp-gear").first().click();
    await page.waitForTimeout(800);
    log("strip settings rows:", JSON.stringify(await page.locator(".lp-check").allInnerTexts()));
    const kimi = page.locator(".lp-check", { hasText: /kimi/i }).locator("input");
    if ((await kimi.count()) > 0 && (await kimi.first().isChecked())) await kimi.first().uncheck();
    await page.locator(".lp-check", { hasText: "Gemini" }).locator("input").check();
    await page.keyboard.press("Escape");
    for (let i = 0; i < 30; i++) {
      const gem = await page.locator('.lp-seg[data-section="gemini"]').textContent().catch(() => "");
      if (/\d+%/.test(gem ?? "")) break;
      await page.waitForTimeout(1000);
    }
  // Working: a long answer, started right before the screenshots.
    const LONG = "Write a detailed 3000-word design document on moving cron jobs to a job queue, with sections and examples. Do not use any tools.";
    ids.working = (await spawn("web-app", "Move cron jobs to a queue", LONG, ["--permission-mode", "accept-edits"])).id;

    await page.waitForTimeout(7000);
    for (const name of ["docs", "infra"]) await fold(name);
    await sidebar("sidebar-open.png");
    // Cover: Needs you folded so the New thread button, search and the cards fit together.
    const needsYou = page.locator("[data-needs-you] button[aria-expanded]").first();
    if ((await needsYou.count()) > 0) {
      await needsYou.click();
      await page.waitForTimeout(600);
      // The desktop app draws back/forward in the window title bar; a browser tab puts them next to
      // the New thread button. The cover shows the desktop layout, so hide them for this shot only.
      const arrows = await page.addStyleTag({ content: '[data-testid="app-sidebar-top-reserve-row"] div:has(> button[aria-label^="Go back"]){display:none!important}' });
      await page.waitForTimeout(600);
      await sidebar("sidebar-cover.png");
      await arrows.evaluate((el) => el.remove());
      await needsYou.click();
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: join(OUT, "window-open.png") });
    await fold("web-app");
    for (const name of ["api", "mobile"]) await fold(name);
    await sidebar("sidebar-collapsed.png");
    await fold("web-app");
    // Limits popover over the strip.
    await page.locator(".lp-seg").first().click();
    await page.waitForTimeout(1500);
    await sidebar("sidebar-limits.png");
    await page.keyboard.press("Escape");
    log(`screenshots in ${OUT}`);
  } finally {
    await browser.close();
  }
} finally {
  await bb.stop();
  if (!process.env.BB_E2E_KEEP) cleanup(bb.dir);
}
