// src/browser-client.js
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

class BrowserClient {
  constructor() {
    this.browser = null;
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
        '--disable-gpu'
      ]
    });
    this.page = await this.browser.newPage();
    await this.page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    console.log("✅ Chromium launched");
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
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
      const bodyText = document.body.innerText.slice(0, 500);
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
    await this.page.waitForTimeout(3000);
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
    await sleep(2000);

    let bodyText = await this.page.evaluate(() => document.body.innerText);
    const screenshot1 = await this.page.screenshot({ encoding: 'base64' });

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
      bodyText = await this.page.evaluate(() => document.body.innerText);
      console.log('After firewall URL:', this.page.url());

      await this.navigateToPracticeMateLogi();
      await sleep(2000);
      bodyText = await this.page.evaluate(() => document.body.innerText);
    }

    const screenshot2 = await this.page.screenshot({ encoding: 'base64' });
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
      await userField.type(username, { delay: 60 });
    }

    const passField = await this.page.$('input[type="password"]');
    if (passField) {
      await passField.click({ clickCount: 3 });
      await passField.type(password, { delay: 60 });
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

    // Wait for navigation to fully settle
    try {
      await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch(e) {}
    await sleep(8000);
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(2000);

    let postLoginBody = await this.page.evaluate(() => document.body.innerText);
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
    await sleep(3000);

    const finalUrl = this.page.url();
    const finalTitle = await this.page.title();
    const finalScreenshot = await this.page.screenshot({ encoding: 'base64' });
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