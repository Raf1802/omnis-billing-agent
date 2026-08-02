# Omnis Billing Agent

Creates medical billing claims in **Office Ally Practice Mate** by driving the web UI with
Playwright. n8n reads the Omnis Google Sheet and POSTs one claim at a time; the agent logs
in, finds the patient, creates a visit, fills it, verifies every field it wrote, and clicks
Update.

The agent's guiding rule is **refuse to guess**. Patient, rendering provider, facility,
billing provider and CPT are all matched exactly; anything ambiguous or missing throws and
the row is marked `error` rather than billed to the wrong patient, provider or amount.

## Running it

```bash
npm start                       # HTTP server on $PORT (default 3000)
npm test                        # single-line claim, CPT popup path
node src/test-double-claim.js   # two-line claim, manual CPT path
node src/test-omnis-claims.js akum|llc|md|all   # the three Omnis provider combinations
```

Deployed via `Dockerfile` (Playwright base image) to Railway.

### Environment

| Var | Required | Purpose |
|---|---|---|
| `OFFICE_ALLY_USERNAME` / `OFFICE_ALLY_PASSWORD` | yes | Practice Mate login |
| `GEMINI_API_KEY` | yes | Gemini vision, used only to read CAPTCHAs |
| `AGENT_API_KEY` | **yes in production** | Shared secret checked against the `x-api-key` header. **If unset the endpoint is completely open.** n8n already sends this header. |
| `PORT` | no | default 3000 |
| `SUBMIT_CLAIM` | no | Set to `false` to fill and verify everything but **stop before clicking Update**. Nothing is saved. Use this to test against live Office Ally. |
| `SESSION_IDLE_MS` | no | How long the warm Office Ally session is kept between claims before the browser is closed. Default 5 min. |
| `SESSION_STATE_PATH` | no | Where the cached login session is written. Defaults to `.oa-session.json` in the repo root. **Holds live session cookies — treat as a credential.** Point at a mounted volume to survive Railway redeploys. |
| `DEBUG_SCREENSHOTS` | no | `true` writes ~31 debug screenshots per claim. Off by default: they cost 150-300ms each and contain PHI. |

## HTTP API

### `GET /health`
`{ status, ai_provider, timestamp }`

### `POST /process-claim`
One claim per request. Requests are queued and run strictly one at a time (one browser, one
Office Ally session), so overlapping calls are serialised rather than run in parallel.

**The Office Ally session is kept warm between claims.** Since Office Ally moved to Auth0,
logging in costs ~50s — and it used to be paid on every claim. `index.js` now holds one
long-lived agent; before each claim it navigates back to the dashboard, which both confirms
the session is still valid and resets state from whatever the previous claim left behind
(including a failed one). Only a dead session pays for a login. An idle timer
(`SESSION_IDLE_MS`, default 5 min) closes the browser after a quiet stretch.

The session is also **cached to disk** (`storageState` — cookies + localStorage), so a cold
start after a process restart reloads it and skips Auth0 entirely, verifying with a single
navigation. A stale or corrupt cache costs nothing: the redirect to login is detected, the
file is deleted, and a normal login runs.

Measured: **~110s cold with no cache, ~64s cold with the cache, ~48s warm.** The n8n side is
unchanged throughout.

> **The session cache is a credential.** `.oa-session.json` holds live Office Ally session
> cookies — anyone holding that file can act as this account until they expire. It's
> gitignored and written `0600`. Don't commit or copy it; delete it if it may have leaked.

### Persisting the cache across Railway redeploys (optional)

Railway containers are ephemeral, so by default the cache only survives process restarts
*inside* one container — a redeploy starts cold. To keep it across deploys, attach a volume:

1. Railway → your service → **Variables** → **+ Volume** (or **Settings → Volumes → Add**).
2. Set the mount path to `/data`.
3. Add the env var `SESSION_STATE_PATH=/data/oa-session.json`.
4. Redeploy. The startup log prints `🍪 Session cache: …` — confirm it shows `/data/...`
   rather than the ephemeral default.

Or with the CLI: `railway volume add --mount-path /data`, then
`railway variables --set SESSION_STATE_PATH=/data/oa-session.json`.

The parent directory is created automatically, and a failed write is logged but never fails
a claim. Worth knowing before you do it: this saves ~46s **once per deploy** (not per batch),
it only helps if the cached session hasn't expired by the time you redeploy, and it puts
live session cookies on durable storage that outlives the container.

Responses: `200` success · `400` bad payload · `401` unauthorized · `422` claim failed ·
`500` unhandled.

```jsonc
{
  "patient_first_name": "ALIM",           // used to disambiguate same-surname patients
  "patient_last_name":  "RASHID",         // REQUIRED — the search term
  "patient_dob":        "3/2/1959",       // DOB tiebreaker, M/D/YYYY
  "member_id":          "MD500909089",    // accepted, not written to Office Ally
  "insurance_name":     "Carelon Behavioral Health",  // accepted, not written
  "dos_from":           "7/28/2026",      // REQUIRED — becomes the Visit Date, M/D/YYYY
  "dos_to":             "7/28/2026",      // accepted, not written
  "icd10_codes":        "F1120",          // REQUIRED — comma-separated STRING, not an array
  "facility_name":      "OMNIS HEALTH LIFE, LLC",     // HCFA box 32
  "facility_npi":       "",               // optional; disambiguates identically-named facilities

  "rendering_provider": "SYLVIANNE AKUM", // HCFA box 24J
  "rendering_npi":      "1336768787",     // preferred key — matched on its own if present
  "billing_provider":   "OMNIS HEALTH LIFE, LLC",     // HCFA box 33
  "billing_npi":        "1154861557",     // HCFA box 33a

  "match_provider_by_npi": true,          // Omnis: provider rows collide by name
  "match_billing_by_npi":  true,          // Omnis: billing rows differ ONLY by NPI

  "lines": [                              // REQUIRED, at least one
    { "cpt": "99215", "pos": "11", "charge": "187.59", "modifier": "HG", "units": "1" }
  ]
}
```

