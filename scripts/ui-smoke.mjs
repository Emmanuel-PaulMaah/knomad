/**
 * Browser smoke test for the local app shell.
 * Usage: node scripts/ui-smoke.mjs   (dev server must be on http://localhost:8000)
 */
import { chromium } from "playwright";

const origin = process.env.KNOMAD_ORIGIN || "http://localhost:8000";
const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push("console: " + msg.text());
});

await page.goto(origin, { waitUntil: "networkidle" });

const checks = {};
checks.title = await page.title();
checks.dashboardVisible = await page.isVisible("#dashboardPage.active");
checks.railButtons = await page.locator(".rail-btn").count();

await page.click('[data-page="settings"]');
await page.waitForTimeout(300);
checks.settingsVisible = await page.isVisible("#settingsPage.active");
checks.accountCard = await page.isVisible("#accountCard");
checks.accountIntro = (await page.textContent("#accountIntro"))?.trim().slice(0, 80);
checks.badge = (await page.textContent("#accountBadge"))?.trim();
checks.signedOutVisible = await page.isVisible("#accountSignedOut");
checks.configured = checks.signedOutVisible;

if (checks.signedOutVisible) {
  await page.fill("#accountEmail", "smoke@example.com");
  await page.fill("#accountPassword", "not-a-real-password");
  checks.signInEnabled = await page.isEnabled("#accountSignInBtn");
}

await browser.close();

console.log(JSON.stringify({ checks, errors }, null, 2));
if (errors.length) process.exitCode = 1;
