require("dotenv").config();
const BillingAgent = require("./agent");

// Omnis 7/28/2026 claim shapes — one sheet row = one claim, one line each.
//
// These are the three provider combinations on the sheet. They are what the old
// code could not bill: it merged same-DOS rows onto one visit (taking the
// provider from whichever row came first) and, on the CPT-popup path, let Office
// Ally's User CPT library override the sheet's charge/POS/modifier.
//
// ALWAYS run this with SUBMIT_CLAIM=false unless you intend to create a real
// visit in Office Ally:
//
//   SUBMIT_CLAIM=false DEBUG_SCREENSHOTS=true node src/test-omnis-claims.js akum
//   SUBMIT_CLAIM=false node src/test-omnis-claims.js llc
//   SUBMIT_CLAIM=false node src/test-omnis-claims.js md
//   SUBMIT_CLAIM=false node src/test-omnis-claims.js all
//
// Patient fields are placeholders — point them at a real Omnis patient, or the
// claim fails at patient lookup (by design: the agent refuses to guess rather
// than bill the wrong person). Override without editing this file:
//
//   PATIENT_FIRST="ALIM" PATIENT_LAST="RASHID" PATIENT_DOB="3/2/1959" \
//   MEMBER_ID="MD500909089" SUBMIT_CLAIM=false node src/test-omnis-claims.js akum
//
const PATIENT = {
  patient_first_name: process.env.PATIENT_FIRST || "TEST",
  patient_last_name: process.env.PATIENT_LAST || "test",
  patient_dob: process.env.PATIENT_DOB || "01/01/2000",
  member_id: process.env.MEMBER_ID || "TEST123",
  insurance_name: "Carelon Behavioral Health",
  icd10_codes: "F1120",
  facility_name: "OMNIS HEALTH LIFE, LLC",
  match_provider_by_npi: true,
  match_billing_by_npi: true,
};

const CASES = {
  // Rendering NPI differs from billing NPI — the best canary for provider
  // selection, because getting either one wrong is immediately visible.
  akum: {
    ...PATIENT,
    dos_from: "7/28/2026",
    dos_to: "7/28/2026",
    rendering_provider: "SYLVIANNE AKUM",
    rendering_npi: "1336768787",
    billing_provider: "OMNIS HEALTH LIFE, LLC",
    billing_npi: "1154861557",
    lines: [{ cpt: "99215", pos: "11", charge: "187.59", modifier: "HG", units: "1" }],
  },

  // Rendering and billing are the SAME name as the "md" case below and differ
  // ONLY by NPI — this is the pair that name matching cannot tell apart.
  // Also the no-modifier shape: ModifierA must be left alone, not blanked.
  llc: {
    ...PATIENT,
    dos_from: "7/28/2026",
    dos_to: "7/28/2026",
    rendering_provider: "OMNIS HEALTH LIFE, LLC",
    rendering_npi: "1548794886",
    billing_provider: "OMNIS HEALTH LIFE, LLC",
    billing_npi: "1548794886",
    lines: [{ cpt: "H0004", pos: "11", charge: "31.06", modifier: "", units: "1" }],
  },

  // The combination that already bills today — the regression guard. The saved
  // claim must look exactly like the 6/23 batch.
  md: {
    ...PATIENT,
    dos_from: "7/28/2026",
    dos_to: "7/28/2026",
    rendering_provider: "OMNIS HEALTH LIFE, MD",
    rendering_npi: "1154861557",
    billing_provider: "OMNIS HEALTH LIFE, LLC",
    billing_npi: "1154861557",
    lines: [{ cpt: "H0020", pos: "11", charge: "95.97", modifier: "HG", units: "1" }],
  },
};

async function main() {
  const arg = (process.argv[2] || "akum").toLowerCase();
  const names = arg === "all" ? Object.keys(CASES) : [arg];

  const unknown = names.filter((n) => !CASES[n]);
  if (unknown.length > 0) {
    console.error(`❌ Unknown case(s): ${unknown.join(", ")}`);
    console.error(`   Available: ${Object.keys(CASES).join(", ")}, all`);
    process.exit(1);
  }

  const missing = ["OFFICE_ALLY_USERNAME", "OFFICE_ALLY_PASSWORD", "GEMINI_API_KEY"]
    .filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error("❌ Missing environment variables:", missing.join(", "));
    process.exit(1);
  }

  if (process.env.SUBMIT_CLAIM !== "false") {
    console.log("⚠️  SUBMIT_CLAIM is not 'false' — this WILL create real visits in Office Ally.\n");
  }

  // One warm agent for all cases, mirroring how index.js drives production —
  // the first claim pays the login, the rest reuse the session.
  const agent = new BillingAgent();
  const results = [];
  for (const name of names) {
    const claim = CASES[name];
    const line = claim.lines[0];
    console.log("\n" + "=".repeat(60));
    console.log(`🧪 Case "${name}": CPT ${line.cpt} $${line.charge} mod "${line.modifier}"`);
    console.log(`   rendering ${claim.rendering_provider} (${claim.rendering_npi})`);
    console.log(`   billing   ${claim.billing_provider} (${claim.billing_npi})`);
    console.log("=".repeat(60));

    try {
      const result = await agent.processClaim(claim);
      results.push({ name, status: result.status, error: result.error });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      results.push({ name, status: "failed", error: error.message });
      console.error(`💥 Fatal error in case "${name}":`, error.message);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  results.forEach((r) => console.log(`${r.status === "success" ? "✅" : "❌"} ${r.name}: ${r.error || r.status}`));

  // Claims share one browser + one logged-in session, so close it explicitly
  // rather than leaving Chromium to be killed by process.exit.
  await agent.teardown().catch(() => {});
  process.exit(results.every((r) => r.status === "success") ? 0 : 1);
}

main();
