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

// ── Warm, reused billing agent ───────────────────────────────────
// One logged-in Office Ally session kept alive across claims. The first claim
// (or one after the session expires) pays the ~50s Auth0 login; the rest reuse
// it, cutting ~50s off each. An idle timer closes the browser after a stretch of
// no claims, to free memory and drop a stale session.
//
// Safe because runExclusive above already guarantees one claim at a time, and
// the agent re-navigates to a known home page before every claim. No n8n change:
// the HTTP contract is untouched.
let warmAgent = null;
let idleTimer = null;
const SESSION_IDLE_MS = parseInt(process.env.SESSION_IDLE_MS || String(5 * 60 * 1000));

function getAgent() {
  if (!warmAgent) warmAgent = new BillingAgent();
  return warmAgent;
}

function cancelIdleTeardown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleTeardown() {
  cancelIdleTeardown();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Serialize through the same queue so teardown can't race a running claim.
    runExclusive(async () => {
      if (warmAgent) {
        console.log("💤 Idle timeout — closing warm Office Ally session");
        await warmAgent.teardown().catch(() => {});
      }
    });
  }, SESSION_IDLE_MS);
  if (idleTimer.unref) idleTimer.unref(); // don't keep the process alive just for this
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
      cancelIdleTeardown(); // a claim is running — don't tear the session down mid-flight
      return await getAgent().processClaim(claimData); // warm, reused session
    });
    scheduleIdleTeardown();
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

// The warm agent's browser outlives a single request by design, so close it on
// shutdown — Railway sends SIGTERM on redeploy — and Chromium doesn't leak.
["SIGTERM", "SIGINT"].forEach((sig) => {
  process.on(sig, async () => {
    console.log(`\n${sig} — closing warm Office Ally session...`);
    cancelIdleTeardown();
    if (warmAgent) await warmAgent.teardown().catch(() => {});
    process.exit(0);
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Billing Agent running on port ${PORT}`);
  console.log(`🤖 AI Provider: ${process.env.AI_PROVIDER || "gemini"}`);
  // Print where the login session is cached so it's obvious from the deploy logs
  // whether a mounted volume actually took effect.
  console.log(`🍪 Session cache: ${process.env.SESSION_STATE_PATH || "<repo>/.oa-session.json (ephemeral)"}`);
  if (!API_KEY) console.log("⚠️  AGENT_API_KEY not set — endpoint is unauthenticated");
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health`);
  console.log(`  POST /process-claim`);
});