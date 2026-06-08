// src/index.js
// HTTP server that n8n calls with one claim at a time.
// n8n sends POST /process-claim with the claim JSON as the body.

require("dotenv").config();
const express = require("express");
const BillingAgent = require("./agent");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.AGENT_API_KEY || "";

// ── Strict sequential queue ──────────────────────────────────────
// One Chromium, one Office Ally session → never run two claims at once.
// Each request waits for the previous to finish before starting, even if
// n8n (or a retry) fires overlapping calls.
let chain = Promise.resolve();
function runExclusive(task) {
  const result = chain.then(task, task); // run regardless of prior outcome
  chain = result.then(() => {}, () => {}); // keep chain alive, swallow errors
  return result;
}

// ── Validate a claim payload before opening a browser ────────────
function validateClaim(c) {
  const errors = [];
  if (!c || typeof c !== "object") return ["payload is not an object"];
  if (!c.patient_last_name) errors.push("missing patient_last_name");
  if (!c.dos_from) errors.push("missing dos_from");
  if (!c.icd10_codes) errors.push("missing icd10_codes");
  if (!Array.isArray(c.lines) || c.lines.length === 0) {
    errors.push("missing lines[] (need at least one)");
  } else {
    c.lines.forEach((l, i) => {
      if (!l.cpt) errors.push(`line ${i + 1}: missing cpt`);
      if (!l.pos) errors.push(`line ${i + 1}: missing pos`);
      if (l.charge === undefined || l.charge === null || l.charge === "")
        errors.push(`line ${i + 1}: missing charge`);
    });
  }
  return errors;
}

// ── Health check — n8n / Railway can ping this to verify the agent is up ──
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ai_provider: process.env.AI_PROVIDER || "gemini",
    timestamp: new Date().toISOString(),
  });
});

// ── Main endpoint — n8n calls this for each claim ────────────────
app.post("/process-claim", async (req, res) => {
  // Optional shared-secret auth so a public URL isn't open to anyone.
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ status: "failed", error: "unauthorized" });
  }

  const claimData = req.body;
  const problems = validateClaim(claimData);
  if (problems.length) {
    return res.status(400).json({ status: "failed", error: "bad payload: " + problems.join("; ") });
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`📨 Claim: ${claimData.patient_last_name} ${claimData.dos_from} (${claimData.lines.length} line(s))`);
  console.log("=".repeat(50));

  try {
    const result = await runExclusive(async () => {
      const agent = new BillingAgent(); // fresh agent (and browser) per claim
      return await agent.processClaim(claimData);
    });
    const statusCode = result.status === "success" ? 200 : 422;
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error("💥 Unhandled error:", error.message);
    return res.status(500).json({
      status: "failed",
      error: error.message,
      patient_last_name: claimData.patient_last_name,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Billing Agent running on port ${PORT}`);
  console.log(`🤖 AI Provider: ${process.env.AI_PROVIDER || "gemini"}`);
  if (!API_KEY) console.log("⚠️  AGENT_API_KEY not set — endpoint is unauthenticated");
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health`);
  console.log(`  POST /process-claim`);
});