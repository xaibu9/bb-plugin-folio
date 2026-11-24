import { createRequire } from "node:module";
const require = createRequire(process.env.HOME + "/.claude/skills/web-browser/package.json");
const { chromium } = require("playwright-core");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
for (const [src, out] of [["sidebar", process.argv[2]], ["limits", process.argv[3]]]) {
  await page.goto(`file:///tmp/covers/${src}.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: out });
}
await browser.close();
