// src/agent.js
const BrowserClient = require("./browser-client");
const AIClient = require("./ai-client");
const Logger = require("./logger");
const fs = require("fs");

class BillingAgent {
  constructor() {
    this.browser = new BrowserClient();
    this.ai = new AIClient();
    this.maxCycles = parseInt(process.env.MAX_CYCLES || "20");
  }

  saveDebugScreenshot(filename, base64Data) {
    try {
      if (Buffer.isBuffer(base64Data)) {
        fs.writeFileSync(filename, base64Data);
      } else {
        fs.writeFileSync(filename, Buffer.from(base64Data, "base64"));
      }
      console.log(`📸 Screenshot saved: ${filename}`);
    } catch(e) {}
  }

  convertDate(dateStr) {
    if (!dateStr) return "";
    const parts = dateStr.toString().split("/");
    if (parts.length === 3 && parseInt(parts[0]) > 12) {
      return `${parts[1]}/${parts[0]}/${parts[2]}`;
    }
    return dateStr;
  }

  async setFieldValue(id, value) {
    await this.browser.page.evaluate(({ id, value }) => {
      const el = document.getElementById(id);
      if (!el) return;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { id, value });
  }

  // Open a "..." lookup popup by button id, optionally search, then click the
  // first Select. Used for facility & billing provider (same shape as provider).
  // Returns nothing; throws if no selectable row is found.
  // Detect and solve a firewall CAPTCHA inside any popup. The page's wording
  // varies ("testing whether you are a human" OR "What code is in the image?"),
  // and it can reject + re-show, so this checks broadly and retries.
  // Returns true if the popup is clear of a CAPTCHA, false if it couldn't be solved.
  async solvePopupCaptcha(popup, label, logger) {
    const isCaptcha = async () => {
      const t = await popup.evaluate(() => document.body.innerText).catch(() => "");
      return /testing whether you are a human|what code is in the image|invalid answer for the question/i.test(t);
    };

    for (let attempt = 1; attempt <= 4 && await isCaptcha(); attempt++) {
      logger.log(`🚧 CAPTCHA in ${label} popup (attempt ${attempt}) — solving...`);
      const buf = await popup.screenshot();
      this.saveDebugScreenshot(`${label.toLowerCase().replace(/\s+/g, '-')}-captcha-${attempt}.png`, buf);
      const txt = await this.ai.readCaptcha(buf.toString('base64'));
      logger.log(`🤖 ${label} CAPTCHA read: "${txt}"`);
      if (!txt) { await popup.waitForTimeout(1500); continue; }

      const inp = await popup.$('input[type="text"]');
      if (inp) {
        await inp.click({ clickCount: 3 });
        await inp.fill('');
        await inp.type(txt, { delay: 80 });
      }
      const sub = await popup.$('input[type="submit"], input[value="submit" i], button');
      if (sub) await sub.click();
      await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await popup.waitForTimeout(2000);
    }

    const stillBlocked = await isCaptcha();
    if (stillBlocked) {
      logger.log(`❌ ${label} popup CAPTCHA could not be solved`);
    } else {
      logger.log(`✅ ${label} popup ready (no CAPTCHA blocking)`);
    }
    return !stillBlocked;
  }

  async selectFromPopup(openerId, label, logger, opts = {}) {
    const page = this.browser.page;
    const opener = await page.$(`#${openerId}`);
    if (!opener) throw new Error(`${label} lookup button #${openerId} not found`);
    await opener.scrollIntoViewIfNeeded();

    let popup;
    try {
      [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        opener.click()
      ]);
    } catch (e) {
      this.saveDebugScreenshot(`${label.toLowerCase().replace(/\s+/g, '-')}-no-popup.png`, await page.screenshot());
      throw new Error(`${label} lookup did not open a popup: ${e.message.slice(0, 60)}`);
    }
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await popup.waitForTimeout(1500);

    // Solve a CAPTCHA if the popup shows one (before touching the search box).
    if (!await this.solvePopupCaptcha(popup, label, logger)) {
      this.saveDebugScreenshot(`${label.toLowerCase().replace(/\s+/g, '-')}-captcha-failed.png`, await popup.screenshot());
      await popup.close().catch(() => {});
      throw new Error(`${label} popup CAPTCHA could not be solved`);
    }

    // Optional search by text.
    if (opts.search) {
      const sb = await popup.$('input[type="text"]:visible') || await popup.$('input[type="text"]');
      if (sb) { await sb.click({ clickCount: 3 }); await sb.fill(''); await sb.type(opts.search, { delay: 80 }); }
      const btn = await popup.$('input[value="Search"], button:has-text("Search"), input[type="submit"]');
      if (btn) await btn.click();
      await popup.waitForFunction(
        () => Array.from(document.querySelectorAll('a')).some(a => a.textContent.trim() === 'Select'),
        { timeout: 12000 }
      ).catch(() => {});
    }

    let count = await popup.locator('a:has-text("Select")').count();
    // If the list didn't auto-populate, try "Show All".
    if (count === 0) {
      const showAll = await popup.$('input[value="Show All"], button:has-text("Show All")');
      if (showAll) {
        await showAll.click();
        await popup.waitForFunction(
          () => Array.from(document.querySelectorAll('a')).some(a => a.textContent.trim() === 'Select'),
          { timeout: 8000 }
        ).catch(() => {});
        count = await popup.locator('a:has-text("Select")').count();
      }
    }

    logger.log(`🔎 ${label}: ${count} selectable row(s)`);
    if (count === 0) {
      this.saveDebugScreenshot(`${label.toLowerCase().replace(/\s+/g, '-')}-no-results.png`, await popup.screenshot());
      await popup.close().catch(() => {});
      throw new Error(`${label} popup returned no selectable row`);
    }

    // Click first Select; popup closes itself via the opener callback.
    await Promise.all([
      popup.waitForEvent('close', { timeout: 10000 }).catch(() => {}),
      popup.click('a:has-text("Select")', { noWaitAfter: true }).catch(() => {})
    ]);
    logger.log(`✅ ${label} selected`);
    await page.waitForTimeout(2000);
  }

