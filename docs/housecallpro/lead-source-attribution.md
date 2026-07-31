# HouseCall Pro Lead-Source Attribution (HCP → Retell)

**Feature:** capture *which HouseCall Pro tracking line a customer originally dialed* and surface it to the Retell voice agent and this backend as `lead_source_number`, so the agent knows the marketing/lead source and jobs/customers can be attributed to it.

**Status:** live.

- **Primary path (recommended):** the HCP number is imported directly into Retell (Provider: Twilio) with an **inbound webhook** pointing at this backend. The dialed tracking line rides in the SIP **`Diversion`** header, which Retell surfaces as the `{{diversion}}` dynamic variable. This backend parses it, stores it on the call session, and resolves the lead source from it. **No dedicated Twilio number or Function is required.** See §2–§6.
- **Legacy / fallback path:** a dedicated Twilio number + Twilio Function that reads `event.CalledVia` and pre-registers the call with Retell. Retained for the `+17476771558` setup and for carriers that strip `Diversion`. See §7.

---

## 1. Problem statement

A customer dials one of the business's HouseCall Pro **tracking / lead-source numbers** (e.g. a Google LSA line, a Yelp line, a truck-wrap line). HCP's native voice flow forwards that call to our AI voice agent (Retell). We need the agent — and this backend — to know **which HCP line was dialed**, not just who's calling.

What arrives on the receiving end "for free" is:

- `from_number` — the customer's mobile number.
- `to_number` — the number the call finally landed on. When many tracking lines forward through one shared Twilio DID (the common setup), `to_number` is that **shared DID** and cannot distinguish lead sources.

The identity of the **intermediate HCP tracking line** (the actual lead source) is the piece we need.

---

## 2. Where the tracking line lives: the SIP `Diversion` header

