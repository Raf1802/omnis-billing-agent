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
    // Screenshots are debug-only. In production (Railway) they cost ~150-300ms
    // each AND write PHI (patient names/DOB/diagnoses) to disk, so they're
    // skipped unless DEBUG_SCREENSHOTS=true. Set that env var to re-enable for
    // debugging. This single gate disables all ~31 capture sites at once.
    if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
    try {
      if (Buffer.isBuffer(base64Data)) {
        fs.writeFileSync(filename, base64Data);
      } else {
        fs.writeFileSync(filename, Buffer.from(base64Data, "base64"));
      }
      console.log(`📸 Screenshot saved: ${filename}`);
    } catch(e) {}
  }

  // Capture + save in one call, but ONLY do the (expensive) capture when debug
  // screenshots are enabled. Use this instead of saveDebugScreenshot(name, await
  // target.screenshot()) so the screenshot() call itself is skipped in prod.
  async shot(target, filename) {
    if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
    try { this.saveDebugScreenshot(filename, await target.screenshot()); } catch(e) {}
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

    // Optional search by text. For multi-result lookups (facility, provider)
    // we type the search term, hit Search, and then pick the EXACT matching
    // row — never the first row blindly.
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

    // ── Row selection ────────────────────────────────────────────────
    // PRIORITY: if matchNpi is given, match by NPI (the only unique key when
    // rows collide by name — e.g. Omnis has two billing-provider rows that are
    // IDENTICAL by name/address/Tax ID and differ ONLY by NPI). NPI is exact
    // and unambiguous, so it's preferred over name whenever available.
    if (opts.matchNpi) {
      const wantedNpi = String(opts.matchNpi).replace(/\D/g, '');  // digits only

      const rows = await popup.evaluate(() => {
        const out = [];
        Array.from(document.querySelectorAll('tr')).forEach((tr) => {
          const sel = Array.from(tr.querySelectorAll('a')).find(a => a.textContent.trim() === 'Select');
          if (!sel) return;
          out.push({ cells: Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim()) });
        });
        return out;
      });

      // A row matches if any cell, stripped to digits, equals the wanted NPI.
      const matches = [];
      rows.forEach((r, idx) => {
        const cellDigits = r.cells.map(c => String(c).replace(/\D/g, ''));
        if (cellDigits.includes(wantedNpi)) matches.push(idx);
      });
      logger.log(`🔎 ${label} NPI "${wantedNpi}": ${matches.length} match(es) of ${rows.length} rows`);

      if (matches.length !== 1) {
        this.saveDebugScreenshot(`${label.toLowerCase().replace(/\s+/g, '-')}-npi-${matches.length}.png`, await popup.screenshot());
        await popup.close().catch(() => {});
        throw new Error(`${label} NPI "${wantedNpi}": expected 1 match, found ${matches.length} — refusing to guess`);
      }

      const selectLinks = popup.locator('a:has-text("Select")');
      logger.log(`✅ ${label} matched by NPI ${wantedNpi} (row ${matches[0]})`);
      await Promise.all([
        popup.waitForEvent('close', { timeout: 10000 }).catch(() => {}),
        selectLinks.nth(matches[0]).click({ noWaitAfter: true }).catch(() => {})
      ]);
      logger.log(`✅ ${label} selected (NPI ${wantedNpi})`);
      await page.waitForTimeout(2000);
      return;
    }

    // If a matchName is given, find the row whose name cell EXACTLY matches
    // (case-insensitive, whitespace-normalized) and click THAT row's Select.
    // Safety-critical: with many facilities/providers, "first row" bills the
    // wrong one, and near-duplicate names (two "Bristal" facilities) make a
    // loose "contains" match unsafe. So: exact match preferred, fail on
    // ambiguity, single close match allowed but logged loudly.
    if (opts.matchName) {
      const wanted = opts.matchName.trim().replace(/\s+/g, ' ').toLowerCase();

      const rows = await popup.evaluate(() => {
        const out = [];
        const trs = Array.from(document.querySelectorAll('tr'));
        trs.forEach((tr) => {
          const sel = Array.from(tr.querySelectorAll('a')).find(a => a.textContent.trim() === 'Select');
          if (!sel) return;
          const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim());
          out.push({ cells, rowText: (tr.innerText || '').replace(/\s+/g, ' ').trim() });
        });
        return out;
      });

      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const exactMatches = [];
      const looseMatches = [];
      rows.forEach((r, idx) => {
        const cellNorms = r.cells.map(norm);
        if (cellNorms.includes(wanted)) exactMatches.push(idx);
        else if (cellNorms.some(c => c.length > 4 && (c.includes(wanted) || wanted.includes(c)))) looseMatches.push(idx);
      });

      logger.log(`🔎 ${label} match "${opts.matchName}": ${exactMatches.length} exact, ${looseMatches.length} loose, ${rows.length} rows`);

      let targetIndex = -1;
      if (exactMatches.length === 1) {
        targetIndex = exactMatches[0];
      } else if (exactMatches.length > 1) {
        this.saveDebugScreenshot(`${label.toLowerCase().replace(/\s+/g, '-')}-ambiguous.png`, await popup.screenshot());
        await popup.close().catch(() => {});
        throw new Error(`${label} "${opts.matchName}": ${exactMatches.length} exact matches — ambiguous, refusing to guess`);
      } else if (looseMatches.length === 1) {
        targetIndex = looseMatches[0];
        logger.log(`⚠️  ${label} "${opts.matchName}": no exact match, using single close match: "${rows[targetIndex].rowText.slice(0, 60)}"`);
      } else {
        this.saveDebugScreenshot(`${label.toLowerCase().replace(/\s+/g, '-')}-no-match.png`, await popup.screenshot());
        await popup.close().catch(() => {});
        throw new Error(`${label} "${opts.matchName}": no matching row (${exactMatches.length} exact, ${looseMatches.length} loose of ${rows.length})`);
      }

      const selectLinks = popup.locator('a:has-text("Select")');
      logger.log(`✅ ${label} matched row ${targetIndex}: "${rows[targetIndex].rowText.slice(0, 60)}"`);
      await Promise.all([
        popup.waitForEvent('close', { timeout: 10000 }).catch(() => {}),
        selectLinks.nth(targetIndex).click({ noWaitAfter: true }).catch(() => {})
      ]);
      logger.log(`✅ ${label} selected (matched "${opts.matchName}")`);
      await page.waitForTimeout(2000);
      return;
    }

    // No matchName → legacy single-result behavior: click first Select.
    // Only safe when there's exactly one choice (single-facility accounts).
    await Promise.all([
      popup.waitForEvent('close', { timeout: 10000 }).catch(() => {}),
      popup.click('a:has-text("Select")', { noWaitAfter: true }).catch(() => {})
    ]);
    logger.log(`✅ ${label} selected (first row)`);
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
      // Wait for the search field (next step) instead of a flat 3s.
      await this.browser.page.waitForSelector('#ctl00_phFolderContent_ucSearch_txtSearch', { timeout: 8000 }).catch(() => {});

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
      // Wait for results: a link with the patient's name (next step) to appear.
      await this.browser.page.waitForSelector(`a:has-text("${claimData.patient_last_name}")`, { state: 'visible', timeout: 10000 }).catch(() => {});
      // Let the results navigation/render fully settle before we read the DOM —
      // reading mid-navigation throws "execution context was destroyed".
      await this.browser.page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await this.browser.page.waitForTimeout(500);

      // ── Step 4: Click the CORRECT patient in results ──────────────
      // Many patients share a last name (Eric Freeman vs ..., two Larrys, two
      // Johnsons). Clicking the first link matching the last name can open the
      // WRONG patient and bill someone else — unacceptable. So we read the
      // results table, find the row whose first AND last name match (and DOB
      // when available), and click THAT patient's link. Fail safe on ambiguity.
      logger.log(`🖱️  Selecting patient: ${claimData.patient_first_name} ${claimData.patient_last_name}`);
      const pnorm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const wantFirst = pnorm(claimData.patient_first_name);
      const wantLast  = pnorm(claimData.patient_last_name);
      const wantDob   = pnorm(claimData.patient_dob).replace(/\b0/g, ''); // tolerate 7/5 vs 07/05

      // Collect candidate patient links with their row context. NOTE: each
      // patient row has TWO clickable links (Last Name AND First Name), so the
      // same patient can appear twice — we dedupe by the row's Patient ID below.
      const candidates = await this.browser.page.evaluate(({ wantLast }) => {
        const out = [];
        const links = Array.from(document.querySelectorAll('a'));
        links.forEach((a, idx) => {
          const txt = (a.textContent || '').trim();
          if (!txt) return;
          const row = a.closest('tr');
          const rowText = row ? (row.innerText || '').replace(/\s+/g, ' ').trim() : txt;
          if (rowText.toLowerCase().includes(wantLast)) {
            // Patient ID is the leading number in the row (e.g. "157633551 ...").
            const idMatch = rowText.match(/\b(\d{6,})\b/);
            const patientId = idMatch ? idMatch[1] : rowText.slice(0, 30);
            out.push({ idx, linkText: txt, rowText, patientId });
          }
        });
        return out;
      }, { wantLast });

      // Score each candidate: must contain BOTH first and last name; DOB is a
      // strong tiebreaker when present.
      const scored = candidates.map(c => {
        const rt = pnorm(c.rowText);
        const hasLast = rt.includes(wantLast);
        const hasFirst = rt.includes(wantFirst);
        const hasDob = wantDob && rt.replace(/\b0/g, '').includes(wantDob);
        return { ...c, hasLast, hasFirst, hasDob };
      });

      // Rows matching first+last (+DOB).
      let matched = scored.filter(c => c.hasLast && c.hasFirst);
      if (wantDob && matched.filter(c => c.hasDob).length >= 1) {
        matched = matched.filter(c => c.hasDob);
      }

      // DEDUPE by patient ID — a single patient's row has two links (last+first
      // name), which must NOT count as two separate matches.
      const byPatient = new Map();
      for (const c of matched) {
        if (!byPatient.has(c.patientId)) byPatient.set(c.patientId, c);
      }
      const matches = Array.from(byPatient.values());

      logger.log(`🔎 Patient match: ${matches.length} patient(s) for "${claimData.patient_first_name} ${claimData.patient_last_name}" (${candidates.length} links share last name)`);

      if (matches.length === 0) {
        throw new Error(`Patient "${claimData.patient_first_name} ${claimData.patient_last_name}" not found in results (${candidates.length} last-name link matches, none with first name)`);
      }
      if (matches.length > 1) {
        const preview = matches.slice(0, 3).map(m => m.rowText.slice(0, 50)).join(' | ');
        throw new Error(`Patient "${claimData.patient_first_name} ${claimData.patient_last_name}" ambiguous: ${matches.length} distinct patients — refusing to guess [${preview}]`);
      }

      // Click the verified patient's link by its index among all <a> elements.
      const targetIdx = matches[0].idx;
      const allLinks = this.browser.page.locator('a');
      await allLinks.nth(targetIdx).click();
      logger.log(`✅ Clicked verified patient: "${matches[0].rowText.slice(0, 50)}"`);
      // Wait for the Template tab (next step) to be present.
      await this.browser.page.waitForSelector('a:has-text("Template")', { state: 'visible', timeout: 10000 }).catch(() => {});

      // ── Step 5+6: Template tab → Create New Visit ─────────────────
      // This transition is the fragile one under batch load: pages render
      // slower when claims run back-to-back, so a single tight wait often
      // missed and the click timed out. We now (a) let the page settle, then
      // (b) retry the whole Template→CreateNewVisit sequence a few times,
      // re-clicking Template each attempt, since re-opening the template view
      // reliably re-renders the "Create New Visit" link.
      const page0 = this.browser.page;
      let visitOpened = false;
      const MAX_CNV = 4;
      for (let attempt = 1; attempt <= MAX_CNV && !visitOpened; attempt++) {
        try {
          logger.log(`📋 Clicking Template tab... (attempt ${attempt})`);
          // On later attempts, reload the patient page to recover from a bad
          // state (slow/different patient pages sometimes never render the link).
          if (attempt >= 3) {
            logger.log("🔄 Reloading patient page to recover...");
            await page0.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await page0.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
            await page0.waitForSelector('a:has-text("Template")', { state: 'visible', timeout: 10000 }).catch(() => {});
          }

          const templateTab = await page0.$('a:has-text("Template")');
          if (templateTab) { await templateTab.click(); logger.log("✅ Clicked Template"); }

          // Let any navigation/AJAX from the Template click settle before we
          // look for Create New Visit (avoids "execution context destroyed").
          await page0.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

          // Wait for Create New Visit to be genuinely VISIBLE.
          await page0.waitForSelector('a:has-text("Create New Visit")', { state: 'visible', timeout: 12000 });
          await page0.waitForTimeout(600);

          logger.log("🆕 Clicking Create New Visit...");
          await page0.locator('a:has-text("Create New Visit")').first().click({ timeout: 12000 });
          logger.log("✅ Clicked Create New Visit");

          // Confirm we actually advanced: the visit-date Month field appears.
          await page0.waitForSelector('#ctl00_phFolderContent_DateVisited_Month', { state: 'visible', timeout: 12000 });
          visitOpened = true;
        } catch (e) {
          logger.log(`⚠️  Create New Visit attempt ${attempt} failed: ${e.message.slice(0, 70)}`);
          if (attempt < MAX_CNV) {
            // Escalating settle: later attempts wait longer for slow pages.
            await page0.waitForTimeout(2000 + attempt * 1500);
          }
        }
      }
      if (!visitOpened) {
        throw new Error(`Create New Visit could not be opened after ${MAX_CNV} attempts`);
      }
      await page0.waitForTimeout(400);

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

      // Rendering provider: this biller has MULTIPLE providers, so we must
      // search by name and select the exact match — not the first row.
      // NAME ORDER IS NOT ASSUMED. The sheet is inconsistent: "Samar Abrar"
      // (first last) vs "Ghanni Muhammad" (last first). So we do NOT guess
      // which token is the surname. Instead we try searching by EACH token
      // until the popup returns rows, then match the row where ALL of the
      // claim's name tokens appear across the row's cells (order-independent).
      const rp = (claimData.rendering_provider || '').trim();
      if (rp) {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const tokens = rp.split(/\s+/).map(norm).filter(t => t.length > 1);

        const searchBtnSel = 'input[value="Search"], button:has-text("Search"), input[type="submit"]';
        const readRows = async () => popup.evaluate(() => {
          const out = [];
          Array.from(document.querySelectorAll('tr')).forEach((tr) => {
            const sel = Array.from(tr.querySelectorAll('a')).find(a => a.textContent.trim() === 'Select');
            if (!sel) return;
            out.push({ cells: Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim()) });
          });
          return out;
        });

        // Provider lists are short. Click "Show All" FIRST and match in-memory —
        // this avoids the slow, wasted token searches (e.g. searching "omnis"
        // returned 0 rows and burned ~25s waiting before trying "health").
        let rows = [];
        const showAll = await popup.$('input[value="Show All"], button:has-text("Show All")');
        if (showAll) {
          await showAll.click();
          await popup.waitForFunction(
            () => Array.from(document.querySelectorAll('a')).some(a => a.textContent.trim() === 'Select'),
            { timeout: 8000 }
          ).catch(() => {});
          rows = await readRows();
          logger.log(`🔎 Provider "Show All": ${rows.length} row(s)`);
        }

        // Fallback: if Show All wasn't available or returned nothing, search by
        // each token until rows come back (order-independent).
        if (rows.length === 0) {
          for (const term of tokens) {
            const sb = await popup.$('input[type="text"]:visible') || await popup.$('input[type="text"]');
            if (sb) { await sb.click({ clickCount: 3 }); await sb.fill(''); await sb.type(term, { delay: 80 }); }
            const searchBtn = await popup.$(searchBtnSel);
            if (searchBtn) await searchBtn.click();
            await popup.waitForFunction(
              () => Array.from(document.querySelectorAll('a')).some(a => a.textContent.trim() === 'Select'),
              { timeout: 6000 }
            ).catch(() => {});
            rows = await readRows();
            logger.log(`🔎 Provider search "${term}": ${rows.length} row(s)`);
            if (rows.length > 0) break;
          }
        }

        // MATCH STRATEGY:
        //   - If a rendering_npi is present AND match_provider_by_npi is set,
        //     match by NPI (required when provider rows collide by name, e.g.
        //     Omnis's two "OMNIS HEALTH LIFE" rows differing only by NPI).
        //   - Otherwise match by name tokens (order-independent), which handles
        //     Samar's "Samar Abrar" / "Ghanni Muhammad" inconsistent ordering.
        let matches = [];
        if (claimData.match_provider_by_npi && claimData.rendering_npi) {
          const wantNpi = String(claimData.rendering_npi).replace(/\D/g, '');
          rows.forEach((r, idx) => {
            if (r.cells.map(c => String(c).replace(/\D/g, '')).includes(wantNpi)) matches.push(idx);
          });
          logger.log(`🔎 Provider by NPI "${wantNpi}": ${matches.length} match(es) of ${rows.length} rows`);
        } else {
          rows.forEach((r, idx) => {
            const cellNorms = r.cells.map(norm);
            const haystack = cellNorms.join(' ');
            const allPresent = tokens.every(t => cellNorms.includes(t) || haystack.includes(t));
            if (allPresent) matches.push(idx);
          });
          logger.log(`🔎 Provider "${rp}": ${matches.length} match(es) of ${rows.length} rows`);
        }

        if (matches.length !== 1) {
          this.saveDebugScreenshot("provider-match-fail.png", await popup.screenshot());
          await popup.close().catch(() => {});
          throw new Error(`Rendering provider "${rp}": expected 1 match, found ${matches.length} — refusing to guess`);
        }

        const selectLinks = popup.locator('a:has-text("Select")');
        await Promise.all([
          popup.waitForEvent('close', { timeout: 10000 }).catch(() => {}),
          selectLinks.nth(matches[0]).click({ noWaitAfter: true }).catch(() => {})
        ]);
        logger.log(`✅ Rendering provider selected (matched "${rp}")`);
      } else {
        // No provider name on the claim → legacy first-row behavior.
        logger.log("🖱️  No rendering_provider given — clicking first Select...");
        try {
          await popup.waitForSelector('a:has-text("Select")', { timeout: 5000 });
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
      }

      // Wait for the Billing Info tab (next step) instead of a flat 3s.
      await this.browser.page.waitForSelector('a:has-text("Billing Info"), [id*="BillingInfo"]', { state: 'visible', timeout: 10000 }).catch(() => {});
      await this.browser.page.waitForTimeout(500);
      await this.shot(this.browser.page, "after-provider.png");

      // ── Step 10: Click Billing Info tab ──────────────────────────
      logger.log("💰 Clicking Billing Info tab...");
      const billingInfoTab = await this.browser.page.$('a:has-text("Billing Info"), [id*="BillingInfo"]');
      if (billingInfoTab) { await billingInfoTab.click(); logger.log("✅ Clicked Billing Info"); }
      // Wait for the first ICD code field (next step) to exist.
      await this.browser.page.waitForSelector('#ctl00_phFolderContent_ucDiagnosisCodes_dc_10_1', { state: 'visible', timeout: 10000 }).catch(() => {});
      await this.browser.page.waitForTimeout(500);

      // ── Step 11: Fill ICD-10 codes ───────────────────────────────
      logger.log("🏥 Filling ICD-10 codes...");

      const page = this.browser.page;

      await page.evaluate(() => window.scrollTo(0, 0));
      await this.shot(page, "before-icd-fill.png");

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
      await this.shot(page, "before-cpt.png");

      for (let li = 0; li < lines.length; li++) {
        await this.fillLine(li, lines[li], icdCodes, logger);
      }

      await this.shot(page, "after-lines.png");
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
      // Wait for the Facility lookup button (next step) to exist.
      await page.waitForSelector('#ctl00_phFolderContent_Button35', { state: 'visible', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      await this.shot(page, "billing-options.png");

      // ── Step 15: Facility lookup (HCFA box 32) ───────────────────
      // Search by the claim's facility name and select the EXACT match.
      logger.log(`🏢 Opening Facility lookup (search: "${claimData.facility_name}")...`);
      await this.selectFromPopup('ctl00_phFolderContent_Button35', 'Facility', logger, {
        search: claimData.facility_name,
        matchName: claimData.facility_name,
      });
      await this.shot(page, "after-facility.png");

      // ── Step 16: Billing Provider lookup (HCFA box 33) ───────────
      // Match strategy depends on the biller:
      //   - If claimData.match_billing_by_npi is true AND a real billing_npi is
      //     present → match by NPI. REQUIRED for billers whose billing-provider
      //     rows collide by name (e.g. Omnis: two identical-name rows differing
      //     ONLY by NPI). NPI is the unique key there; name is useless.
      //   - Otherwise → match by name (e.g. Samar, whose "Billing Npi" column is
      //     actually a Tax ID and whose name is the reliable key).
      const billOpts = { search: claimData.billing_provider || '' };
      if (claimData.match_billing_by_npi && claimData.billing_npi) {
        billOpts.matchNpi = claimData.billing_npi;
        logger.log(`🏥 Billing Provider: matching by NPI ${claimData.billing_npi}`);
      } else if (claimData.billing_provider) {
        billOpts.matchName = claimData.billing_provider;
        logger.log(`🏥 Billing Provider: matching by name "${claimData.billing_provider}"`);
      }
      logger.log(`🏥 Opening Billing Provider lookup...`);
      await this.selectFromPopup('ctl00_phFolderContent_Button57', 'Billing Provider', logger, billOpts);
      await this.shot(page, "after-billing-provider.png");

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
      // NOTE: We do NOT compare the sheet's "Billing Npi" to the field, because
      // for this biller that column holds the Tax ID, not the NPI — they will
      // never be equal. The selection itself is verified by exact name-match in
      // selectFromPopup (which throws on no-match/ambiguous), so a wrong billing
      // provider can't be selected silently. We only confirm the NPI field is
      // populated (a blank NPI gets the claim rejected at HCFA box 33a).
      if (!billingNpiVal || !billingNpiVal.trim()) {
        throw new Error("Billing Provider NPI field is empty after selection");
      }
      logger.log("✅ Facility + Billing Provider selected and verified (by name match)");

      // ── Step 17: Click Update to create the visit ────────────────
      // Irreversible save. Every prior step verified (throws on failure), so
      // by here the form is confirmed filled.
      logger.log("💾 Clicking Update to create the visit...");
      await this.shot(page, "before-update.png");

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
      await this.shot(page, "after-update.png");
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