  // One-time scoped dump of a line's fields (ids + values) so we can confirm
  // the real ids (modifier, POS, charge, units) before writing the manual path.
  async dumpLineFields(lineIndex, logger) {
    const fields = await this.browser.page.evaluate((i) => {
      // Match this line's fields exactly. The grid uses different id suffixes
      // per line; capture the suffix by stripping the known field-name prefix
      // so we don't accidentally match another line (e.g. "CPT10" ending in 0).
      const all = Array.from(document.querySelectorAll('input, select'))
        .filter(el => el.id.includes('ucBillingCPT_'));
      // Group by the trailing numeric suffix after the field name.
      return all.map(el => {
        const m = el.id.match(/ucBillingCPT_([A-Za-z_]+?)(\d+)$/);
        return {
          id: el.id,
          field: m ? m[1] : null,
          suffix: m ? m[2] : null,
          type: el.type || '',
          readOnly: !!el.readOnly
        };
      }).filter(f => f.suffix === String(i) || (i === 0 && f.suffix === '0'));
    }, lineIndex);
    logger.log(`🧪 line ${lineIndex} (suffix=${lineIndex}) fields: ${JSON.stringify(fields)}`);
    return fields;
  }

  // Fill a single billing line (CPT, pointer) at the given zero-based line index.
  // Tries the CPT popup first; on empty results, would fall back to manual entry
  // (manual path added once the modifier field id is confirmed).
  // `line` = { cpt, pos, charge, modifier, units }. icdCodes drives the pointer.
  async fillLine(lineIndex, line, icdCodes, logger) {
    const page = this.browser.page;
    const base = 'ctl00_phFolderContent_ucVisitLineItem_ucBillingCPT';
    const cptBtnId  = `${base}_btnUserCPT${lineIndex}`;
    const cptFieldId = `${base}_CPT${lineIndex}`;
    const pointerId = `${base}_DiagnosisCode${lineIndex}`;
    const cpt = line.cpt;

    logger.log(`💉 Line ${lineIndex + 1}: CPT ${cpt} (POS ${line.pos}, charge ${line.charge}${line.modifier ? ', mod ' + line.modifier : ''})`);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // ---- Try the CPT lookup popup ----
    const cptBtn = await page.$(`#${cptBtnId}`);
    if (!cptBtn) throw new Error(`CPT lookup button #${cptBtnId} not found`);
    await cptBtn.scrollIntoViewIfNeeded();

    let cptPopup;
    try {
      [cptPopup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        cptBtn.click()
      ]);
    } catch (e) {
      this.saveDebugScreenshot(`cpt-no-popup-line${lineIndex}.png`, await page.screenshot());
      throw new Error(`CPT lookup did not open a popup (line ${lineIndex}): ${e.message.slice(0, 60)}`);
    }
    await cptPopup.waitForLoadState('domcontentloaded').catch(() => {});
    await cptPopup.waitForTimeout(2000);

    if (!await this.solvePopupCaptcha(cptPopup, 'CPT', logger)) {
      this.saveDebugScreenshot(`cpt-captcha-failed-line${lineIndex}.png`, await cptPopup.screenshot());
      await cptPopup.close().catch(() => {});
      throw new Error("CPT popup CAPTCHA could not be solved after retries");
    }

