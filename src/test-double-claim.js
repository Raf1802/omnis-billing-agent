require("dotenv").config();
const BillingAgent = require("./agent");

// Two-line claim — same patient + same DOS = one visit, two service lines.
// Both POS 11 codes are NOT in the User CPT list, so each falls to the
// manual entry path (CPT/POS/charge/modifier/units typed directly).
// This is the 3/17/2025 pair from the sample sheet.
const TEST_CLAIM = {
  patient_first_name: "TEST",
  patient_last_name: "test",
  patient_dob: "01/01/2000",
  member_id: "TEST123",
  insurance_name: "Test Insurance",
  hospital_admit_date: "20/02/2025",
  dos_from: "17/03/2025",
  dos_to: "17/03/2025",
  icd10_codes: "i10,e78.5,f0390",
  facility_name: "TEST FACILITY",
  rendering_npi: "1336399963",
  billing_npi: "1639638000",
  lines: [
    { cpt: "99213", pos: "11", charge: "75", modifier: "25", units: "1" },
    { cpt: "90834", pos: "11", charge: "65", modifier: "59", units: "1" },
  ],
};

async function main() {
  console.log("🧪 Running DOUBLE-line test claim...");
  console.log(`Patient: ${TEST_CLAIM.patient_first_name} ${TEST_CLAIM.patient_last_name}`);
  console.log(`DOS From: ${TEST_CLAIM.dos_from}`);
  console.log(`Lines: ${TEST_CLAIM.lines.length}`);
  TEST_CLAIM.lines.forEach((l, i) =>
    console.log(`  Line ${i + 1}: CPT ${l.cpt} POS ${l.pos} mod ${l.modifier} charge ${l.charge}`)
  );
  console.log(`AI Provider: ${process.env.AI_PROVIDER || "gemini"}`);
  console.log("");

  const required = ["BROWSERLESS_TOKEN", "OFFICE_ALLY_USERNAME", "OFFICE_ALLY_PASSWORD"];
  const aiRequired = process.env.AI_PROVIDER === "claude" ? ["ANTHROPIC_API_KEY"] : ["GEMINI_API_KEY"];
  const missing = [...required, ...aiRequired].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error("❌ Missing environment variables:", missing.join(", "));
    process.exit(1);
  }

  const agent = new BillingAgent();

  try {
    const result = await agent.processClaim(TEST_CLAIM);
    console.log("\n" + "=".repeat(50));
    console.log("FINAL RESULT:");
    console.log("=".repeat(50));
    console.log(JSON.stringify(result, null, 2));

    if (result.status === "success") {
      console.log("\n✅ Test passed!");
    } else {
      console.log("\n❌ Test failed. Check logs/ folder for screenshots.");
    }
  } catch (error) {
    console.error("\n💥 Fatal error:", error.message);
    process.exit(1);
  }
}

main();