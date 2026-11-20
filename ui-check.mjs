import { chromium } from "playwright";

const app = "http://localhost:8000";
const auth = (process.env.NEON_AUTH_BASE_URL || "").replace(/\/$/, "");
const fn = (process.env.VITE_NEON_SYNC_URL || "").replace(/\/$/, "");
const stamp = Date.now();
const password = "Knomad-UI-12345!";
const mainEmail = `knomad-ui-main-${stamp}@example.com`;
const friendEmail = `knomad-ui-friend-${stamp}@example.com`;
const mainName = "Knomad UI Main";
const friendName = "Knomad UI Friend";

if (!auth || !fn) throw new Error("NEON_AUTH_BASE_URL or VITE_NEON_SYNC_URL missing");

function cookieHeader(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return list.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function signUp(email, name) {
  const created = await json(auth + "/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app },
    body: JSON.stringify({ email, password, name }),
  });
  if (!created.response.ok) throw new Error("sign-up failed: " + JSON.stringify(created.body));
}

async function jwtFor(email) {
  const signedIn = await json(auth + "/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app },
    body: JSON.stringify({ email, password }),
  });
  if (!signedIn.response.ok) throw new Error("sign-in failed: " + JSON.stringify(signedIn.body));
  const cookies = cookieHeader(signedIn.response);
  const token = await json(auth + "/token", {
    headers: { Origin: app, ...(cookies ? { Cookie: cookies } : {}) },
  });
  const jwt = token.body?.token || signedIn.response.headers.get("set-auth-jwt") || "";
  if (!jwt) throw new Error("no JWT: " + JSON.stringify(token.body));
  return jwt;
}

async function api(path, jwt, options = {}) {
  return json(fn + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + jwt,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
}

async function makeFriends(mainJwt, friendJwt, email) {
  await api("/friends/request", mainJwt, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  const social = await api("/social", friendJwt);
  const requestId = social.body?.incoming?.[0]?.id;
  if (!requestId) throw new Error("friend request not found: " + JSON.stringify(social.body));
  const accepted = await api("/friends/respond", friendJwt, {
    method: "POST",
    body: JSON.stringify({ requestId, action: "accept" }),
  });
  if (!accepted.response.ok) throw new Error("friend accept failed: " + JSON.stringify(accepted.body));
}

function localInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" + pad(date.getMonth() + 1) +
    "-" + pad(date.getDate()) +
    "T" + pad(date.getHours()) +
    ":" + pad(date.getMinutes())
  );
}

function check(condition, label) {
  if (!condition) throw new Error("CHECK FAILED: " + label);
  console.log("ok - " + label);
}

async function signIn(page, email) {
  await page.goto(app, { waitUntil: "domcontentloaded" });
  await page.click('[data-page="settings"]');
  await page.fill("#accountEmail", email);
  await page.fill("#accountPassword", password);
  await page.click("#accountSignInBtn");
  await page.waitForSelector("#accountSignedIn:not([hidden])", { timeout: 45000 });
  await page.waitForFunction(
    () => (document.querySelector("#accountEmailLabel")?.textContent || "").includes("@"),
    null,
    { timeout: 45000 },
  );
}

async function openTogether(page) {
  await page.click('[data-page="together"]');
  await page.waitForSelector("#togetherSignedIn:not([hidden])", { timeout: 30000 });
  await page.waitForFunction(
    () => (document.querySelector("#togetherSummary")?.textContent || "").length > 0,
    null,
    { timeout: 30000 },
  );
}

let mainJwt = "";
let friendJwt = "";
let browser = null;
const failures = [];