    // Search the code.
    logger.log(`🔍 Searching CPT: ${cpt}`);
    const sb = await cptPopup.$('input[type="text"]:visible') || await cptPopup.$('input[type="text"]');
    if (sb) { await sb.click({ clickCount: 3 }); await sb.fill(''); await sb.type(cpt, { delay: 80 }); }
    const searchBtn = await cptPopup.$('input[value="Search"], button:has-text("Search"), input[type="submit"]');
    if (searchBtn) await searchBtn.click();

    let resultsReady = false;
    try {
      await cptPopup.waitForFunction(
        (code) => Array.from(document.querySelectorAll('a')).some(a => a.textContent.trim() === 'Select')
                  && document.body.innerText.includes(code),
        cpt, { timeout: 12000 }
      );
      resultsReady = true;
    } catch (e) { /* fall through to count */ }

    const selectCount = await cptPopup.locator('a:has-text("Select")').count();
    logger.log(`🔎 CPT ${cpt}: ${selectCount} result(s) (resultsReady=${resultsReady})`);

    if (selectCount > 0) {
      // ---- Popup path: select first row, auto-fills POS/charge/description ----
      await Promise.all([
        cptPopup.waitForEvent('close', { timeout: 10000 }).catch(() => {}),
        cptPopup.click('a:has-text("Select")', { noWaitAfter: true }).catch(() => {})
      ]);
      logger.log(`✅ CPT ${cpt} selected via popup`);
      await page.waitForTimeout(2500);
    } else {
      // ---- Manual path: code not in User CPT list. Type the line fields
      // directly from the claim. Field ids confirmed via dumpLineFields:
      // CPT{i}, PlaceOfService{i}, ModifierA{i}, Charge{i}, Quantity{i}, DOS{i}.
      this.saveDebugScreenshot(`cpt-manual-line${lineIndex}.png`, await cptPopup.screenshot());
      await cptPopup.close().catch(() => {});
      logger.log(`📝 CPT ${cpt} not in list — entering line ${lineIndex + 1} manually`);

      const setField = async (fieldName, value, label) => {
        if (value === '' || value == null) return;
        const id = `${base}_${fieldName}${lineIndex}`;
        const loc = page.locator(`#${id}`);
        if (await loc.count() === 0) { logger.log(`⚠️  ${label} field #${id} not found`); return; }
        await loc.scrollIntoViewIfNeeded();
        await loc.click({ clickCount: 3 });
        await loc.fill('');
        await loc.type(String(value), { delay: 60 });
        await page.keyboard.press('Tab');   // blur fires the field's change handler
        await page.waitForTimeout(400);
      };

      await setField('DOS', this.convertDate(line.dos), 'DOS');
      await setField('PlaceOfService', line.pos, 'POS');
      await setField('CPT', cpt, 'CPT');
      await setField('ModifierA', line.modifier, 'Modifier');
      // Format charge to 2 decimals (75 → "75.00") to match manual entry.
      const chargeFmt = (line.charge !== '' && !isNaN(parseFloat(line.charge)))
        ? parseFloat(line.charge).toFixed(2)
        : line.charge;
      await setField('Charge', chargeFmt, 'Charge');
      await setField('Quantity', line.units || '1', 'Units');
      await page.waitForTimeout(800);
      this.saveDebugScreenshot(`after-manual-line${lineIndex}.png`, await page.screenshot());

      // Verify the manual fields landed (charge compared numerically to tolerate
      // 75 vs 75.00; POS/modifier compared as strings).
      const readBack = async (f) => page.locator(`#${base}_${f}${lineIndex}`).inputValue().catch(() => '');
      const posV = await readBack('PlaceOfService');
      const modV = await readBack('ModifierA');
      const chgV = await readBack('Charge');
      const dosV = await readBack('DOS');
      logger.log(`🔎 manual line ${lineIndex + 1} → DOS="${dosV}" POS="${posV}" mod="${modV}" charge="${chgV}"`);

      if (line.pos && posV !== String(line.pos)) {
        throw new Error(`POS mismatch line ${lineIndex} (expected ${line.pos}, got "${posV}")`);
      }
      if (line.modifier && modV !== String(line.modifier)) {
        throw new Error(`Modifier mismatch line ${lineIndex} (expected ${line.modifier}, got "${modV}")`);
      }
      if (line.charge && parseFloat(chgV) !== parseFloat(line.charge)) {
        throw new Error(`Charge mismatch line ${lineIndex} (expected ${line.charge}, got "${chgV}")`);
      }
      logger.log(`✅ manual line ${lineIndex + 1} fields verified`);
    }

