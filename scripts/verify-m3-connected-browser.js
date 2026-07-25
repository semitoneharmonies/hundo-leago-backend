const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  throw new Error(message);
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} is required.`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function containsAuthorityClaim(value) {
  if (Array.isArray(value)) return value.some(containsAuthorityClaim);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    /role|team|membership|commissioner|actor|authority/i.test(key) ||
    containsAuthorityClaim(child)
  );
}

async function layoutSnapshot(page) {
  return page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    overflowingElements: Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          className: String(element.className || ""),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          tagName: element.tagName,
          text: String(element.textContent || "").trim().slice(0, 80),
          width: Math.round(rect.width),
        };
      })
      .filter((entry) => entry.left < 0 || entry.right > window.innerWidth)
      .slice(0, 12),
  }));
}

async function assertMobileLayout(page, description) {
  const layout = await layoutSnapshot(page);
  assert(
    layout.innerWidth === 390 && layout.innerHeight === 844,
    `${description} did not use the exact 390x844 viewport.`
  );
  assert(
    layout.documentScrollWidth <= layout.documentClientWidth &&
      layout.overflowingElements.length === 0,
    `${description} has horizontal overflow: ${JSON.stringify(layout)}`
  );
  return layout;
}

async function main() {
  assert(
    process.versions.node === "24.14.1",
    "Connected-browser verification requires exact Node 24.14.1."
  );
  const playwrightRoot = requireEnvironment("PLAYWRIGHT_CORE_PATH");
  const fixtureOutput = requireEnvironment("M3_BROWSER_FIXTURE_OUTPUT");
  const password = requireEnvironment("M3_BROWSER_PASSWORD");
  const chromePath = requireEnvironment("M3_BROWSER_CHROME_PATH");
  const screenshotDirectory = requireEnvironment("M3_BROWSER_SCREENSHOT_DIR");
  const ready = JSON.parse(fs.readFileSync(fixtureOutput, "utf8"));
  assert(ready.ready === true, "The M3 browser fixture is not ready.");
  assert(
    ready.actionLinks?.ephemeralOnly === true,
    "The fixture did not provide ephemeral action links."
  );
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const { chromium } = require(
    path.join(playwrightRoot, "node_modules", "playwright-core")
  );
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
  });
  const page = await context.newPage();
  const requestBodies = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(ready.apiOrigin)) return;
    const body = request.postData();
    if (!body) return;
    try {
      requestBodies.push(JSON.parse(body));
    } catch {
      fail("A target API request contained a non-JSON body.");
    }
  });

  try {
    await page.goto(ready.frontendOrigin, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    const homeLayout = await assertMobileLayout(page, "Account home");
    await page.screenshot({
      path: path.join(screenshotDirectory, "mobile-account-home.png"),
    });

    const signUpForm = page.locator("form").filter({
      has: page.getByRole("heading", { name: "Create an account" }),
    });
    await signUpForm.getByLabel("Email address").fill("browser.enter@example.test");
    await signUpForm.getByLabel("Display name").fill("Browser Enter User");
    await signUpForm.getByLabel("Password", { exact: true }).fill(password);
    await signUpForm.getByLabel("Confirm password").fill(password);
    await signUpForm.getByLabel("Confirm password").press("Enter");
    await page.getByText(/check that email for a verification link/i).waitFor();

    const signInForm = page.locator("form").filter({
      has: page.getByRole("heading", { name: "Sign in" }),
    });
    const emailInput = signInForm.getByLabel("Email address");
    const passwordInput = signInForm.getByLabel("Password");
    await emailInput.fill(ready.email);
    await passwordInput.fill(password);
    const emailElement = await emailInput.elementHandle();
    const passwordElement = await passwordInput.elementHandle();
    await passwordInput.press("Enter");
    await page.waitForURL(`${ready.frontendOrigin}/leagues`);
    await page.getByRole("heading", { name: "Your leagues" }).waitFor();
    assert(
      (await emailElement.evaluate((element) => element.value)) === "" &&
        (await passwordElement.evaluate((element) => element.value)) === "",
      "The detached sign-in DOM retained submitted credentials."
    );
    await assertMobileLayout(page, "League chooser");
    await page.getByRole("link", { name: "Browser Test League" }).click();
    await page.getByRole("heading", { name: "Browser Test League" }).waitFor();
    await page.getByRole("link", { name: "Browser Owls" }).click();
    await page.getByRole("heading", { name: "Browser Owls" }).waitFor();
    const teamLayout = await assertMobileLayout(page, "Team workspace");
    await page.screenshot({
      path: path.join(screenshotDirectory, "mobile-team-workspace.png"),
    });

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Hundo Leago accounts" }).waitFor();
    const signedOutForm = page.locator("form").filter({
      has: page.getByRole("heading", { name: "Sign in" }),
    });
    assert(
      (await signedOutForm.getByLabel("Email address").inputValue()) === "" &&
        (await signedOutForm.getByLabel("Password").inputValue()) === "",
      "Sign-out restored credentials in the account form."
    );
    await page.goBack().catch(() => null);
    await page.getByRole("heading", { name: "Hundo Leago accounts" }).waitFor();
    await page.goForward().catch(() => null);
    await page.getByRole("heading", { name: "Hundo Leago accounts" }).waitFor();
    assert(
      (await signedOutForm.getByLabel("Email address").inputValue()) === "" &&
        (await signedOutForm.getByLabel("Password").inputValue()) === "",
      "Browser history restored submitted credentials."
    );

    await page.goto(ready.actionLinks.verification.url, {
      waitUntil: "domcontentloaded",
    });
    await page.getByText("Your email is verified and you are signed in.").waitFor();
    assert((await page.evaluate(() => location.hash)) === "", "Verification token remained in the URL.");
    await page.getByRole("button", { name: "Sign out" }).click();

    await page.goto(ready.actionLinks.setup.url, { waitUntil: "domcontentloaded" });
    await page.getByLabel("New password").fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByLabel("Confirm password").press("Enter");
    await page.getByText("Your password is set. Sign in to continue.").waitFor();
    assert((await page.evaluate(() => location.hash)) === "", "Setup token remained in the URL.");

    await page.goto(ready.actionLinks.reset.url, { waitUntil: "domcontentloaded" });
    await page.getByLabel("New password").fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByLabel("Confirm password").press("Enter");
    await page.getByText("Your password was reset. Sign in with the new password.").waitFor();
    assert((await page.evaluate(() => location.hash)) === "", "Reset token remained in the URL.");

    await page.goto(ready.actionLinks.reactivation.url, {
      waitUntil: "domcontentloaded",
    });
    await page.getByLabel("Current password").fill(password);
    await page.getByLabel("Current password").press("Enter");
    await page.getByText("Your account is active. Sign in to continue.").waitFor();
    assert((await page.evaluate(() => location.hash)) === "", "Reactivation token remained in the URL.");

    assert(requestBodies.length >= 8, "The browser did not exercise the expected target writes.");
    assert(
      !requestBodies.some(containsAuthorityClaim),
      "A browser request body supplied an authority claim."
    );
    process.stdout.write(
      `${JSON.stringify({
        actionFlows: 4,
        credentialDomCleared: true,
        enterSubmissions: 6,
        historyCredentialRestore: false,
        homeLayout,
        mobileScreenshots: [
          path.join(screenshotDirectory, "mobile-account-home.png"),
          path.join(screenshotDirectory, "mobile-team-workspace.png"),
        ],
        requestBodiesWithoutAuthorityClaims: requestBodies.length,
        teamLayout,
      })}\n`
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