try {
  await signUp(mainEmail, mainName);
  await signUp(friendEmail, friendName);
  mainJwt = await jwtFor(mainEmail);
  friendJwt = await jwtFor(friendEmail);
  await makeFriends(mainJwt, friendJwt, friendEmail);
  console.log("ok - accounts and friendship created");

  browser = await chromium.launch({ headless: true });
  const mainContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const mainPage = await mainContext.newPage();
  mainPage.on("dialog", (dialog) => dialog.accept());
  mainPage.on("pageerror", (err) => console.log("main page error:", err.message));
  globalThis.__pages = { main: mainPage };

  await signIn(mainPage, mainEmail);
  console.log("ok - main account signed in");

  await openTogether(mainPage);
  await mainPage.waitForSelector('#togetherScope option[value="me"]', { state: "attached", timeout: 30000 });

  // Personal list and task.
  await mainPage.fill("#newListName", "UI personal list");
  await mainPage.click("#newListForm button[type=submit]");
  await mainPage.waitForSelector('.space-list-name:text-is("UI personal list")', { timeout: 20000 });
  check(true, "personal list created");

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await mainPage.fill("#taskTitle", "UI personal task");
  await mainPage.selectOption("#taskListSelect", { label: "UI personal list" });
  await mainPage.fill("#taskDue", localInput(tomorrow));
  await mainPage.click("#newTaskForm button[type=submit]");
  await mainPage.waitForSelector('.space-task:has-text("UI personal task")', { timeout: 20000 });
  check(true, "personal task created");

  // Calendar merge.
  await mainPage.click('[data-page="calendar"]');
  await mainPage.waitForSelector('.event-row-button:has-text("UI personal task")', { timeout: 20000 });
  check(true, "personal task appears on the calendar");

  const personalRow = mainPage.locator('.event-row', { hasText: "UI personal task" }).first();
  await personalRow.locator('[data-cal-task-done]').click();
  await mainPage.waitForTimeout(1500);
  await openTogether(mainPage);
  await mainPage.waitForSelector('.space-task.is-done:has-text("UI personal task")', { timeout: 20000 });
  check(true, "task completion from the calendar reaches Together");

  // Circle.
  await mainPage.click("#newCircleBtn");
  await mainPage.waitForSelector("#circleModal:not([hidden])", { timeout: 10000 });
  await mainPage.fill("#circleName", "UI circle");
  await mainPage.click("#circleCreateBtn");
  await mainPage.waitForSelector('#togetherScope option:text-is("UI circle")', { state: "attached", timeout: 20000 });
  await mainPage.waitForSelector("#circleCard:not([hidden])", { timeout: 20000 });
  await mainPage.waitForFunction(
    () => (document.querySelector("#circleTitle")?.textContent || "") === "UI circle",
    null,
    { timeout: 20000 },
  );
  check(true, "circle created and selected");

  await mainPage.waitForSelector("#circleAddSelect option", { state: "attached", timeout: 30000 });
  const friendOption = await mainPage
    .locator("#circleAddSelect option")
    .filter({ hasText: "Knomad UI Friend" })
    .first()
    .getAttribute("value");
  if (!friendOption) throw new Error("friend missing from circle add select");
  await mainPage.selectOption("#circleAddSelect", friendOption);
  await mainPage.click('#circleAddForm button[type="submit"]');
  await mainPage.waitForSelector('#circleMembers .social-person:has-text("Knomad UI Friend")', {
    timeout: 20000,
  });
  check(true, "kniggur added to the circle");

  const sharedDue = new Date(Date.now() + 26 * 60 * 60 * 1000);
  await mainPage.fill("#taskTitle", "UI shared task");
  await mainPage.fill("#taskDue", localInput(sharedDue));
  await mainPage.click("#newTaskForm button[type=submit]");
  await mainPage.waitForSelector('.space-task:has-text("UI shared task")', { timeout: 20000 });
  const sharedChip = await mainPage
    .locator(".space-task", { hasText: "UI shared task" })
    .locator(".task-circle-chip")
    .textContent();
  check(sharedChip === "UI circle", "shared task carries the circle chip");

  // Friend sees and completes the shared task.
  const friendContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const friendPage = await friendContext.newPage();
  friendPage.on("dialog", (dialog) => dialog.accept());
  friendPage.on("pageerror", (err) => console.log("friend page error:", err.message));
  globalThis.__pages.friend = friendPage;

  await signIn(friendPage, friendEmail);
  await openTogether(friendPage);
  await friendPage.waitForSelector('#togetherScope option:text-is("UI circle")', { state: "attached", timeout: 30000 });
  await friendPage.selectOption("#togetherScope", { label: "UI circle" });
  await friendPage.waitForSelector('.space-task:has-text("UI shared task")', { timeout: 20000 });
  check(true, "friend sees the shared task");

  const sharedRow = friendPage.locator(".space-task", { hasText: "UI shared task" }).first();
  await sharedRow.locator("[data-task-toggle]").click();
  await friendPage.waitForSelector('.space-task.is-done:has-text("UI shared task")', { timeout: 20000 });
  check(true, "friend completes the shared task");

  // Friend calendar source filter.
  await friendPage.click('[data-page="calendar"]');
  await friendPage.waitForSelector('#calScopeFilter option:text-is("UI circle")', { state: "attached", timeout: 20000 });
  await friendPage.selectOption("#calScopeFilter", { label: "UI circle" });
  await friendPage.waitForSelector('.event-row-button:has-text("UI shared task")', { timeout: 20000 });
  check(true, "circle filter shows the shared task on the calendar");

  // Main sees the friend's completion after a refresh.
  await openTogether(mainPage);
  await mainPage.click("#togetherRefreshBtn");
  await mainPage.waitForSelector('.space-task.is-done:has-text("UI shared task")', { timeout: 30000 });
  check(true, "main sees the friend's completion after refresh");

  // Archive the circle through the UI.
  await mainPage.click("#circleExitBtn");
  await mainPage.waitForFunction(
    () => document.querySelector("#circleCard")?.hidden === true,
    null,
    { timeout: 20000 },
  );
  check(true, "circle archived from the UI");
} catch (error) {
  failures.push(error);
  console.error(error.stack || error.message);
  for (const [label, page] of Object.entries(globalThis.__pages || {})) {
    try {
      console.log(label, "url:", page.url());
      console.log(label, "toast:", await page.locator("#toastHost").textContent());
      console.log(label, "tasks:", (await page.locator("#spaceTasks").textContent()).slice(0, 300));
      console.log(label, "summary:", await page.locator("#togetherSummary").textContent());
      await page.screenshot({ path: `C:/Users/epaul/AppData/Local/Temp/opencode/knomad-${label}-${stamp}.png` });
    } catch {}
  }
} finally {
  if (browser) await browser.close();
  try {
    if (mainJwt) {
      const space = await api("/space", mainJwt);
      const circle = (space.body?.circles || []).find((entry) => entry.name === "UI circle");
      if (circle) await api("/circles/" + encodeURIComponent(circle.id), mainJwt, { method: "DELETE" });
      const fresh = await api("/space", mainJwt);
      for (const task of fresh.body?.tasks || []) {
        await api("/tasks/" + encodeURIComponent(task.id), mainJwt, {
          method: "DELETE",
          body: JSON.stringify({ version: task.version }),
        });
      }
      for (const list of fresh.body?.taskLists || []) {
        await api("/task-lists/" + encodeURIComponent(list.id), mainJwt, {
          method: "DELETE",
          body: JSON.stringify({ version: list.version }),
        });
      }
    }
    if (mainJwt && friendJwt) {
      const friendMe = await api("/me", friendJwt);
      const friendId = friendMe.body?.userId;
      if (friendId) await api("/friends/" + encodeURIComponent(friendId), mainJwt, { method: "DELETE" });
    }
  } catch (cleanupError) {
    console.warn("cleanup warning:", cleanupError.message);
  }
  if (failures.length) process.exitCode = 1;
}