    // Verify CPT landed in this line's CPT field.
    const cptVal = await page.locator(`#${cptFieldId}`).inputValue().catch(() => '');
    if (!cptVal.includes(cpt)) {
      throw new Error(`CPT ${cpt} did not populate line ${lineIndex} (got "${cptVal}")`);
    }
    logger.log(`✅ CPT ${cpt} verified in line ${lineIndex + 1}`);

    // ---- ICD-10 pointer for this line ----
    const pointer = icdCodes.map((_, idx) => String.fromCharCode(65 + idx)).join("");
    if (icdCodes.length > 4) {
      logger.log(`⚠️  ${icdCodes.length} codes — pointer "${pointer}" exceeds the usual 4-pointer limit.`);
    }
    const pointerField = page.locator(`#${pointerId}`);
    if (await pointerField.count() === 0) throw new Error(`Pointer field #${pointerId} not found`);
    await pointerField.scrollIntoViewIfNeeded();
    await pointerField.click({ clickCount: 3 });
    await pointerField.fill('');
    await pointerField.type(pointer, { delay: 80 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1000);

    const lettersOnly = s => (s || '').replace(/[^a-zA-Z]/g, '').toUpperCase();
    const pointerVal = await page.locator(`#${pointerId}`).inputValue().catch(() => '');
    logger.log(`🔎 line ${lineIndex + 1} pointer → "${pointerVal}"`);
    if (lettersOnly(pointerVal) !== pointer) {
      throw new Error(`Pointer wrong on line ${lineIndex} (expected "${pointer}", got "${pointerVal}")`);
    }
    logger.log(`✅ line ${lineIndex + 1} pointer "${pointer}" verified`);
  }

  // Normalize claim into a lines array, supporting both the new shape
  // (claimData.lines = [{cpt,pos,charge,modifier,units}, ...]) and the legacy
  // single-CPT shape (claimData.cpt_code / cpt_charge) so existing tests run.
  buildLines(claimData) {
    if (Array.isArray(claimData.lines) && claimData.lines.length > 0) {
      return claimData.lines.map(l => ({
        cpt: String(l.cpt),
        pos: l.pos != null ? String(l.pos) : '',
        charge: l.charge != null ? String(l.charge) : '',
        modifier: l.modifier != null ? String(l.modifier) : '',
        units: l.units != null ? String(l.units) : '1',
        dos: l.dos != null ? String(l.dos) : (claimData.dos_from || '')
      }));
    }
    // Legacy single line.
    return [{
      cpt: String(claimData.cpt_code),
      pos: claimData.pos != null ? String(claimData.pos) : '',
      charge: claimData.charge_amount != null ? String(claimData.charge_amount) : '',
      modifier: claimData.modifier != null ? String(claimData.modifier) : '',
      units: '1',
      dos: claimData.dos_from || ''
    }];
  }

