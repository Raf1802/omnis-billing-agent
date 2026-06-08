// src/ai-client.js
const axios = require("axios");

const SYSTEM_PROMPT = `You are an AI agent automating medical billing data entry in Office Ally Practice Mate.

You will receive:
1. A screenshot of the current browser state (base64 image)
2. The claim data that needs to be entered
3. A history of actions already taken

Your job is to return the NEXT SINGLE ACTION to take to fill in and submit the claim.

RESPOND ONLY WITH A JSON OBJECT — no explanation, no markdown, no extra text.

Action types you can return:
{ "type": "click", "selector": "CSS selector", "reason": "why" }
{ "type": "click", "x": 100, "y": 200, "reason": "why" }
{ "type": "type", "selector": "CSS selector", "text": "text to type", "reason": "why" }
{ "type": "select", "selector": "CSS selector", "value": "option value", "reason": "why" }
{ "type": "navigate", "url": "https://...", "reason": "why" }
{ "type": "scroll", "y": 300, "reason": "why" }
{ "type": "wait", "ms": 2000, "reason": "why" }
{ "type": "done", "reason": "Claim successfully submitted" }
{ "type": "error", "reason": "Description of what went wrong" }

IMPORTANT RULES:
- Only return ONE action at a time
- Prefer CSS selectors over coordinates when possible
- If a form field is already filled correctly, move to the next field
- If you see a success/confirmation message, return done
- If you see an error message on screen, try to fix it before giving up
- Never click Submit until ALL required fields are filled`;

class AIClient {
  constructor() {
    this.provider = process.env.AI_PROVIDER || "gemini";
    this.anthropicKey = process.env.ANTHROPIC_API_KEY;
    this.geminiKey = process.env.GEMINI_API_KEY;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Read CAPTCHA text from a screenshot — retries on failure ─────
  async readCaptcha(screenshot) {
    const prompt = `Look at this screenshot of a login page. 
Find the CAPTCHA image — it shows distorted or wavy text characters.
Read the exact text shown in the CAPTCHA image.
Respond with ONLY the CAPTCHA text — nothing else, no explanation, no punctuation.
Example response: vcbvkv`;

    for (let i = 0; i < 3; i++) {
      try {
        console.log(`🔤 Gemini reading CAPTCHA (attempt ${i + 1})...`);
        const result = await this._callGeminiText(prompt, screenshot);
        if (result && result.length > 1) {
          console.log(`✅ CAPTCHA read: "${result}"`);
          return result;
        }
      } catch (error) {
        console.error(`CAPTCHA read attempt ${i + 1} failed:`, error.message);
        if (i < 2) await this._sleep(3000);
      }
    }
    console.error("❌ Could not read CAPTCHA after 3 attempts");
    return "";
  }

  // ── Main method: send screenshot + context, get back an action ───
  async getNextAction(screenshot, claimData, actionHistory = []) {
    const userMessage = this._buildUserMessage(claimData, actionHistory);
    return await this._callGemini(userMessage, screenshot);
  }

  _buildUserMessage(claimData, actionHistory) {
    const historyText = actionHistory.length > 0
      ? `\nActions taken so far:\n${actionHistory.map((a, i) =>
          `${i + 1}. ${a.type}: ${a.reason || JSON.stringify(a)}`
        ).join("\n")}`
      : "\nNo actions taken yet — this is the first step.";

    return `CLAIM DATA TO ENTER:
${JSON.stringify(claimData, null, 2)}
${historyText}

Look at the current screenshot and return the next action to take.`;
  }

  // ── Gemini text response (for CAPTCHA) — with retry ──────────────
  async _callGeminiText(prompt, screenshot, retries = 3) {
    const model = "gemini-2.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiKey}`;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios.post(
          url,
          {
            contents: [{
              parts: [
                { inline_data: { mime_type: "image/png", data: screenshot } },
                { text: prompt }
              ]
            }],
            generationConfig: { maxOutputTokens: 50, temperature: 0.1 }
          },
          { headers: { "Content-Type": "application/json" }, timeout: 30000 }
        );
        return response.data.candidates[0].content.parts[0].text.trim();
      } catch (error) {
        const status = error.response?.status;
        if ((status === 429 || status === 400) && i < retries - 1) {
          console.log(`⏳ Gemini ${status} — waiting 5s before retry ${i + 2}/${retries}...`);
          await this._sleep(5000);
        } else {
          throw error;
        }
      }
    }
  }

  // ── Gemini JSON action response — with retry ──────────────────────
  async _callGemini(userMessage, screenshot, retries = 3) {
    const model = "gemini-2.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiKey}`;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios.post(
          url,
          {
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{
              parts: [
                { inline_data: { mime_type: "image/png", data: screenshot } },
                { text: userMessage }
              ]
            }],
            generationConfig: { maxOutputTokens: 512, temperature: 0.1 }
          },
          { headers: { "Content-Type": "application/json" }, timeout: 30000 }
        );
        const text = response.data.candidates[0].content.parts[0].text.trim();
        return this._parseAction(text);
      } catch (error) {
        const status = error.response?.status;
        if ((status === 429 || status === 400) && i < retries - 1) {
          console.log(`⏳ Gemini ${status} — waiting 5s before retry ${i + 2}/${retries}...`);
          await this._sleep(5000);
        } else {
          throw error;
        }
      }
    }
  }

  // ── Parse AI response into action object ─────────────────────────
  _parseAction(text) {
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const action = JSON.parse(cleaned);
      if (!action.type) throw new Error("Action missing type field");
      return { success: true, action };
    } catch (e) {
      console.error("Failed to parse AI response:", text);
      return {
        success: false,
        action: { type: "error", reason: `AI returned invalid JSON: ${text.slice(0, 100)}` }
      };
    }
  }
}

module.exports = AIClient;