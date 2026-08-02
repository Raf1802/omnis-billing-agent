// ─────────────────────────────────────────────────────────────────
// n8n CODE NODE — "Rows → Claims" (OMNIS biller)
// Paste this as the JS of the node currently named "Group Rows Into Claims".
// Place AFTER the Google Sheets read + "Only Unbilled (Status empty)" filter.
// Run mode: "Run Once for All Items".
//
// ONE SHEET ROW = ONE CLAIM.
//
// The previous version grouped rows by patient + Member ID + DOS and merged them
// into a single claim with several lines[], taking rendering_provider /
// rendering_npi / billing_provider / billing_npi from whichever row happened to
// land in the group first. Office Ally sets the rendering and billing provider
// ONCE PER VISIT, so every merged line after the first was billed under the
// WRONG provider and the wrong billing NPI.
//
// That never showed on the 6/23/2026 batch because each patient had exactly one
// row, so every claim was single-line. On 7/28/2026 thirteen patients have two
// or three rows, and five of those span two different providers on the same DOS
// — e.g. ALIM RASHID has 99215 under SYLVIANNE AKUM (1336768787, billed under
// 1154861557) and H0004 under OMNIS HEALTH LIFE, LLC (1548794886/1548794886).
//
// Emitting one claim per row makes the wrong-provider merge impossible by
// construction: a claim can only ever carry its own row's provider.
//
// OMNIS IS SPECIAL: the provider AND billing-provider lookup popups contain rows
// that are near-identical or identical by name (two "OMNIS HEALTH LIFE" entries)
// and differ ONLY by NPI. So this biller MUST match by NPI, not name — hence
// match_provider_by_npi / match_billing_by_npi.
//
// The output shape and the _rowNumbers contract are UNCHANGED, so
// "Code in JavaScript1" (expand rows to mark) and "Code in JavaScript2" (mark
// processing) keep working untouched — they simply always see arrays of length 1.
// ─────────────────────────────────────────────────────────────────

function clean(v) { return v == null ? "" : String(v).trim(); }

// Omnis dates may arrive as Date objects (Sheets/n8n parse them) OR strings.
// Normalize to M/D/YYYY.
function toMDY(v) {
  if (v == null || v === "") return "";
  // Date object → build M/D/YYYY from its parts.
  if (v instanceof Date) {
    return `${v.getUTCMonth() + 1}/${v.getUTCDate()}/${v.getUTCFullYear()}`;
  }
  const s = String(v).trim();
  // ISO 2026-06-23 or 2026-06-23T00:00:00
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${parseInt(iso[2], 10)}/${parseInt(iso[3], 10)}/${iso[1]}`;
  // Already M/D/YYYY (Omnis sheet is M/D) → pass through, normalize zeros.
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mdy) return `${parseInt(mdy[1], 10)}/${parseInt(mdy[2], 10)}/${mdy[3]}`;
  return s;
}

function cleanIcd(v) { return String(v || "").split(",").map(s => s.trim()).filter(Boolean).join(","); }
function digits(v) { return String(v || "").replace(/\D/g, ""); }

// The CPT Code cell is not always just the code. The 6/23 rows carry
// "H0020,HG, UN 1" — code, modifier and unit count mashed into one cell
// ("UN 1" = 1 unit). Sent verbatim that whole string gets searched in the CPT
// lookup and typed into the CPT field. Take the leading code token only; the
// Modifier column supplies the modifier (HG) and units are fixed at 1, so
// nothing is lost. No-op for a clean cell like "99211".
function cleanCpt(v) {
  const m = String(v || "").trim().match(/^[A-Za-z0-9]+/);
  return m ? m[0] : "";
}

// Charge Amount is currency-formatted in the sheet ("$95.97"). If Sheets returns
// the formatted string rather than the number, parseFloat("$95.97") is NaN and
// the agent's charge verification throws. Strip the formatting either way.
function cleanMoney(v) {
  if (v == null || v === "") return "";
  return String(v).replace(/[$,\s]/g, "").trim();
}

const out = [];

for (const item of $input.all()) {
  const r = item.json;
  const rowNumber = r.row_number ?? r.rowNumber ?? null;
  const dos = toMDY(r["DOS"]);

  out.push({
    json: {
      // Always exactly one row per claim now — but kept as an array so the
      // downstream "expand rows to mark" and "mark processing" nodes are unchanged.
      _rowNumbers: rowNumber != null ? [rowNumber] : [],

      patient_first_name: clean(r["Patient First Name"]),
      patient_last_name: clean(r["Patient Last Name"]),
      patient_dob: toMDY(r["Patient DOB"]),
      member_id: clean(r["Member ID"]),
      insurance_name: clean(r["Insurance Name"]),
      dos_from: dos,
      dos_to: dos,
      icd10_codes: cleanIcd(r["ICD-10 Code"]),
      facility_name: clean(r["Facility Name"]),

      rendering_provider: clean(r["Rendering Provider"]),
      rendering_npi: digits(r["Rendering NPI"]),
      billing_provider: clean(r["Billing Provider"]),
      billing_npi: digits(r["Billing Npi"]),

      // OMNIS-SPECIFIC: match providers by NPI (names collide).
      match_provider_by_npi: true,
      match_billing_by_npi: true,

      lines: [{
        cpt: cleanCpt(r["CPT Code"]),
        pos: clean(r["POS"]),
        charge: cleanMoney(r["Charge Amount"]),
        modifier: clean(r["Modifier"]),   // Omnis modifier is real (e.g. "HG") — keep as-is
        units: "1",
        dos: dos,
      }],
    },
  });
}

return out;