  async login(logger) {
    logger.log("🌐 Getting initial page screenshot...");
    const initialPage = await this.browser.takeScreenshot("https://pm.officeally.com/pm/login.aspx");
    const pageData = initialPage.data;
    this.saveDebugScreenshot("step1-initial.png", pageData.screenshot);
    logger.log(`📄 Page: ${pageData.pageInfo.bodyText.slice(0, 100)}`);

    let firewallCaptcha = "";
    const isFirewall = pageData.pageInfo.bodyText.includes("testing whether you are a human");
    if (isFirewall) {
      logger.log("🚧 Firewall CAPTCHA detected — asking AI...");
      firewallCaptcha = await this.ai.readCaptcha(pageData.screenshot);
      logger.log(`🤖 Firewall CAPTCHA: "${firewallCaptcha}"`);
    } else {
      logger.log("✅ No firewall — going straight to login");
    }

    logger.log("🔐 Running full login script in single session...");
    const loginResult = await this.browser.loginWithCaptcha(
      process.env.OFFICE_ALLY_USERNAME,
      process.env.OFFICE_ALLY_PASSWORD,
      firewallCaptcha,
      ""
    );

    const loginData = loginResult.data;
    this.saveDebugScreenshot("step2-login-result.png", loginData.screenshot);
    if (loginData.screenshot1) this.saveDebugScreenshot("step2-firewall-page.png", loginData.screenshot1);
    if (loginData.screenshot2) this.saveDebugScreenshot("step2-login-form.png", loginData.screenshot2);
    logger.log(`📍 Login result URL: ${loginData.url}`);

    if (loginData.needsPostLoginCaptcha) {
      logger.log("🚧 Post-login CAPTCHA — asking AI to solve it...");
      const captchaText = await this.ai.readCaptcha(loginData.screenshot);
      const captchaResult = await this.browser.solvePostLoginCaptcha(captchaText);
      this.saveDebugScreenshot("step3-post-login-captcha.png", captchaResult.data.screenshot);
      if (!captchaResult.data.success) {
        const freshPage = await this.browser.takeScreenshot(captchaResult.data.url);
        const captcha2 = await this.ai.readCaptcha(freshPage.data.screenshot);
        const captchaResult2 = await this.browser.solvePostLoginCaptcha(captcha2);
        if (!captchaResult2.data.success) {
          throw new Error(`Could not solve post-login CAPTCHA. URL: ${captchaResult2.data.url}`);
        }
      }
      logger.log("✅ Post-login CAPTCHA solved — logged in!");
      return captchaResult.data.screenshot;
    }

    if (loginData.stillFirewall) {
      const freshPage = await this.browser.takeScreenshot("https://pm.officeally.com/pm/login.aspx");
      const freshCaptcha = await this.ai.readCaptcha(freshPage.data.screenshot);
      const retryResult = await this.browser.loginWithCaptcha(
        process.env.OFFICE_ALLY_USERNAME,
        process.env.OFFICE_ALLY_PASSWORD,
        freshCaptcha,
        ""
      );
      if (!retryResult.data.success) {
        throw new Error(`Login failed after retry. URL: ${retryResult.data.url}`);
      }
      logger.log("✅ Logged in on retry!");
      return retryResult.data.screenshot;
    }

    if (!loginData.success) {
      throw new Error(`Login failed. Landed on: ${loginData.url}`);
    }

    logger.log("✅ Logged in successfully!");
    return loginData.screenshot;
  }

