// src/browser-client.js
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
chromium.use(StealthPlugin());

// Where the logged-in Office Ally session (cookies + localStorage) is cached.
//
// SECURITY: this file holds LIVE session cookies — whoever has it can act as
// this Office Ally account until they expire. It is gitignored and written
// 0600. Treat it like a password: don't copy it between machines, don't commit
// it, and delete it if it may have leaked. Set SESSION_STATE_PATH to relocate
// it (e.g. onto a Railway volume so it survives redeploys).
const SESSION_STATE_PATH =
  process.env.SESSION_STATE_PATH || path.join(__dirname, '..', '.oa-session.json');

// One consistent identity used for EVERY page and popup. The bug before was
// that the main page got a User-Agent header but popups (window.open) did not,
// so popups looked like headless bots and Office Ally CAPTCHA-challenged them.
// Setting userAgent at the CONTEXT level makes all pages + popups inherit it.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class BrowserClient {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async launch() {
    if (this.browser) return;
    console.log("🚀 Launching Chromium...");
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled' // hide the automation flag
      ]
    });

    // Reuse a previously saved logged-in session when one is on disk. This is
    // what makes a COLD start cheap: instead of ~44s of Auth0 redirects, the
    // caller navigates to /pm and is already authenticated. A stale file costs
    // nothing — ensureLoggedIn detects the redirect to login and falls back.
    let storageState;
    try {
      if (fs.existsSync(SESSION_STATE_PATH)) {
        storageState = JSON.parse(fs.readFileSync(SESSION_STATE_PATH, 'utf8'));
        console.log('🍪 Loaded saved Office Ally session');
      }
    } catch (e) {
      console.log(`⚠️  Saved session unreadable (${e.message.slice(0, 50)}) — ignoring`);
    }

    // Create ONE context with a real, consistent fingerprint. Every page and
    // every popup opened from this context inherits userAgent, viewport,
    // locale, and timezone — so popups no longer look like headless bots.
    this.context = await this.browser.newContext({
      ...(storageState ? { storageState } : {}),
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });

    // Extra belt-and-suspenders: strip the webdriver flag on every page/popup
    // in this context, including ones opened later via window.open.
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.page = await this.context.newPage();
    console.log("✅ Chromium launched (context-level fingerprint applied)");
  }

  // Is there a cached session worth trying before paying for a full login?
  hasSavedSession() {
    try { return fs.existsSync(SESSION_STATE_PATH); } catch (e) { return false; }
  }

  // Persist the logged-in session so the next cold start can skip Auth0.
  // Written 0600 — see the SECURITY note on SESSION_STATE_PATH above.
  async saveSession() {
    if (!this.context) return;
    try {
      // Create the parent directory if it's missing. When SESSION_STATE_PATH
      // points at a Railway volume (e.g. /data/oa-session.json) the mount exists
      // but may be empty on first boot, and a nested path wouldn't otherwise be
      // writable.
      fs.mkdirSync(path.dirname(SESSION_STATE_PATH), { recursive: true });
      const state = await this.context.storageState();
      fs.writeFileSync(SESSION_STATE_PATH, JSON.stringify(state), { mode: 0o600 });
      console.log(`🍪 Saved Office Ally session → ${SESSION_STATE_PATH}`);
    } catch (e) {
      // Never fatal: a claim that billed correctly must not fail because the
      // session cache couldn't be written (unmounted volume, read-only FS).
      console.log(`⚠️  Could not save session to ${SESSION_STATE_PATH}: ${(e.message || '').slice(0, 80)}`);
    }
  }

  // Drop a cached session that no longer authenticates, so the next cold start
  // doesn't waste a navigation proving it's dead.
  clearSession() {
    try { fs.unlinkSync(SESSION_STATE_PATH); } catch (e) { /* nothing to clear */ }
  }

  // Read the page's visible text safely.
  //
  // Office Ally now authenticates through Auth0, so a login submit becomes a
  // redirect CHAIN. Mid-chain the document can legitimately have no <body> yet,
  // and a bare `document.body.innerText` throws "Cannot read properties of null
  // (reading 'innerText')" — which killed the whole claim before it reached the
  // billing flow. Wait briefly for a body, then read defensively.
  async readBodyText(timeout = 10000) {
    await this.page.waitForSelector('body', { timeout }).catch(() => {});
    return await this.page
      .evaluate(() => (document.body ? document.body.innerText : ''))
      .catch(() => '');
  }

  // A screenshot only ever used for debugging. Capturing costs 150-300ms and
  // encodes the whole viewport to base64, so skip it entirely unless
  // DEBUG_SCREENSHOTS is on. Returns null when disabled — every consumer already
  // guards with `if (screenshot)` before saving.
  //
  // NOT for CAPTCHA captures: those feed the vision model and must always run.
  async debugShot() {
    if (process.env.DEBUG_SCREENSHOTS !== 'true') return null;
    return await this.page.screenshot({ encoding: 'base64' }).catch(() => null);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  async takeScreenshot(url) {
    await this.launch();
    console.log(`📸 Navigating to: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.waitForTimeout(3000);
    const screenshot = await this.page.screenshot({ encoding: 'base64' });
    const currentUrl = this.page.url();
    const title = await this.page.title();
    const pageInfo = await this.page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
        type: el.type, name: el.name, id: el.id, placeholder: el.placeholder
      }));
      const bodyText = document.body ? document.body.innerText.slice(0, 500) : '';
      return { inputs, bodyText };
    });
    return { data: { screenshot, url: currentUrl, title, pageInfo } };
  }

  async navigateToPracticeMateLogi() {
    console.log("🌐 Navigating to Practice Mate login...");
    await this.page.goto('https://pm.officeally.com/pm/login.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    // Wait for the login form to actually exist rather than a flat 3s. login.aspx
    // redirects into Auth0, so the useful signal is "a field rendered", which is
    // usually well under a second after domcontentloaded — and is also correct on
    // the slow days a flat 3s would have missed.
    await this.page.waitForSelector(
      'input[name="username"], input[name="txtUserName"], input[type="password"], input[type="text"]',
      { timeout: 20000 }
    ).catch(() => {});
    const url = this.page.url();
    console.log(`📍 URL: ${url}`);
  }

  async solvePostLoginCaptcha(captchaText) {
    console.log(`🔓 Solving post-login CAPTCHA: "${captchaText}"`);
    const captchaField = await this.page.$('input[type="text"]');
    if (captchaField) {
      await captchaField.click({ clickCount: 3 });
      await captchaField.type(captchaText, { delay: 80 });
    }
    const submitBtn = await this.page.$('input[type="submit"], button[type="submit"], button');
    if (submitBtn) await submitBtn.click();

    try {
      await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch(e) {}
    await this.page.waitForTimeout(5000);
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(2000);

    await this.page.goto('https://pm.officeally.com/pm', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await this.page.waitForTimeout(3000);

    const screenshot = await this.page.screenshot({ encoding: 'base64' });
    const url = this.page.url();
    const success = !url.includes('login') && !url.includes('Login') && !url.includes('auth.');
    console.log(`📍 After CAPTCHA URL: ${url}`);
    return { data: { screenshot, url, success } };
  }

  async loginWithCaptcha(username, password, firewallCaptcha, loginCaptcha) {
    await this.launch();
    console.log(`🔐 Login — firewall: "${firewallCaptcha}", login: "${loginCaptcha}"`);

    const sleep = ms => this.page.waitForTimeout(ms);

    await this.navigateToPracticeMateLogi();
    // navigateToPracticeMateLogi already waited for a form field, so this is just
    // a short settle rather than the old flat 2s.
    await sleep(300);

    let bodyText = await this.readBodyText();
    const screenshot1 = await this.debugShot();

    if (bodyText.includes('testing whether you are a human')) {
      console.log('🚧 Firewall CAPTCHA — solving...');
      const captchaField = await this.page.$('input[type="text"]');
      if (captchaField && firewallCaptcha) {
        await captchaField.click({ clickCount: 3 });
        await captchaField.type(firewallCaptcha, { delay: 80 });
      }
      const submitBtn = await this.page.$('input[type="submit"], button[type="submit"], button');
      if (submitBtn) await submitBtn.click();
      try {
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch(e) {}
      await sleep(2000);
      bodyText = await this.readBodyText();
      console.log('After firewall URL:', this.page.url());

      await this.navigateToPracticeMateLogi();
      await sleep(2000);
      bodyText = await this.readBodyText();
    }

    const screenshot2 = await this.debugShot();
    const inputs = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({
        type: el.type, name: el.name, id: el.id, placeholder: el.placeholder
      }))
    );
    console.log('Login page inputs:', JSON.stringify(inputs));

    if (bodyText.includes('testing whether you are a human')) {
      return {
        data: {
          screenshot: screenshot2, screenshot1, screenshot2,
          url: this.page.url(),
          stillFirewall: true,
          success: false,
          inputs
        }
      };
    }

    const usernameSelectors = [
      'input[name="txtUserName"]',
      'input[name="UserName"]',
      'input[name="username"]',
      'input[id*="User" i]',
      'input[type="text"]:first-of-type'
    ];
    let userField = null;
    for (const sel of usernameSelectors) {
      userField = await this.page.$(sel);
      if (userField) { console.log('Username field:', sel); break; }
    }
    if (userField) {
      await userField.click({ clickCount: 3 });
      await userField.type(username, { delay: 15 });
    }

    const passField = await this.page.$('input[type="password"]');
    if (passField) {
      await passField.click({ clickCount: 3 });
      await passField.type(password, { delay: 15 });
    }

    if (bodyText.includes('code is in the image') || bodyText.includes('What code')) {
      const captchaSelectors = [
        'input[name="captcha"]',
        'input[name="CaptchaCode"]',
        'input[name="txtCaptcha"]',
        'input[id*="captcha" i]'
      ];
      let captchaField = null;
      for (const sel of captchaSelectors) {
        captchaField = await this.page.$(sel);
        if (captchaField) { console.log('Login CAPTCHA field:', sel); break; }
      }
      if (captchaField && loginCaptcha) {
        await captchaField.click({ clickCount: 3 });
        await captchaField.type(loginCaptcha, { delay: 60 });
      }
    }

    const buttonSelectors = [
      'input[type="submit"]',
      'button[type="submit"]',
      'input[value*="Login" i]',
      'input[value*="Sign" i]',
      'button:has-text("Continue")',
      'button:has-text("Log in")'
    ];
    let loginBtn = null;
    for (const sel of buttonSelectors) {
      loginBtn = await this.page.$(sel);
      if (loginBtn) { console.log('Login button:', sel); break; }
    }
    if (loginBtn) await loginBtn.click();

    try {
      await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch(e) {}
    // Navigation is already awaited above; a short settle is enough for the
    // post-login page / CAPTCHA-check to render (was a flat 8s).
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(2500);

    let postLoginBody = await this.readBodyText();
    if (postLoginBody.includes('testing whether you are a human')) {
      console.log('🚧 Post-login CAPTCHA detected — returning for AI to solve...');
      const captchaScreenshot = await this.page.screenshot({ encoding: 'base64' });
      return {
        data: {
          screenshot: captchaScreenshot,
          screenshot1,
          screenshot2,
          url: this.page.url(),
          stillFirewall: false,
          needsPostLoginCaptcha: true,
          success: false
        }
      };
    }

    await this.page.goto('https://pm.officeally.com/pm', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    // goto already awaited domcontentloaded; wait for the dashboard's own nav to
    // render instead of a flat 3s, since that's the thing the next step clicks.
    await this.page.waitForSelector('a:has-text("Manage Patients"), td:has-text("Manage Patients")',
      { timeout: 15000 }).catch(() => {});
    await sleep(500);

    const finalUrl = this.page.url();
    const finalTitle = await this.page.title();
    const finalScreenshot = await this.debugShot();
    const success = !finalUrl.includes('login') && !finalUrl.includes('Login') && !finalUrl.includes('auth.');

    console.log(`📍 Final URL: ${finalUrl}`);

    return {
      data: {
        screenshot: finalScreenshot,
        screenshot1,
        screenshot2,
        url: finalUrl,
        title: finalTitle,
        success,
        stillFirewall: false,
        needsPostLoginCaptcha: false
      }
    };
  }

  async executeAction(action) {
    await this.launch();
    console.log(`⚡ Executing: ${action.type}`, action);

    const sleep = ms => this.page.waitForTimeout(ms);
    const delay = parseInt(process.env.ACTION_DELAY || '1500');

    try {
      switch (action.type) {
        case "click":
          if (action.selector) {
            await this.page.click(action.selector);
          } else {
            await this.page.mouse.click(action.x, action.y);
          }
          await sleep(delay);
          break;
        case "type":
          if (action.selector) await this.page.click(action.selector);
          await this.page.keyboard.type(action.text, { delay: 60 });
          await sleep(500);
          break;
        case "select":
          await this.page.selectOption(action.selector, action.value);
          await sleep(delay);
          break;
        case "navigate":
          await this.page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          break;
        case "wait":
          await sleep(action.ms || 2000);
          break;
        case "scroll":
          await this.page.evaluate(y => window.scrollBy(0, y), action.y || 300);
          await sleep(500);
          break;
        default:
          return { data: { success: false, error: `Unknown action: ${action.type}` } };
      }
      const screenshot = await this.page.screenshot({ encoding: 'base64' });
      return { data: { success: true, screenshot, url: this.page.url() } };
    } catch (error) {
      console.error(`Action failed: ${error.message}`);
      const screenshot = await this.page.screenshot({ encoding: 'base64' }).catch(() => null);
      return { data: { success: false, error: error.message, screenshot } };
    }
  }
}

module.exports = BrowserClient;