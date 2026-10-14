const { chromium } = require("../frontend/node_modules/playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const root = path.resolve(__dirname, "..");
const id = "4613eeb7-7064-41da-bb06-62630b3eaebc";
const draft = {
  title: "Synthetic browser case",
  vignette: "Synthetic fever and cough.",
  symptoms: ["Fever"],
  age_years: null,
};
const clinicalCase = { ...draft, id, revision: 1, created_at: "2026-10-08T12:00:00Z" };
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

(async () => {
  let requests = 0;
  let caseFetches = 0;
  let healthy = false;
  let catalogEmpty = false;
  let latestAccountScore = 100;
  let holdCatalog = false;
  let releaseCatalog;
  const catalogRequests = [];
  const account = { id: "11111111-1111-4111-8111-111111111111", username: "browser_learner" };
  const api = http.createServer(async (req, res) => {
    requests++;
    const requestPath = new URL(req.url, "http://localhost").pathname;
    const searchParams = new URL(req.url, "http://localhost").searchParams;
    if (requestPath.endsWith("/management")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ can_edit: false, can_hide: false, can_restore: false })); return; }
    if (requestPath.endsWith("/attempts") && req.method === "POST") {
      latestAccountScore = 0;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ score: 0, max_score: 100, is_correct: false, feedback: "Incorrect synthetic answer.", accepted_diagnoses: ["Influenza", "Flu"], matched_alternative_diagnoses: [] })); return;
    }
    if (requestPath.startsWith("/api/v1/auth/") || requestPath === "/api/v1/profile") {
      const authenticated = req.headers.authorization === "Bearer browser-private-session";
      const result = requestPath.endsWith("/login") || requestPath.endsWith("/register")
        ? { user: account, session_token: "browser-private-session" }
        : requestPath.endsWith("/logout") ? { signed_out: true }
        : requestPath === "/api/v1/profile" ? { user: account, attempt_count: 2, correct_count: 1, incorrect_count: 1, points: 100, attempts: [{ id: "attempt", clinical_case_id: id, title: draft.title, case_updated: false, case_snapshot: { ...draft, revision: 1, accepted_diagnoses: ["Influenza", "Flu"] }, archived: false, diagnosis: "Influenza", alternative_diagnoses: ["Cold"], reasoning: "Synthetic explanation", score: 100, is_correct: true, created_at: "2026-10-08T12:00:00Z" }], has_more: false, cases: [], cases_has_more: false }
        : { user: authenticated ? account : null };
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); return;
    }
    if (requestPath === `/api/v1/clinical-cases/${id}`) caseFetches++;
    if (requestPath === "/api/v1/clinical-cases") {
      catalogRequests.push({ page: searchParams.get("page"), q: searchParams.get("q"), answered: searchParams.get("answered") });
    }
    if (holdCatalog && requestPath === "/api/v1/clinical-cases")
      await new Promise((resolve) => { releaseCatalog = resolve; });
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        healthy
          ? (requestPath === "/api/v1/auth/me" ? { user: null } : requestPath === "/api/v1/clinical-cases"
            ? {
                items: catalogEmpty || searchParams.get("q") === "no-such-case" ? [] : [{ ...clinicalCase, latest_score: req.headers.authorization ? latestAccountScore : null }],
                has_more: !catalogEmpty && searchParams.get("q") !== "no-such-case" && searchParams.get("page") === "1",
              }
            : clinicalCase)
          : { error: { message: "Temporary test failure." } },
      ),
    );
  });
  const apiPort = await listen(api);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--port",
      String(port),
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: path.join(root, "frontend"),
      env: { ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${apiPort}` },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  server.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  server.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  let browser;
  try {
    for (let n = 0; n < 100; n++) {
      if (server.exitCode !== null) throw new Error(logs);
      try {
        if ((await fetch(origin)).ok) break;
      } catch {}
      if (n === 99)
        throw new Error("Test production server did not become ready.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({
      ...(process.env.PLAYWRIGHT_CHANNEL === "chromium" ? {} : { channel: "chrome" }),
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/clinical-cases/${id}`);
    await page.getByTestId("case-load-retry").filter({ visible: true }).waitFor();
    const failedRequests = requests;
    const failedCaseFetches = caseFetches;
    assert(failedRequests > 0);
    healthy = true;
    await page.getByTestId("case-load-retry").filter({ visible: true }).click();
    await page.getByTestId("case-title").filter({ visible: true }).filter({ visible: true }).waitFor();
    const iconHref = await page.locator('link[rel="icon"]').getAttribute("href");
    assert(iconHref, "Every page must link to its favicon");
    const icon = await page.request.get(new URL(iconHref, origin).href);
    assert.equal(icon.status(), 200);
    assert(icon.headers()["content-type"].includes("image/svg+xml"));
    assert(
      requests > failedRequests,
      "Retry must issue a new server-side API request.",
    );
    assert.equal(caseFetches - failedCaseFetches, 1, "Case content and metadata share one API response.");
    assert.equal(
      await page.getByTestId("case-title").filter({ visible: true }).filter({ visible: true }).textContent(),
      draft.title,
    );
    assert.equal(await page.title(), `${draft.title} · Clinical Cases`);
    assert.equal(await page.getByTestId("nav-all-cases").filter({ visible: true }).getAttribute("aria-current"), "page");
    // The deliberately failed Server Component reports an expected production error.
    errors.length = 0;
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [route, section] of [
        ["/", ".hero"],
        ["/clinical-cases", '[data-testid="case-catalog"]'],
        ["/clinical-cases/new", ".page-heading"],
        [`/clinical-cases/${id}`, '[data-testid="case-page"]'],
        ["/analytics", ".page-heading"],
      ]) {
        await page.goto(`${origin}${route}`);
        await page.locator(section).waitFor();
        const bounds = await page.locator(section).evaluate((element) => {
          const main = document.querySelector(".main-shell");
          const shell = main.getBoundingClientRect();
          const padding = getComputedStyle(main);
          const content = element.getBoundingClientRect();
          return {
            left: content.left,
            right: content.right,
            expectedLeft: shell.left + parseFloat(padding.paddingLeft),
            expectedRight: shell.right - parseFloat(padding.paddingRight),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert(Math.abs(bounds.left - bounds.expectedLeft) < 1, `${route} left edge at ${width}px`);
        assert(Math.abs(bounds.right - bounds.expectedRight) < 1, `${route} right edge at ${width}px`);
        assert.equal(bounds.overflow, false, `${route} overflow at ${width}px`);
      }
    }

    await page.getByTestId("nav-home-link").filter({ visible: true }).click();
    await page.waitForURL(`${origin}/`);
    assert.equal(await page.getByTestId("nav-home-link").filter({ visible: true }).getAttribute("aria-current"), "page");
    const docs = page.getByTestId("nav-docs").filter({ visible: true });
    const docsUrl = await docs.getAttribute("href");
    assert.equal(typeof docsUrl, "string");
    assert.equal(new URL(docsUrl).pathname, "/docs");
    assert.equal(await docs.getAttribute("target"), "_blank");
    assert.deepEqual(new Set((await docs.getAttribute("rel")).split(/\s+/)), new Set(["noopener", "noreferrer"]));
    assert(await docs.locator("svg").isVisible(), "Docs shows the external-link icon.");
    await page.context().route(docsUrl, (route) => route.fulfill({
      contentType: "text/html", body: "<title>Test API docs</title><h1>API docs</h1>",
    }));
    const popupPromise = page.waitForEvent("popup");
    await docs.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), docsUrl);
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.equal(page.url(), `${origin}/`, "Docs leaves the application tab intact.");
    await popup.close();
    await page.context().unroute(docsUrl);
    assert.equal(await page.getByTestId("footer-github").filter({ visible: true }).getAttribute("href"), "https://github.com/NKolosov097");
    await page.getByTestId("nav-all-cases").filter({ visible: true }).click();
    await page.getByTestId("case-catalog").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("nav-all-cases").filter({ visible: true }).getAttribute("aria-current"), "page");
    await page.getByRole("link", { name: "Next page", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("page") === "2");
    const liveSearch = page.getByRole("searchbox", { name: "Search titles and descriptions" });
    assert.equal(await page.getByRole("button", { name: "Search", exact: true }).count(), 0, "Search is automatic and has no submit button.");
    // Next may keep an RSC response streaming after the visible results commit.
    const waitForSearchResults = (query) => page.waitForFunction(expectedQuery =>
      [...document.querySelectorAll("a")].some(link =>
        link.textContent.trim() === "Next page" && link.getClientRects().length > 0 &&
        new URL(link.href).searchParams.get("q") === expectedQuery), query);
    await liveSearch.fill("dry");
    await page.waitForURL(url => url.pathname === "/clinical-cases" && url.searchParams.get("q") === "dry");
    await waitForSearchResults("dry");
    assert(await liveSearch.evaluate(element => document.activeElement === element && element.selectionStart === 3 && element.selectionEnd === 3), "Search keeps focus and caret after a debounced response.");
    await liveSearch.pressSequentially(" cough");
    await page.waitForURL(url => url.pathname === "/clinical-cases" && url.searchParams.get("q") === "dry cough");
    await waitForSearchResults("dry cough");
    assert.equal(await liveSearch.inputValue(), "dry cough", "Typing can continue after the previous search settles.");
    assert(await liveSearch.evaluate(element => document.activeElement === element && element.selectionStart === 9 && element.selectionEnd === 9), "A second debounced response also preserves caret and focus.");
    assert.deepEqual(catalogRequests.at(-1), { page: "1", q: "dry cough", answered: "all" }, "Search starts on page one and reaches the API.");
    const nextSearchPage = new URL(await page.getByRole("link", { name: "Next page", exact: true }).getAttribute("href"), origin);
    assert.equal(nextSearchPage.searchParams.get("q"), "dry cough");
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Search fits mobile width.");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("link", { name: "Next page", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("page") === "2" && url.searchParams.get("q") === "dry cough");
    await page.getByRole("link", { name: "Previous page", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("page") === "1" && url.searchParams.get("q") === "dry cough");
    await liveSearch.fill("no-such-case");
    await page.getByTestId("catalog-search-empty").filter({ visible: true }).waitFor();
    await page.goBack();
    await page.waitForURL(url => url.searchParams.get("q") === "dry cough");
    assert.equal(await liveSearch.inputValue(), "dry cough", "Back synchronizes the search input with the URL.");
    await page.goForward();
    await page.waitForURL(url => url.searchParams.get("q") === "no-such-case");
    assert.equal(await liveSearch.inputValue(), "no-such-case", "Forward restores the later search query.");
    await page.getByRole("link", { name: "Clear search", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/clinical-cases" && !url.searchParams.has("q"));
    await page.getByTestId("catalog-case").filter({ visible: true }).waitFor();
    await page.getByTestId("nav-create-case").filter({ visible: true }).click();
    await page.getByTestId("author-source-text").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("nav-create-case").filter({ visible: true }).getAttribute("aria-current"), "page");
    await page.getByTestId("nav-home").filter({ visible: true }).click();
    await page.waitForURL(`${origin}/`);
    await page.getByTestId("nav-all-cases").filter({ visible: true }).click();
    await page.getByRole("link", { name: draft.title, exact: true }).click();
    await page.getByTestId("case-title").filter({ visible: true }).filter({ visible: true }).waitFor();

    const browserRequests = [];
    let attemptUnavailable = false;
    let analyticsUnavailable = false;
    let holdAnalytics = false;
    let releaseAnalytics;
    let signalAnalyticsRouteEntered;
    let holdExtraction = false;
    let releaseExtraction;
    await page.route("**/api/backend/**", async (route) => {
      const request = route.request();
      browserRequests.push({
        path: new URL(request.url()).pathname,
        url: request.url(),
        headers: request.headers(),
        body: request.method() === "POST" ? request.postDataJSON() : undefined,
      });
      let body = request.url().endsWith("/auth/me") ? { user: null } : request.url().endsWith("/auth/login") ? account : clinicalCase;
      let status = 200;
      if (request.url().includes("/api/backend/analytics")) {
        if (holdAnalytics) {
          signalAnalyticsRouteEntered?.();
          await new Promise((resolve) => { releaseAnalytics = resolve; });
        }
        body = analyticsUnavailable
          ? { error: { message: "A valid author key is required." } }
          : { days: Number(new URL(request.url()).searchParams.get("days")),
              start_at: "2026-10-01T12:00:00Z", end_at: "2026-10-08T12:00:00Z",
              case_count: 4, attempt_count: 3, correct_attempt_count: 1, correct_percentage: 33.3 };
        status = analyticsUnavailable ? 401 : 200;
      }
      if (request.url().endsWith("/extract")) {
        if (holdExtraction) await new Promise((resolve) => { releaseExtraction = resolve; });
        body = { draft, warnings: [] };
      }
      if (request.url().endsWith("/management")) body = { can_edit: false, can_hide: false, can_restore: false };
      const isAttempt = request.url().endsWith("/attempts");
      if (isAttempt) assert.equal(request.postDataJSON().case_revision, clinicalCase.revision);
      if (isAttempt) {
        const correct = request.postDataJSON().diagnosis.trim().toLowerCase() !== "unrelated diagnosis";
        body = attemptUnavailable
          ? { error: { message: "Synthetic service unavailable." } }
          : { score: correct ? 100 : 0, max_score: 100, is_correct: correct,
              accepted_diagnoses: ["Influenza", "Flu"], matched_alternative_diagnoses: [], feedback: correct ? "Accepted synthetic answer." : "Incorrect synthetic answer." };
      }
      await route.fulfill({
        status: isAttempt && attemptUnavailable ? 503 : status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await page.getByTestId("nav-analytics").filter({ visible: true }).click();
    await page.getByTestId("analytics-initial").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("nav-analytics").filter({ visible: true }).getAttribute("aria-current"), "page");
    assert.equal(await page.getByTestId("analytics-cards").filter({ visible: true }).count(), 0, "The public analytics page starts without metrics.");
    assert.equal(await page.getByTestId("analytics-key").filter({ visible: true }).getAttribute("type"), "password");
    await page.getByTestId("analytics-key").filter({ visible: true }).fill("browser-only-author-key");
    const analyticsRouteEntered = new Promise((resolve) => { signalAnalyticsRouteEntered = resolve; });
    holdAnalytics = true;
    await page.getByTestId("analytics-load").filter({ visible: true }).click();
    await page.getByTestId("analytics-skeletons").filter({ visible: true }).waitFor();
    await analyticsRouteEntered;
    assert.equal(await page.getByTestId("analytics-skeletons").filter({ visible: true }).locator(".analytics-card").count(), 3);
    assert.equal(await page.getByTestId("analytics-key").filter({ visible: true }).isDisabled(), true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".analytics-value-skeleton").first().evaluate((el) => getComputedStyle(el).animationName), "none");
    holdAnalytics = false;
    releaseAnalytics?.();
    await page.getByTestId("analytics-cards").filter({ visible: true }).waitFor();
    const analyticsRequest = browserRequests.find((item) => item.path === "/api/backend/analytics");
    assert(analyticsRequest);
    assert.equal(new URL(analyticsRequest.url).searchParams.get("days"), "30");
    assert.equal(analyticsRequest.headers["x-author-key"], "browser-only-author-key");
    assert.equal(new URL(page.url()).pathname, "/analytics", "The key never appears in the URL.");
    assert.equal(await page.evaluate(() => localStorage.length), 0, "The key is not persisted in local storage.");
    assert.equal(await page.getByTestId("analytics-period-note").filter({ visible: true }).textContent().then((text) => text.includes("Repeated submissions count as separate attempts.")), true);
    await page.getByTestId("analytics-days").filter({ visible: true }).selectOption("7");
    await page.getByTestId("analytics-initial").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("analytics-cards").filter({ visible: true }).count(), 0, "Changing period clears previously loaded metrics.");
    analyticsUnavailable = true;
    await page.getByTestId("analytics-load").filter({ visible: true }).click();
    await page.getByTestId("analytics-error").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("analytics-cards").filter({ visible: true }).count(), 0, "Failures leave no stale results visible.");
    analyticsUnavailable = false;
    await page.getByTestId("analytics-load").filter({ visible: true }).click();
    await page.getByTestId("analytics-cards").filter({ visible: true }).waitFor();
    await page.goto(`${origin}/clinical-cases/${id}`);
    await page.getByTestId("case-title").filter({ visible: true }).filter({ visible: true }).waitFor();
    await page.getByRole("checkbox", { name: "I understand and want to submit as a guest." }).check();
    await page.getByTestId("attempt-diagnosis").filter({ visible: true }).fill("   ");
    await page.getByTestId("attempt-submit").filter({ visible: true }).click();
    await page.getByTestId("attempt-error").filter({ visible: true }).waitFor();
    assert.equal(browserRequests.filter((item) => item.path.endsWith("/attempts")).length, 0, "Invalid answers never reach the API.");
    assert.equal(await page.getByTestId("attempt-diagnosis").filter({ visible: true }).getAttribute("aria-invalid"), "true");
    for (const [answer, title, score] of [
      ["  FLU  ", "Accepted diagnosis", "100 / 100"],
      ["Unrelated diagnosis", "Keep thinking", "0 / 100"],
    ]) {
      await page.getByTestId("attempt-diagnosis").filter({ visible: true }).fill(answer);
      assert.equal(await page.getByTestId("attempt-result").filter({ visible: true }).count(), 0, "Editing clears stale feedback.");
      await page.getByTestId("attempt-submit").filter({ visible: true }).click();
      await page.getByTestId("attempt-result").filter({ visible: true }).waitFor();
      assert.equal(await page.getByTestId("attempt-result-title").filter({ visible: true }).textContent(), title);
      assert.equal(await page.getByTestId("attempt-score").filter({ visible: true }).textContent(), score);
      assert.equal(browserRequests.at(-1).body.diagnosis, answer);
    }
    attemptUnavailable = true;
    await page.getByTestId("attempt-diagnosis").filter({ visible: true }).fill("Influenza");
    await page.getByTestId("attempt-submit").filter({ visible: true }).click();
    await page.getByTestId("attempt-error").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("attempt-error").filter({ visible: true }).textContent(), "Synthetic service unavailable.");
    assert.equal(await page.getByTestId("attempt-diagnosis").filter({ visible: true }).inputValue(), "Influenza");
    assert(await page.getByTestId("attempt-submit").filter({ visible: true }).isEnabled());
    attemptUnavailable = false;
    const emoji = String.fromCodePoint(0x1f600);
    await page.getByTestId("attempt-diagnosis").filter({ visible: true }).fill(` ${emoji.repeat(200)} `);
    await page.getByTestId("attempt-diagnosis").filter({ visible: true }).press("Enter");
    await page.getByTestId("attempt-result").filter({ visible: true }).waitFor();
    assert.equal([...browserRequests.at(-1).body.diagnosis.trim()].length, 200);
    await page.goto(`${origin}/clinical-cases/new`);
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-testid"),
      ),
      "skip-to-content",
    );
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "main");
    await page.getByTestId("author-key").filter({ visible: true }).fill("memory-only-key");
    await page.getByTestId("nav-all-cases").filter({ visible: true }).click();
    await page.getByTestId("case-catalog").filter({ visible: true }).waitFor();
    await page.getByTestId("nav-create-case").filter({ visible: true }).click();
    await page.getByTestId("author-source-text").filter({ visible: true }).waitFor();
    await page.getByTestId("author-source-text").filter({ visible: true }).fill("A synthetic patient has fever and cough.");
    let leaveDialogMessage = "";
    page.once("dialog", async (dialog) => {
      leaveDialogMessage = dialog.message();
      await dialog.dismiss();
    });
    await page.getByTestId("nav-all-cases").filter({ visible: true }).click();
    assert.equal(leaveDialogMessage, "This case draft has not been saved. Leave this page and discard your changes?");
    assert.equal(new URL(page.url()).pathname, "/clinical-cases/new", "Cancel keeps the author form open.");
    assert.equal(await page.getByTestId("author-source-text").filter({ visible: true }).inputValue(), "A synthetic patient has fever and cough.");
    const dirtyDocsUrl = await page.getByTestId("nav-docs").filter({ visible: true }).getAttribute("href");
    await page.context().route(dirtyDocsUrl, (route) => route.fulfill({
      contentType: "text/html", body: "<title>Test API docs</title><h1>API docs</h1>",
    }));
    const dirtyDocsPopup = page.waitForEvent("popup");
    await page.getByTestId("nav-docs").filter({ visible: true }).click();
    const docsPopup = await dirtyDocsPopup;
    await docsPopup.waitForLoadState();
    await docsPopup.close();
    await page.context().unroute(dirtyDocsUrl);
    await page.getByTestId("skip-to-content").filter({ visible: true }).focus();
    await page.getByTestId("skip-to-content").filter({ visible: true }).click();
    assert.equal(new URL(page.url()).hash, "#main", "Same-page anchors do not warn.");
    const hashBack = page.waitForFunction(() => location.hash === "");
    await page.evaluate(() => history.back());
    await hashBack;
    const reloadPrompt = page.waitForEvent("dialog", { timeout: 10000 }).then(async (dialog) => {
      await dialog.dismiss();
      return dialog.type();
    });
    await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
    assert.equal(await reloadPrompt, "beforeunload");
    assert.equal(await page.getByTestId("author-source-text").filter({ visible: true }).inputValue(), "A synthetic patient has fever and cough.");
    if (await page.evaluate(() => "navigation" in window)) {
      const backPrompt = page.waitForEvent("dialog", { timeout: 10000 }).then(async (dialog) => {
        await dialog.dismiss();
        return dialog.type();
      });
      await page.evaluate(() => history.back());
      assert.equal(await backPrompt, "confirm");
      assert.equal(new URL(page.url()).pathname, "/clinical-cases/new", "Canceling browser Back keeps the form open.");
    }
    page.once("dialog", async (dialog) => dialog.accept());
    await page.getByTestId("nav-all-cases").filter({ visible: true }).click();
    await page.getByTestId("case-catalog").filter({ visible: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/clinical-cases", "Accepting a leave prompt follows the link.");
    await page.getByTestId("nav-create-case").filter({ visible: true }).click();
    await page.getByTestId("author-source-text").filter({ visible: true }).waitFor();
    await page.getByTestId("author-key").filter({ visible: true }).fill("memory-only-key");
    await page.getByTestId("author-source-text").filter({ visible: true }).fill("Synthetic source retained through author sign-in.");
    const extractsBeforeLogin = browserRequests.filter(request => request.path.endsWith("/extract")).length;
    await page.getByTestId("author-extract-submit").filter({ visible: true }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(browserRequests.filter(request => request.path.endsWith("/extract")).length, extractsBeforeLogin);
    await page.getByLabel("Username", { exact: true }).fill("browser_learner");
    await page.getByLabel("Password", { exact: true }).fill("synthetic-password-123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(browserRequests.filter(request => request.path.endsWith("/extract")).length, extractsBeforeLogin, "Signing in never auto-extracts.");
    assert.equal(await page.getByTestId("author-source-text").filter({ visible: true }).inputValue(), "Synthetic source retained through author sign-in.");
    assert.equal(await page.getByRole("checkbox", { name: "I understand and want to submit as a guest." }).count(), 0);
    await page.getByTestId("author-source-text").filter({ visible: true }).fill(" ".repeat(20) + "short");
    await page.getByTestId("author-extract-submit").filter({ visible: true }).click();
    assert.equal(
      await page.getByTestId("author-source-text").filter({ visible: true }).getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "source-text",
    );
    await page.getByTestId("author-source-text").filter({ visible: true }).fill(emoji.repeat(20000));
    await page.getByTestId("author-extract-submit").filter({ visible: true }).click();
    await page.getByTestId("author-draft-title").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("author-review-confirmation").filter({ visible: true }).evaluate((el) => getComputedStyle(el).cursor), "pointer");
    assert.equal(await page.getByTestId("author-review-confirmation").filter({ visible: true }).locator("xpath=..").evaluate((el) => getComputedStyle(el).cursor), "pointer");
    assert.equal([...browserRequests.at(-1).body.source_text].length, 20000);
    assert.equal(await page.getByTestId("author-reference-diagnosis").filter({ visible: true }).inputValue(), "");
    await page.getByTestId("author-reference-diagnosis").filter({ visible: true }).fill("Influenza");
    await page.getByTestId("author-accepted-alternatives").filter({ visible: true }).fill("Flu");
    await page.getByTestId("author-draft-title").filter({ visible: true }).fill("Manual title");
    const beforeCancelledExtraction = browserRequests.length;
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByTestId("author-extract-submit").filter({ visible: true }).click();
    assert.equal(browserRequests.length, beforeCancelledExtraction, "Canceling re-extraction sends no request.");
    assert.equal(await page.getByTestId("author-draft-title").filter({ visible: true }).inputValue(), "Manual title");
    holdExtraction = true;
    await page.emulateMedia({ reducedMotion: "no-preference" });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("author-extract-submit").filter({ visible: true }).click();
    const extractButton = page.getByTestId("author-extract-submit").filter({ visible: true });
    await page.waitForFunction(() => document.querySelector('[data-testid="author-extract-submit"]')?.getAttribute("aria-busy") === "true");
    assert(await extractButton.isDisabled(), "Extraction disables its inputs while pending.");
    assert.equal(await page.locator(".source-panel button[aria-busy='true'] span").evaluate((el) => getComputedStyle(el).animationName), "extract-spin");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".source-panel button[aria-busy='true'] span").evaluate((el) => getComputedStyle(el).animationName), "none");
    assert.equal(await page.getByRole("status").last().textContent(), "Extracting draft…");
    assert.equal(await page.getByTestId("author-review-confirmation").filter({ visible: true }).isDisabled(), true);
    assert.equal(await page.getByTestId("author-review-confirmation").filter({ visible: true }).evaluate((el) => getComputedStyle(el).cursor), "not-allowed");
    holdExtraction = false;
    releaseExtraction?.();
    await page.getByTestId("author-answers-review-hint").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("author-draft-title").filter({ visible: true }).inputValue(), draft.title);
    assert.equal(await page.getByTestId("author-reference-diagnosis").filter({ visible: true }).inputValue(), "Influenza");
    assert.equal(await page.getByTestId("author-accepted-alternatives").filter({ visible: true }).inputValue(), "Flu");
    assert.equal(await page.getByTestId("author-review-confirmation").filter({ visible: true }).isChecked(), false);
    await page.getByTestId("author-reference-diagnosis").filter({ visible: true }).fill("Influenza");
    const beforeUnreviewedSave = browserRequests.length;
    assert(await page.getByTestId("author-save-submit").filter({ visible: true }).isDisabled(), "Saving requires explicit review.");
    assert.equal(browserRequests.length, beforeUnreviewedSave);
    await page.getByTestId("author-review-confirmation").filter({ visible: true }).check();
    await page.getByTestId("author-draft-title").filter({ visible: true }).fill("Edited synthetic case");
    assert.equal(await page.getByTestId("author-review-confirmation").filter({ visible: true }).isChecked(), false);
    for (const [selector, count] of [
      ["author-draft-title", 120],
      ["author-draft-vignette", 8000],
      ["author-reference-diagnosis", 200],
      ["author-draft-symptoms", 200],
      ["author-accepted-alternatives", 200],
    ]) {
      await page.getByTestId(selector).filter({ visible: true }).fill(` ${emoji.repeat(count)} `);
      assert.equal(
        await page.getByTestId(selector).filter({ visible: true }).getAttribute("maxlength"),
        null,
      );
    }
    await page.getByTestId("author-draft-title").filter({ visible: true }).fill(emoji.repeat(121));
    await page.getByTestId("author-review-confirmation").filter({ visible: true }).check();
    await page.getByTestId("author-save-submit").filter({ visible: true }).click();
    assert.equal(
      await page.getByTestId("author-draft-title").filter({ visible: true }).getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "case-title",
    );
    assert.equal(
      await page
        .getByTestId("author-draft-title")
        .getAttribute("aria-describedby"),
      "save-error",
    );
    await page.getByTestId("author-draft-title").filter({ visible: true }).fill(emoji.repeat(120));
    await page.getByTestId("author-review-confirmation").filter({ visible: true }).check();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `No overflow at ${width}px`,
      );
    }
    assert.equal(
      await page
        .getByTestId("author-save-submit")
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      "0s",
    );
    await page.getByTestId("author-save-submit").filter({ visible: true }).click();
    await page.waitForURL(`${origin}/clinical-cases/${id}`);
    await page.getByTestId("case-title").filter({ visible: true }).filter({ visible: true }).waitFor();
    const saved = browserRequests.find(
      (request) => request.path === "/api/backend/clinical-cases",
    ).body;
    assert.equal([...saved.title].length, 120);
    assert.equal([...saved.vignette.trim()].length, 8000);
    assert.equal([...saved.reference_diagnosis.trim()].length, 200);
    assert.equal([...saved.symptoms[0]].length, 200);
    assert.equal([...saved.accepted_answers[0]].length, 200);
    await page.unroute("**/api/backend/**");
    await page.getByTestId("case-back-home").filter({ visible: true }).click();
    await page.getByTestId("case-catalog").filter({ visible: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/clinical-cases");
    await page.getByRole("link", { name: "Next page", exact: true }).click();
    await page.waitForURL(`${origin}/clinical-cases?page=2&answered=all`);
    await page.getByRole("link", { name: "Previous page", exact: true }).click();
    await page.waitForURL(`${origin}/clinical-cases?page=1&answered=all`);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Catalog overflow at ${width}px`);
      for (const selector of ["nav-home-link", "nav-all-cases", "nav-create-case", "nav-analytics", "nav-docs", "footer-github"]) {
        assert(await page.getByTestId(selector).filter({ visible: true }).isVisible(), `${selector} visible at ${width}px`);
      }
    }
    await page.getByRole("link", { name: draft.title, exact: true }).click();
    await page.getByTestId("case-title").filter({ visible: true }).filter({ visible: true }).waitFor();
    holdCatalog = true;
    try {
      await page.goto(origin + "/clinical-cases?page=2", { waitUntil: "commit" });
      const loading = page.getByTestId("catalog-loading").filter({ visible: true });
      await loading.waitFor();
      assert.equal(await loading.locator("li").count(), 3);
      assert.equal(await loading.getByRole("status").textContent(), "Loading clinical cases...");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="catalog-loading"] .skeleton-line');
        return el ? getComputedStyle(el).animationName === "none" : false;
      });
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: path.join(root, `.local/catalog-loading-${width}.png`), fullPage: true });
      }
    } finally {
      holdCatalog = false;
      releaseCatalog?.();
    }
    await page.getByTestId("catalog-case").filter({ visible: true }).waitFor();
    assert.equal(await page.getByTestId("catalog-loading").filter({ visible: true }).count(), 0);
    catalogEmpty = true;
    await page.goto(`${origin}/clinical-cases`);
    await page.getByTestId("catalog-empty").filter({ visible: true }).waitFor();
    assert(await page.getByText("No cases have been saved yet.").isVisible());
    assert.deepEqual(errors, []);
    healthy = false;
    await page.reload();
    await page.getByRole("heading", { name: "Unable to load cases" }).waitFor();
    const failedCatalogRequests = requests;
    healthy = true;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByTestId("catalog-empty").filter({ visible: true }).waitFor();
    assert(requests > failedCatalogRequests);
    errors.length = 0; // Expected Server Component error from the injected 503.

    await page.goto(`${origin}/account`);
    await page.getByRole("button", { name: "Sign in / Register" }).click();
    await page.getByLabel("Username", { exact: true }).fill("browser_learner");
    await page.getByLabel("Password", { exact: true }).fill("synthetic-password-123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByTestId("account-dashboard").filter({ visible: true }).waitFor();
    await page.getByRole("heading", { name: "Answer history" }).waitFor();
    assert(await page.getByText("Synthetic explanation").isVisible());
    const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name === "clinical_session");
    assert(sessionCookie?.httpOnly && sessionCookie?.sameSite === "Lax", "Session uses an HttpOnly SameSite cookie.");
    assert(!(await page.evaluate(() => document.cookie)).includes("browser-private-session"), "Browser scripts cannot read the session.");
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    catalogEmpty = false;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/clinical-cases?page=2&q=dry+cough&answered=all`);
    const answerFilter = page.getByLabel("My answers").filter({ visible: true });
    await answerFilter.waitFor();
    const searchField = page.getByRole("searchbox", { name: "Search titles and descriptions" });
    assert.equal(await page.getByRole("button", { name: "Search", exact: true }).count(), 0);
    const controlBounds = await Promise.all([searchField, answerFilter].map(control => control.boundingBox()));
    assert(controlBounds.every(Boolean), "Search and filter controls are visible.");
    const controlHeights = controlBounds.map(bounds => bounds.height);
    assert(Math.max(...controlHeights) - Math.min(...controlHeights) <= 1, "Search input and answer filter have equal heights.");
    assert(await answerFilter.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingRight) >= 24), "Answer filter reserves space for its dropdown arrow.");
    await answerFilter.selectOption("answered");
    await page.waitForURL(url => url.searchParams.get("answered") === "answered" && (url.searchParams.get("page") ?? "1") === "1");
    assert.equal(new URL(page.url()).searchParams.get("q"), "dry cough", "Changing answer filter preserves the search text.");
    assert.deepEqual(catalogRequests.at(-1), { page: "1", q: "dry cough", answered: "answered" }, "Answer filter submits immediately and resets pagination.");
    await page.getByText("Answered - Latest score: 100 / 100").waitFor();
    await page.getByRole("link", { name: draft.title, exact: true }).click();
    await page.getByTestId("attempt-diagnosis").filter({ visible: true }).fill("Cold");
    await page.getByTestId("attempt-submit").filter({ visible: true }).click();
    await page.getByTestId("attempt-result").filter({ visible: true }).waitFor();
    await page.goBack();
    await page.getByText("Answered - Latest score: 0 / 100").waitFor();
    await page.getByTestId("nav-account").filter({ visible: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Sign in / Register" }).waitFor();
    assert(!(await page.context().cookies()).some(cookie => cookie.name === "clinical_session"));
    assert.deepEqual(errors, []);

    const report = {
      account_real_proxy_cookie_login_profile_logout: true,
      answer_filter_auto_submit_preserves_query_resets_page: true,
      catalog_controls_equal_height_and_arrow_space: true,
      debounced_search_focus_caret_and_history: true,
      status: "passed",
      consistent_route_section_widths: true,
      header_home_cases_create_and_brand_navigation: true,
      favicon_available: true,
      docs_new_tab_icon_noopener_and_footer_github: true,
      analytics_private_key_period_states_and_aggregate_display: true,
      attempt_validation_correct_incorrect_error_recovery: true,
      author_review_required_and_reset_on_edit: true,
      reextract_confirmation_answers_preserved_and_review_reset: true,
      unsaved_author_form_navigation_guard_and_key_exemption: true,
      current_header_section_and_case_metadata: true,
      catalog_navigation_pagination_empty_retry: true,
      catalog_search_reset_pagination_no_results_and_clear: true,
      catalog_skeleton_transition_and_reduced_motion: true,
      extraction_spinner_reduced_motion_and_disabled_cursor: true,
      production_retry_new_api_request: true,
      keyboard_skip_and_submit: true,
      unicode_boundaries: true,
      inline_errors_and_focus: true,
      reduced_motion: true,
      responsive_widths: [320, 390, 768, 1440],
      page_errors: errors,
      synthetic_mock_api: true,
    };
    fs.mkdirSync(path.join(root, ".local"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".local/frontend-check.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close();
    server.kill();
    if (server.exitCode === null) await once(server, "exit");
    await new Promise((resolve) => api.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