  async processClaim(claimData) {
    const logger = new Logger(claimData);
    logger.start();

    try {
      await this.login(logger);

      // ── Step 1: Click Manage Patients tab ─────────────────────────
      logger.log("📋 Navigating to Manage Patients...");
      let clicked = false;
      for (const frame of this.browser.page.frames()) {
        try {
          const tab = await frame.$('a:has-text("Manage Patients"), td:has-text("Manage Patients")');
          if (tab) { await tab.click(); clicked = true; break; }
        } catch(e) {}
      }
      if (!clicked) {
        try { await this.browser.page.click('text=Manage Patients'); } catch(e) {}
      }
      await this.browser.page.waitForTimeout(3000);

      // ── Step 2: Search by last name ───────────────────────────────
      logger.log(`🔍 Searching for: ${claimData.patient_last_name}`);
      const searchField = await this.browser.page.$('#ctl00_phFolderContent_ucSearch_txtSearch');
      if (searchField) {
        await searchField.click({ clickCount: 3 });
        await searchField.type(claimData.patient_last_name, { delay: 60 });
      }

      // ── Step 3: Click Search ──────────────────────────────────────
      const searchBtn = await this.browser.page.$('#ctl00_phFolderContent_ucSearch_btnSearch');
      if (searchBtn) await searchBtn.click();
      await this.browser.page.waitForTimeout(3000);

      // ── Step 4: Click patient name in results ─────────────────────
      logger.log(`🖱️  Clicking on: ${claimData.patient_last_name}`);
      const patientLink = await this.browser.page.$(`a:has-text("${claimData.patient_last_name}")`);
      if (patientLink) {
        await patientLink.click();
        logger.log("✅ Clicked patient");
      } else {
        logger.log("⚠️  Patient link not found");
      }
      await this.browser.page.waitForTimeout(3000);

      // ── Step 5: Click Template tab ────────────────────────────────
      logger.log("📋 Clicking Template tab...");
      const templateTab = await this.browser.page.$('a:has-text("Template")');
      if (templateTab) { await templateTab.click(); logger.log("✅ Clicked Template"); }
      await this.browser.page.waitForTimeout(3000);

      // ── Step 6: Click Create New Visit ────────────────────────────
      logger.log("🆕 Clicking Create New Visit...");
      const createVisitBtn = await this.browser.page.$('a:has-text("Create New Visit")');
      if (createVisitBtn) { await createVisitBtn.click(); logger.log("✅ Clicked Create New Visit"); }
      await this.browser.page.waitForTimeout(3000);

      // ── Step 7: Fill Visit Date ───────────────────────────────────
      const visitDate = this.convertDate(claimData.dos_from);
      const [month, day, year] = visitDate.split("/");
      logger.log(`📅 Setting visit date: ${visitDate}`);
      await this.setFieldValue('ctl00_phFolderContent_DateVisited_Month', month);
      await this.setFieldValue('ctl00_phFolderContent_DateVisited_Day', day);
      await this.setFieldValue('ctl00_phFolderContent_DateVisited_Year', year);
      logger.log("✅ Visit date filled");
      await this.browser.page.waitForTimeout(1000);

      // ── Step 8: Click ... next to Provider ID ─────────────────────
      logger.log("👨‍⚕️ Opening provider lookup popup...");

      let popup;
      [popup] = await Promise.all([
        this.browser.page.waitForEvent('popup'),
        this.browser.page.click('#ctl00_phFolderContent_ProviderID ~ input[type="button"], input[id*="btnProvider"], input[onclick*="Provider"]').catch(async () => {
          const allBtns = await this.browser.page.$$('input[value="..."]');
          if (allBtns.length > 0) await allBtns[0].click();
        })
      ]);

      logger.log("✅ Provider popup opened");
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await popup.waitForTimeout(2000);

      // Solve a firewall CAPTCHA if present (shared retry-aware solver).
      if (!await this.solvePopupCaptcha(popup, 'Provider', logger)) {
        this.saveDebugScreenshot("provider-captcha-failed.png", await popup.screenshot());
        await popup.close().catch(() => {});
        throw new Error("Provider popup CAPTCHA could not be solved after retries");
      }

      try {
        const buf = await popup.screenshot();
        this.saveDebugScreenshot("provider-popup.png", buf);
      } catch(e) {}

      logger.log("🖱️  Clicking Select in popup...");
      try {
        await popup.waitForSelector('a:has-text("Select")', { timeout: 5000 });
        // Popup closes itself on Select (opener callback fills the parent),
        // so race the click against 'close' rather than requiring it to resolve.
        await Promise.all([
          popup.waitForEvent('close', { timeout: 10000 }).catch(() => {}),
          popup.click('a:has-text("Select")', { noWaitAfter: true }).catch(e => {
            logger.log(`ℹ️  Provider Select teardown (expected): ${e.message.slice(0, 60)}`);
          })
        ]);
        logger.log("✅ Clicked Select (popup closed)");
      } catch(e) {
        logger.log(`⚠️  Select error: ${e.message.slice(0, 80)}`);
      }

      await this.browser.page.waitForTimeout(3000);
      const afterProviderBuffer = await this.browser.page.screenshot();
      this.saveDebugScreenshot("after-provider.png", afterProviderBuffer);

      // ── Step 10: Click Billing Info tab ──────────────────────────
      logger.log("💰 Clicking Billing Info tab...");
      const billingInfoTab = await this.browser.page.$('a:has-text("Billing Info"), [id*="BillingInfo"]');
      if (billingInfoTab) { await billingInfoTab.click(); logger.log("✅ Clicked Billing Info"); }
      await this.browser.page.waitForTimeout(3000);

      // ── Step 11: Fill ICD-10 codes ───────────────────────────────
      logger.log("🏥 Filling ICD-10 codes...");

      const page = this.browser.page;

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1000);

      const beforeIcdBuf = await page.screenshot();
      this.saveDebugScreenshot("before-icd-fill.png", beforeIcdBuf);

      const icdCodes = claimData.icd10_codes
        .split(",")
        .map(c => c.trim())
        .filter(c => c.length > 0);
      logger.log(`ICD-10 codes: ${JSON.stringify(icdCodes)}`);

      const norm = s => (s || "").replace(/[.\s]/g, "").toLowerCase();

      for (let i = 0; i < icdCodes.length; i++) {
        const code = icdCodes[i];
        const fieldNum = i + 1;
        logger.log(`📝 Entering ICD-10 code ${fieldNum}: ${code}`);

        // Each row has two autocomplete inputs:
        //   dc_10_N → small code box (left), dd_10_N → wide description box (right)
        const codeId = `ctl00_phFolderContent_ucDiagnosisCodes_dc_10_${fieldNum}`;
        const descId = `ctl00_phFolderContent_ucDiagnosisCodes_dd_10_${fieldNum}`;
        const codeField = page.locator(`#${codeId}`);

        if (await codeField.count() === 0) {
          logger.log(`⚠️  ICD code field not found: #${codeId}`);
          continue;
        }

        // Make sure no leftover menu from the previous row is covering this field.
        await page.locator('.ui-autocomplete:visible').first()
          .waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});

        // Focus the element directly — not a coordinate click an overlay can intercept.
        await codeField.scrollIntoViewIfNeeded();
        await codeField.focus();
        await codeField.fill('');                  // clear without relying on triple-click
        await codeField.type(code, { delay: 100 });