`cpt`, `pos` and `charge` are required on every line. `modifier` and `units` are optional
(`units` defaults to `"1"`). `charge` may be a number or a string; `$` and thousands commas
are tolerated.

**The claim is authoritative for POS, charge, units and modifier.** Even when the CPT is
found in Office Ally's User CPT list — which auto-fills that row's *stored* values — the
agent overwrites them with the claim's and verifies by read-back. The sheet carries one
modifier per line, so `ModifierA` is written only when the claim supplies a modifier;
`ModifierB/C/D` are never written and never cleared, so anything the CPT library pre-fills
there survives.

### Provider matching

Both provider lookups are popups listing every provider on the account. Omnis has three
rendering providers, two of which are near-identical by name and differ **only by NPI**:

| Rendering provider | Rendering NPI | Billing provider | Billing NPI |
|---|---|---|---|
| OMNIS HEALTH LIFE, MD | 1154861557 | OMNIS HEALTH LIFE, LLC | 1154861557 |
| SYLVIANNE AKUM | 1336768787 | OMNIS HEALTH LIFE, LLC | 1154861557 |
| OMNIS HEALTH LIFE, LLC | 1548794886 | OMNIS HEALTH LIFE, LLC | 1548794886 |

So NPI is the match key. When `rendering_npi` / `billing_npi` is present the agent matches
on it and then **asserts the form holds that NPI** after selection. If the popup exposes no
NPI column, it falls back to an order-independent name match. Either way, anything other
than exactly one matching row throws.

## n8n workflow

The workflow ("Omnis Billing Agent") lives in n8n Cloud, not in this repo — its export
contains a live API key and the Google Sheet ID, so don't commit it. Its shape:

```
Webhook → Get row(s) in sheet → Only Unbilled (Status empty) → Rows → Claims
        → Loop (1 claim at a time) → mark "processing" → Update row
        → Call Billing Agent (POST /process-claim) → expand rows → Mark done/error
```

**[`n8n/rows-to-claims.js`](n8n/rows-to-claims.js) is the source of truth for the "Rows →
Claims" Code node** — paste it into n8n whenever it changes. It maps sheet columns to the
payload above and emits **one claim per sheet row**.

That one-row-one-claim rule matters. An earlier version grouped rows by patient + Member ID
+ DOS and merged them into a single claim with several `lines[]`, taking the provider from
whichever row landed first. Office Ally sets the provider **once per visit**, so every
merged line after the first was billed under the wrong provider and wrong billing NPI.

### Sheet column → payload

| Sheet column | Field | Notes |
|---|---|---|
| Patient First/Last Name, Patient DOB | `patient_*` | dates normalised to M/D/YYYY |
| Member ID, Insurance Name | `member_id`, `insurance_name` | passed through, not written to Office Ally |
| DOS | `dos_from` / `dos_to` / `lines[].dos` | |
| POS | `lines[].pos` | |
| CPT Code | `lines[].cpt` | leading code token only — the 6/23 rows carry `"H0020,HG, UN 1"` (code, modifier, and `UN 1` meaning 1 unit) in this cell |
| Modifier | `lines[].modifier` | the single source for the modifier |
| ICD-10 Code | `icd10_codes` | comma-separated string |
| Charge Amount | `lines[].charge` | `$` and commas stripped |
| Facility Name | `facility_name` | |
| Rendering Provider / Rendering NPI | `rendering_provider` / `rendering_npi` | |
| Billing Provider / Billing Npi | `billing_provider` / `billing_npi` | |
| Status | — | `""` = unbilled; set to `processing`, then `done` or `error` |

Units are fixed at `1` (the sheet has no units column).

## What still needs a human

- **Anything not yet set up in Office Ally.** A new provider, facility, or unregistered
  patient makes the claim fail with `expected 1 match, found 0`. That's the fail-safe
  working; someone has to add the record in Office Ally first.
- **Sheet ↔ Office Ally name mismatches.** These are the most common recurring failure, e.g.
  `GLENN ROBINSON EL` on the sheet vs `Glenn Robinson` in Office Ally.
- **Insurance is never written.** `insurance_name` / `member_id` are accepted but not
  entered; the claim relies on the payer already being on the patient's record.
- **Two modifiers on one line** would need `ModifierB` writing to be reinstated.

## Known limitations

- Clicking Update is fire-and-forget — the agent waits 4s and reports success without
  re-reading the saved visit.
- If the n8n HTTP call times out (180s) after Office Ally has already saved, the row is
  marked `error` and would be re-billed on the next run.
- `logs/<claimId>/run.log` records the full claim payload, including PHI, in plaintext.
- Office Ally's ASP.NET control IDs are hardcoded (`Button35` facility, `Button57` billing
  provider, the `ucBillingCPT_*` grid); a UI change there breaks the flow.
