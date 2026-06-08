// src/logger.js
// Tracks everything the agent does for one claim.
// Saves logs + screenshots so you can debug failed claims.

const fs = require("fs");
const path = require("path");

class Logger {
  constructor(claimData) {
    this.claimData = claimData;
    this.claimId = claimData.patient_id || claimData.patient_name?.replace(/\s/g, "_") || Date.now();
    this.logs = [];
    this.startTime = null;
    this.logDir = path.join(__dirname, "../logs", String(this.claimId));

    // Make sure log directory exists
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  start() {
    this.startTime = Date.now();
    this.log(`Starting claim for: ${this.claimData.patient_name || this.claimId}`);
    this.log(`Claim data: ${JSON.stringify(this.claimData)}`);
  }

  log(message) {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    const line = `[${timestamp}] ${message}`;
    this.logs.push(line);
    console.log(line);
  }

  success(message) {
    this.log(message);
  }

  saveScreenshot(cycle, base64Data) {
    try {
      const filename = path.join(this.logDir, `cycle-${String(cycle).padStart(3, "0")}.png`);
      fs.writeFileSync(filename, Buffer.from(base64Data, "base64"));
    } catch (e) {
      // Non-critical — don't crash if screenshot save fails
    }
  }

  getResult(status, errorMessage = null) {
    const duration = Date.now() - this.startTime;

    const result = {
      claim_id: this.claimId,
      patient_name: this.claimData.patient_name,
      status, // "success" | "failed"
      duration_ms: duration,
      duration_human: `${(duration / 1000).toFixed(1)}s`,
      error: errorMessage,
      cycles: this.logs.filter((l) => l.includes("Cycle")).length,
      timestamp: new Date().toISOString(),
    };

    // Save full log to file
    const logFile = path.join(this.logDir, "run.log");
    fs.writeFileSync(
      logFile,
      this.logs.join("\n") + "\n\nRESULT:\n" + JSON.stringify(result, null, 2)
    );

    // Append to master log
    const masterLog = path.join(__dirname, "../logs/master.jsonl");
    fs.appendFileSync(masterLog, JSON.stringify(result) + "\n");

    this.log(`\n📊 Result: ${status.toUpperCase()} in ${result.duration_human}`);
    return result;
  }
}

module.exports = Logger;