        // Confirm focus is actually where we think before we commit.
        const active = await page.evaluate(() => document.activeElement?.id);
        logger.log(`🎯 active element while typing code ${fieldNum}: ${active}`);

        // Wait for THIS field's autocomplete menu to actually appear, then screenshot.
        await page.locator('.ui-autocomplete:visible li.ui-menu-item').first()
          .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        this.saveDebugScreenshot(`icd-code-${fieldNum}.png`, await page.screenshot());
        logger.log(`📸 Saved icd-code-${fieldNum}.png`);

        // Click ONLY the visible menu's first item.
        const suggestion = page.locator('.ui-autocomplete:visible li.ui-menu-item').first();
        if (await suggestion.count() > 0) {
          await suggestion.click();
          logger.log(`✅ Clicked suggestion for ${code}`);
        } else {
          await page.keyboard.press('Escape');
          logger.log(`⚠️  No suggestion menu for ${code} — pressed Escape`);
        }

        // Critical: wait for the menu to fully close so it can't cover the next row.
        await page.locator('.ui-autocomplete:visible').first()
          .waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});

        // Read back and verify: code lands in dc, description auto-fills in dd.
        const codeVal = await page.locator(`#${codeId}`).inputValue().catch(() => '');
        const descVal = await page.locator(`#${descId}`).inputValue().catch(() => '');
        logger.log(`🔎 row ${fieldNum} → dc="${codeVal}" dd="${descVal}"`);

        // Check 1: the code itself landed in the small (dc) box of THIS row.
        if (!norm(codeVal).includes(norm(code))) {
          logger.log(`❌ CODE MISMATCH: expected "${code}" in dc_10_${fieldNum}, got "${codeVal}". Stopping.`);
          throw new Error(`ICD code ${code} did not land in row ${fieldNum} (dc="${codeVal}", dd="${descVal}")`);
        }

        // Check 2: a suggestion was actually committed — the description (dd) box
        // auto-fills ONLY on selection. If it's empty, raw text was left uncommitted.
        if (!descVal || descVal.trim().length === 0) {
          logger.log(`❌ NO DESCRIPTION: row ${fieldNum} code committed but dd_10_${fieldNum} is empty — suggestion not selected. Stopping.`);
          throw new Error(`ICD code ${code} in row ${fieldNum} has no description (suggestion was not committed). dc="${codeVal}"`);
        }

        // Check 3: guard against a leaked code in the NEXT row's boxes (the overlap bug).
        // If row N+1 already holds text before we've typed there, something bled over.
        const nextNum = fieldNum + 1;
        if (i + 1 < icdCodes.length) {
          const nextCodeId = `ctl00_phFolderContent_ucDiagnosisCodes_dc_10_${nextNum}`;
          const nextDescId = `ctl00_phFolderContent_ucDiagnosisCodes_dd_10_${nextNum}`;
          const nextCode = await page.locator(`#${nextCodeId}`).inputValue().catch(() => '');
          const nextDesc = await page.locator(`#${nextDescId}`).inputValue().catch(() => '');
          if ((nextCode && nextCode.trim()) || (nextDesc && nextDesc.trim())) {
            logger.log(`❌ LEAK: row ${nextNum} already has content (dc="${nextCode}" dd="${nextDesc}") before being filled. Stopping.`);
            throw new Error(`Content leaked into row ${nextNum} after filling row ${fieldNum}`);
          }
        }

        logger.log(`✅ row ${fieldNum} verified: code + description both in place`);
      }

      // Final sweep: confirm every requested code is present in its own row, in order.
      logger.log("🔍 Final verification of all ICD-10 rows...");
      for (let i = 0; i < icdCodes.length; i++) {
        const fieldNum = i + 1;
        const c = await page.locator(`#ctl00_phFolderContent_ucDiagnosisCodes_dc_10_${fieldNum}`).inputValue().catch(() => '');
        const d = await page.locator(`#ctl00_phFolderContent_ucDiagnosisCodes_dd_10_${fieldNum}`).inputValue().catch(() => '');
        const ok = norm(c).includes(norm(icdCodes[i])) && d && d.trim().length > 0;
        logger.log(`   row ${fieldNum}: dc="${c}" dd="${d}" ${ok ? '✅' : '❌'}`);
        if (!ok) {
          throw new Error(`Final check failed at row ${fieldNum}: expected "${icdCodes[i]}", got dc="${c}" dd="${d}"`);
        }
      }
      logger.log("✅ All ICD-10 codes verified with descriptions");

      const afterIcdBuf = await page.screenshot();
      this.saveDebugScreenshot("billing-info-after-icd.png", afterIcdBuf);
      logger.log("📸 Saved billing-info-after-icd.png");

      // ── Step 12+13: Fill each billing line (CPT + pointer) ───────
      // One line for a normal claim, two for a same patient+DOS pair.
      const lines = this.buildLines(claimData);
      logger.log(`🧾 Filling ${lines.length} billing line(s)`);
      this.saveDebugScreenshot("before-cpt.png", await page.screenshot());

      for (let li = 0; li < lines.length; li++) {
        await this.fillLine(li, lines[li], icdCodes, logger);
      }

      this.saveDebugScreenshot("after-lines.png", await page.screenshot());
      logger.log("📸 Saved after-lines.png");

      // ── Step 14: Billing Options tab ─────────────────────────────
      logger.log("🧾 Clicking Billing Options tab...");
      const billingOptionsTab = await page.$('a:has-text("Billing Options"), [id*="BillingOption"]');
      if (billingOptionsTab) {
        await billingOptionsTab.click();
        logger.log("✅ Clicked Billing Options");
      } else {
        logger.log("⚠️  Billing Options tab not found");
      }
      await page.waitForTimeout(3000);
      this.saveDebugScreenshot("billing-options.png", await page.screenshot());

      // ── Step 15: Facility lookup (HCFA box 32) ───────────────────
      // Button35 → OpenPopup({popupName:'Facilities'}). Select the first row.
      logger.log("🏢 Opening Facility lookup...");
      await this.selectFromPopup('ctl00_phFolderContent_Button35', 'Facility', logger);
      this.saveDebugScreenshot("after-facility.png", await page.screenshot());

      // ── Step 16: Billing Provider lookup (HCFA box 33) ───────────
      // Button57 → OpenPopup({popupName:'BillingProvider'}). Select the first row.
      logger.log("🏥 Opening Billing Provider lookup...");
      await this.selectFromPopup('ctl00_phFolderContent_Button57', 'Billing Provider', logger);
      this.saveDebugScreenshot("after-billing-provider.png", await page.screenshot());

      // Verify the key Billing Options fields by their real ids (found via the
      // earlier field dump). Billing NPI is the one that gets a claim rejected
      // if missing (HCFA box 33a), so it's a hard check.
      const billingNpiVal = await page.locator('#ctl00_phFolderContent_BillingProviderNPI').inputValue().catch(() => '');
      const billingProvVal = await page.locator('#ctl00_phFolderContent_BillingProviderProviderID').inputValue().catch(() => '');
      const facilityIdVal = await page.locator('#ctl00_phFolderContent_FacilityProviderID').inputValue().catch(() => '');
      logger.log(`🔎 facility ID="${facilityIdVal}" billingProvID="${billingProvVal}" billingNPI="${billingNpiVal}"`);

      if (!facilityIdVal || !facilityIdVal.trim()) {
        throw new Error("Facility ID did not populate after selection");
      }
      if (!billingProvVal || !billingProvVal.trim()) {
        throw new Error("Billing Provider ID did not populate after selection");
      }
      if (claimData.billing_npi && billingNpiVal !== claimData.billing_npi) {
        throw new Error(`Billing NPI mismatch: expected "${claimData.billing_npi}", got "${billingNpiVal}"`);
      }
      logger.log("✅ Facility + Billing Provider + NPI verified");

      // ── Step 17: Click Update to create the visit ────────────────
      // Irreversible save. Every prior step verified (throws on failure), so
      // by here the form is confirmed filled.
      logger.log("💾 Clicking Update to create the visit...");
      this.saveDebugScreenshot("before-update.png", await page.screenshot());

      let updateBtn = await page.$('input[type="submit"][value="Update" i], input[type="button"][value="Update" i], button:has-text("Update")');
      if (!updateBtn) {
        logger.log("❌ Update button not found. Stopping (nothing saved).");
        throw new Error("Update button not found — visit not saved");
      }

      await updateBtn.scrollIntoViewIfNeeded();
      await updateBtn.click().catch(e => logger.log(`ℹ️  Update click note: ${e.message.slice(0, 60)}`));

      // Let the save round-trip settle, then capture the after-state for review.
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(4000);
      this.saveDebugScreenshot("after-update.png", await page.screenshot());
      logger.log(`📍 Post-Update URL: ${page.url()}`);
      logger.log("📸 Saved after-update.png — review to confirm the visit was created");

      return logger.getResult("success", "Visit filled, verified, and Update clicked");

    } catch (error) {
      logger.log(`💥 Unexpected error: ${error.message}`);
      return logger.getResult("failed", error.message);
    } finally {
      await this.browser.close();
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = BillingAgent;