When HCP forwards the call, the originally dialed line is preserved in the SIP **`Diversion`** header (`reason=unconditional`). Retell allowlists `Diversion` (along with `User-to-User`, `History-Info`, `P-Asserted-Identity`) into the inbound call's `custom_sip_headers` and **auto-adds it to the call's dynamic variables** ([Retell SIP headers docs](https://docs.retellai.com/build/telephony/sip-headers)).

Observed live on call `call_335c6bc6...` (dialed line `+17473492132` = "Angie's Leads"), in the call's dynamic variables:

```
diversion: <sip:+17473492132@twilio.com>;reason=unconditional
from_number: +14155201480
to_number: +17478373403          ← the shared Twilio DID (NOT a lead source)
```

The number inside the `Diversion` value (`+17473492132`) is the lead source. `parseDiversionNumber` in [src/services/housecallpro/sip.ts](../../src/services/housecallpro/sip.ts) extracts it.

> **History note.** Retell previously stripped standard SIP headers (including `Diversion`) at its Kamailio ingress layer, so early experiments saw only the customer number — which is why the legacy Twilio-Function workaround (§7) was built. Retell fixed the stripping on **2026-07-16** (community threads [3307](https://community.retellai.com/t/inbound-sip-diversion-header-not-visible-in-webhook-custom-sip-headers/3307), [3295](https://community.retellai.com/t/diversion-sip-header-stripped-missing-from-custom-sip-headers-webhook-payload/3295)). The `Diversion` header now survives, which is what makes the simpler primary path possible.

---

## 3. Recommended architecture (direct inbound webhook)

Import the HCP-forwarded number into Retell and enable its inbound webhook — no interception layer of our own is needed.

```
[ Customer ]
     │  dials a marketing/tracking line
     ▼
[ HouseCall Pro tracking number ]   e.g. +17473492132 ("Angie's Leads")
     │  HCP native voice-flow forward  (SIP Diversion header preserved)
     ▼
[ Shared Twilio DID imported into Retell ]   e.g. +17478373403
     │  Retell fires the inbound webhook (Diversion in custom_sip_headers /
     │  auto-added to {{diversion}})
     ▼
[ POST /api/housecallpro/retell/webhook ]
     │  parse Diversion → lead_source_number → store on call session
     │  echo lead_source_number back in dynamic_variables
     ▼
[ Retell AI agent ]  → book_job / create_customer resolve lead source from
                        the stored tracking line
```

Retell number config (dashboard → Phone Numbers → the DID):
- **Inbound Call Agent:** the tenant's agent.
- **Add an inbound webhook:** ✅ → `https://crm-appointment-scheduler.vercel.app/api/housecallpro/retell/webhook`

---

## 4. Backend implementation (this repo)

Router: [src/routes/housecallpro.ts](../../src/routes/housecallpro.ts). Helper: [src/services/housecallpro/sip.ts](../../src/services/housecallpro/sip.ts).

1. **`call_inbound`** — parse the `Diversion` from `call_inbound.custom_sip_headers` (falling back to `call.custom_sip_headers` / `call.retell_llm_dynamic_variables`) via `diversionNumberFrom`. Store the parsed tracking line on the new call session (`housecallpro_callsessions.lead_source_number`). Echo `lead_source_number` (the tracking line, falling back to `to_number` when the header is absent) back to the agent in `dynamic_variables` on **all** inbound paths (`found` / `multiple_matches` / `not_found` / `error`). Agents consume it as `{{lead_source_number}}`.

2. **`call_started`** — the `Diversion` value is reliably present as a dynamic variable by now, so backfill `lead_source_number` onto the session if `call_inbound` didn't capture it.

3. **Attribution** — `book_job` and `create_customer` resolve the source with:

   ```ts
   resolveLeadSource(session.leadSourceNumber ?? session.toNumber)
   ```

   `resolveLeadSource` ([src/services/housecallpro/db/leadSources.ts](../../src/services/housecallpro/db/leadSources.ts)) looks the number up in `housecallpro_lead_sources` (`lead_phone_no` → `lead_name` / `lead_source_id`, exact then last-10 fuzzy) and stamps `lead_source` on the job/customer, falling back to **`Clara`** when there is no mapping.

Fallback chain for the stamped source: **`Diversion` tracking line → `to_number` → `Clara`**.

Migration for the session column: [migrations/20260731_002_housecallpro_callsession_lead_source_number.sql](../../migrations/20260731_002_housecallpro_callsession_lead_source_number.sql).

---

## 5. Troubleshooting

Diagnostic order:

1. **Retell dashboard → the call → Data tab** — is `diversion` present in the dynamic variables, and does it contain the expected tracking line?
2. **Backend logs** (`[hcp] call_inbound` / `[hcp] call_started captured lead_source_number`) — was a `leadSourceNumber` parsed, and is it stored on the session row?
3. **`housecallpro_lead_sources`** — does the tracking line have a row (exact or last-10 match)?

| Symptom | Cause | Fix |
|---|---|---|
| `lead_source` stamped as `Clara` | `Diversion` absent/misparsed, or the tracking line has no row in `housecallpro_lead_sources` | Confirm `diversion` in the call's Data tab; check the `lead_source_number` session column; add/clean the `housecallpro_lead_sources` row (watch for stray whitespace/newlines in `lead_phone_no` / `lead_source_id`) |
| `lead_source_number` equals the shared DID | `Diversion` header not received (carrier stripped it, or a non-forwarded direct call) | Verify HCP forwards with a `Diversion` header; otherwise use the legacy `CalledVia` path (§7) or a 1:1 line→DID map |
| `diversion` value shape differs from the parser's expectation | Provider formats the header differently | Inspect the raw `call_started` payload (temporary `console.log(JSON.stringify(req.body))`) and adjust `parseDiversionNumber` |

---

## 6. Multi-line / tenant-resolution caveat

Tenant resolution currently keys off `to_number` (`resolveByInboundNumber` → `housecallpro_tokens.no`). In the primary path `to_number` is the **shared DID**, so a client with many tracking lines maps to **one** token row keyed by that DID — which is fine, because the lead source is now carried separately by `lead_source_number` (the `Diversion` line). This removes the old constraint (documented in the legacy path) that each tracking line needed its own token row. `housecallpro_lead_sources` remains global (keyed by tracking line), independent of tenant tokens.

---

## 7. Legacy / fallback path — dedicated Twilio number + Function (`CalledVia`)

> **Legacy.** Built before Retell's 2026-07-16 `Diversion` fix, when the tracking line was believed unrecoverable on the receiving end. Prefer the primary path (§2–§6). Keep this for the existing `+17476771558` setup, or as a fallback for carriers that strip `Diversion` (where `event.CalledVia` on our own Twilio number still preserves the line).

### 7.1 Why it was needed (historical)

- **HCP routes over the PSTN / carrier network,** and carrier hand-offs were thought to drop the original-dialed-number metadata (`Diversion` / `History-Info`). In practice the loss was actually Retell's ingress stripping (now fixed).
- **Retell-owned numbers are a managed black box** — no programmatic interception point to read forwarding metadata or inject custom SIP headers.
- The **"Bring your own SIP / Termination URI"** wizard is for *outbound* SIP (Retell as SIP client to your PBX), not this inbound flow — don't use it.

### 7.2 The finding that cracked it

A throwaway Twilio Function on **our own** Twilio number logged the whole inbound payload and showed the HCP line survives in **`event.CalledVia`** (Twilio's parameter for the number that forwarded the call), because once the leg lands on our Twilio number it is a Twilio-in-network hop.

> ⚠️ `CalledVia` is only populated when the forwarding leg is a Twilio number in the same account context. If HCP forwards from a non-Twilio carrier, `CalledVia` is absent — fall back to `event.To` (with a 1:1 line→number mapping).

### 7.3 Architecture

Buy our **own** voice-enabled Twilio number, point HCP's forwarding at it, and have a Twilio Function intercept, register the call with Retell (carrying the lead source), and bridge to Retell over SIP.

```
[ Customer ] → [ HCP tracking number ] → [ OUR Twilio number +17476771558 ]
     → Twilio Function /route-call
         reads event.CalledVia (= the HCP line)
         Retell registerPhoneCall({ agent_id, from_number,
                                    to_number: hcpLine,
                                    dynamic_variables: { lead_source_number } })
         → <Dial><Sip>sip:{call_id}@sip.retellai.com</Sip></Dial>
     → [ Retell AI agent ] → inbound webhook to this backend
```

### 7.4 The Twilio Function (`hcp-retell-router` / `/route-call`)

```javascript
const Retell = require("retell-sdk");
const client = new Retell({ apiKey: context.RETELL_API_KEY }); // env var, not hardcoded

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const hcpLine = event.CalledVia || "unknown"; // the original HCP tracking line

  const phoneCallResponse = await client.call.registerPhoneCall({
    agent_id: "agent_21334d8120e975619dbf31af98",
    from_number: event.From,
    to_number: hcpLine,        // inversion: pass the HCP line as to_number
    direction: "inbound",
    retell_llm_dynamic_variables: { lead_source_number: hcpLine },
  });

  const dial = twiml.dial();
  dial.sip(`sip:${phoneCallResponse.call_id}@sip.retellai.com`);
  return callback(null, twiml);
};
```

**The `to_number` inversion:** since the Twilio number is identical on every call, the Function passes the **originally dialed HCP line** as `to_number` *and* as `lead_source_number`, so one Twilio number + one agent can serve many lines. In this mode the backend reads the HCP line from `call_inbound.to_number`, and multi-line clients need the `agent_id`-based tenant-resolution fallback (this is the constraint the primary path removes — see §6).

### 7.5 Configuration reference (legacy)

```
Twilio number            +1 (747) 677-1558   (E.164 +17476771558)  friendly name HCP-Call-Router
Functions service        hcp-retell-router   (service domain hcp-retell-router-2767.twil.io)
  function (live)        /route-call         runtime Node.js v22    dependency retell-sdk (pin it!)
  env var                RETELL_API_KEY      (do NOT hardcode the key)
Retell agent (router)    agent_21334d8120e975619dbf31af98
Retell SIP endpoint      sip.retellai.com    (dialed as sip:{call_id}@sip.retellai.com)
```

Setup: buy a Voice-capable US number → create the `hcp-retell-router` Function service with `/route-call` (pin `retell-sdk`, add `RETELL_API_KEY`, Deploy All) → bind the number's *A Call Comes In* to the Function (select by service/env/path so it survives redeploys) → point each HCP tracking line's forwarding at the Twilio number.

### 7.6 Legacy failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `lead_source_number` is `"unknown"` | `event.CalledVia` empty — non-Twilio carrier leg | Fall back to `event.To` with a 1:1 HCP-line→Twilio-number map |
| Calls stop routing after a redeploy | Functions service recreated → `-2767` domain suffix changed | Re-point the number's Voice config at the new Function URL |
| Routing breaks with no code change | `retell-sdk` pinned to `*` pulled a new major version | Pin `retell-sdk` |
| Caller hears Twilio's default failure | `registerPhoneCall` threw; no `try/catch` | Wrap in try/catch with a spoken fallback + human transfer |

### 7.7 Legacy security follow-ups

- Move the Retell API key into a Twilio env var (`RETELL_API_KEY`) and **rotate** any key that was ever hardcoded.
- Pin `retell-sdk` to an explicit version.
- Wrap `registerPhoneCall` in try/catch with a `twiml.say(...)` fallback + human transfer.
- Point the backup voice handler at a genuinely independent fallback; delete leftover boilerplate functions.

---

## 8. TL;DR

The dialed HCP tracking line is the lead source, but `to_number` is a shared DID that can't distinguish lines. The line rides in the SIP **`Diversion`** header, which Retell now exposes as `{{diversion}}` (after its 2026-07-16 ingress fix). The backend parses `Diversion` at `call_inbound`/`call_started`, stores it on the call session as `lead_source_number`, and `book_job`/`create_customer` resolve the source from it via `housecallpro_lead_sources` (fallback `to_number` → `Clara`). The older dedicated-Twilio-number + Function (`CalledVia`) approach is kept as a legacy/fallback (§7).
