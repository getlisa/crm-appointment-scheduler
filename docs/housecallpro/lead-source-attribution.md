# HouseCall Pro Lead-Source Attribution (HCP → Twilio Function → Retell)

**Feature:** capture *which HouseCall Pro tracking line a customer originally dialed* (the marketing/lead source — GMB, Yelp, "Angie's Leads", …), carry it through the call as `lead_source_number`, and stamp the resolved lead source onto the HCP job so every booked job is attributed to the source the caller actually came from.

**Status:** live and working. This doc reflects the final architecture — read §2 first, because the single most important fact is that **`call_inbound` never fires in this setup**.

---

## 1. Architecture (what actually runs)

```
[ Customer ]  dials a marketing/tracking line
     │
     ▼
[ HCP tracking number ]  e.g. +17473492132 ("Angie's Leads")
     │  HCP forwards →
     ▼
[ Twilio number + Twilio Function ]  registerPhoneCall(...)
     │    • from_number = caller           (+14155201480)
     │    • to_number   = tenant DID        (+17478373403, in housecallpro_tokens)
     │    • retell_llm_dynamic_variables.lead_source_number = the HCP tracking line (+17473492132)
     │  Function then <Dial><Sip> into Retell with the returned call_id
     ▼
[ Retell agent ]  (call is PRE-REGISTERED → Retell does NOT call the inbound webhook)
     │  Retell → this backend, only via:
     │    • call_started  (POST /retell/webhook)   ← we create the session here
     │    • call_ended    (POST /retell/webhook)
     │    • /fn/*         (custom-function calls during the conversation)
     ▼
[ crm-appointment-scheduler ]  session state → book_job stamps lead_source on HCP job
```

Because the Twilio Function pre-registers the call, **the whole `call_inbound` identify-and-greet mechanism is bypassed.** Everything the backend needs is taken from `call_started` and the `/fn/*` calls instead.

---

## 2. Why `call_inbound` never fires (the key gotcha)

Retell fires its **inbound-call webhook** only for calls that arrive at a Retell number *un-registered*, so it can ask you which agent + dynamic variables to use. Our calls are **pre-registered** by the Twilio Function via `registerPhoneCall` — agent and dynamic variables are supplied up front — so Retell **skips `call_inbound` entirely**. Only the agent-lifecycle webhooks (`call_started`, `call_ended`, `call_analyzed`) and the `/fn/*` custom-function calls reach the backend.

Symptoms when this wasn't understood (all now fixed): the Vercel logs showed `call_started`/`call_ended`/`fn/*` but **zero `call_inbound`**; `housecallpro_callsessions` stayed empty (the session used to be created in the `call_inbound` handler); and every `/fn/*` failed `resolveSession` with "session not found", so the agent never identified the caller.

> The `call_inbound` handler still exists in the router for a possible direct-inbound-webhook tenant, but for this HCP/Twilio-Function setup it is dead code — do not rely on it.

---

## 3. The Twilio Function (`registerPhoneCall`)

The Function fronts the tenant's number and registers the call with Retell, carrying the three things the backend needs. Critically it keeps `to_number` = the **tenant DID** (so tenant resolution by `housecallpro_tokens.no` works) and carries the **tracking line** separately in `lead_source_number`:

```javascript
const Retell = require("retell-sdk");
const client = new Retell({ apiKey: context.RETELL_API_KEY }); // env var, do NOT hardcode

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const hcpLine = event.CalledVia || event.From; // the HCP tracking line the caller dialed

  const phoneCallResponse = await client.call.registerPhoneCall({
    agent_id: "agent_a08ec7149d923ea9923b3872de",     // the Office-Hours agent
    from_number: event.From,                            // the customer
    to_number: event.To,                                // the tenant DID (in housecallpro_tokens)
    direction: "inbound",
    retell_llm_dynamic_variables: { lead_source_number: hcpLine }, // the tracking line
  });

  const dial = twiml.dial();
  dial.sip(`sip:${phoneCallResponse.call_id}@sip.retellai.com`);
  return callback(null, twiml);
};
```

`lead_source_number` is derived from `event.CalledVia` (Twilio's forwarded-from parameter, populated because the forward lands in-network on our Twilio number). If a carrier ever strips it, `lead_source_number` may be blank and attribution falls back (see §5).

---

## 4. The `call_started` payload and how we use it

This is the real event the backend receives (fields trimmed):

```json
{
  "event": "call_started",
  "call": {
    "call_id": "call_67ae4837aacb5773a55cbc50758",
    "agent_id": "agent_a08ec7149d923ea9923b3872de",
    "from_number": "+14155201480",
    "to_number": "+17478373403",
    "direction": "inbound",
    "retell_llm_dynamic_variables": { "lead_source_number": "+17473492132" }
  },
  "event_timestamp": 1785536594615
}
```

The backend reads four fields:

| Field | Used for |
|---|---|
| `call.from_number` | the caller → session `caller`; later phone-matched by `customer_lookup` |
| `call.to_number` | the tenant DID → tenant resolution (`resolveByInboundNumber` → `housecallpro_tokens.no`) |
| `call.retell_llm_dynamic_variables.lead_source_number` | the HCP tracking line → session `lead_source_number` (lead-source attribution) |
| `call.call_id` | `retell_call_id` → correlates the `/fn/*` calls to this session |

`leadSourceNumberFromCall()` ([src/routes/housecallpro.ts](../../src/routes/housecallpro.ts)) reads `retell_llm_dynamic_variables.lead_source_number` first, then falls back to the SIP `Diversion` header via `diversionNumberFrom` ([src/services/housecallpro/sip.ts](../../src/services/housecallpro/sip.ts)) for any non-Function tenant.

---

## 5. Backend flow

Router: [src/routes/housecallpro.ts](../../src/routes/housecallpro.ts).

1. **`call_started` → create the session.** `ensureCallSession()` (idempotent get-or-create) inserts `housecallpro_callsessions` with `caller = from_number`, `to_number`, `lead_source_number` (from the dynamic variable), and `retell_call_id = call_id`. Column added by [migrations/20260731_002_housecallpro_callsession_lead_source_number.sql](../../migrations/20260731_002_housecallpro_callsession_lead_source_number.sql).
2. **`/fn/*` → `resolveSession` is create-if-missing.** If `call_started` was somehow missed, the first function call rebuilds the session from its `call` payload (same `ensureCallSession`). So `/fn/*` can never fail with "session not found".
3. **Identification is a function, not a webhook.** The agent calls **`/fn/customer_lookup`** ([handlers/customer-lookup.ts](../../src/services/housecallpro/handlers/customer-lookup.ts)), which phone-matches the session `caller` against `housecallpro_customers.normalized_mobile` and, on a single hit, records the customer on the session (`setMatchedCustomer`). Returns `found` / `not_found` / `multiple_matches` (same shape as `lookup_customer_fuzzy`).
4. **`book_job` resolves all three HCP inputs from session state** ([handlers/job.ts](../../src/services/housecallpro/handlers/job.ts)) — the agent never threads IDs:
   - `customer_id` ← `session.housecallproCustomerId` (set by `customer_lookup` / `confirm_customer` / `lookup_customer_fuzzy` / `create_customer`)
   - `address_id` ← `session.serviceAddressMap.selectedAddressId` (set by `match_address` / `create_address`), or an explicit `address_id` arg
   - `lead_source` ← `resolveLeadSource(session.leadSourceNumber ?? session.toNumber)`

### Lead-source resolution + the HCP name gotcha

`resolveLeadSource` ([db/leadSources.ts](../../src/services/housecallpro/db/leadSources.ts)) looks the tracking line up in `housecallpro_lead_sources` (`lead_phone_no` → `lead_name` / `lead_source_id`, exact then last-10 fuzzy) and returns `lead_name`. `book_job` sends that string to HCP `POST /jobs` as `lead_source`, falling back to `to_number` then the literal `Clara`.

> **⚠ HCP validates `lead_source` against the account's configured lead sources by name.** If the string is not an existing HCP lead source, `POST /jobs` returns `400 {"error":{"message":"Lead source not found"}}` and the job is **not** created. Therefore `housecallpro_lead_sources.lead_name` must be the **exact** name of a lead source configured in that HCP account (e.g. HCP's "Angi" vs a stored "Angie's Leads" will fail). Keep the stored names in sync with HCP, and watch for stray whitespace/newlines.

Fallback chain for the stamped source: **tracking line's `lead_name` → `to_number` → `Clara`**.

---

## 6. Office-Hours agent changes

The agent config ([retell/Zephyr Heating and Air LLC - Office Hours (1).json](../../retell/Zephyr%20Heating%20and%20Air%20LLC%20-%20Office%20Hours%20(1).json)) was reworked for this flow (it is a single-prompt `retell-llm` agent, so it reads identity straight from each function's `result` — there are no `response_variables`):

- **New `customer_lookup` tool** (no parameters) — called once the caller states a service need.
- **Identification is function-driven, not webhook-driven.** The old prompt keyed off `{{status}}` / `{{customer_id}}` / `{{caller_name}}` dynamic variables set by `call_inbound`; those are gone. Flow now: greet generically → on a service request call `customer_lookup` → `found`: greet by `first_name` and go to the address step → `not_found`: `lookup_customer_fuzzy` → (still not found) `create_customer` → `multiple_matches`: `confirm_customer`.
- **Removed the "are you a new or existing customer?" question** (identity comes from the phone match).
- **Greet by name** using the `first_name` returned by whichever identify function succeeded (`create_customer` now returns `first_name` too).
- **Address: one retry.** `match_address` → on `ambiguous`/`not_found`, ask for the full address together (street number + street name + ZIP) and call `match_address` once more → if still no confident match, `create_address`. Never more than twice.
- `{{lead_source_number}}` is available to the agent (set by the Function) but the agent doesn't need to act on it — attribution is server-side.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `POST /jobs → 400 "Lead source not found"` | the `lead_name` we send isn't an exact HCP-configured lead source | align `housecallpro_lead_sources.lead_name` to the exact HCP name; trim whitespace/newlines |
| Agent asks for name/phone instead of greeting | `customer_lookup` not called, or caller not in `housecallpro_customers` | ensure the tool is wired + the customer cache is synced; check `[hcp] customer_lookup` matchCount |
| `lead_source` stamped as `Clara` | tracking line missing from `housecallpro_lead_sources`, or `lead_source_number` not set on the call | check `[hcp] call_started req` shows `leadSourceNumber`; add the `housecallpro_lead_sources` row |
| No `call_inbound` in the logs | expected — the Twilio Function pre-registers the call (see §2) | not a bug; identification is via `call_started` + `customer_lookup` |
| `/fn/*` "session not found" | `call_started` never created the session | `resolveSession` now create-if-missing; confirm `call_started` reaches the server |
| `book_job` "no address selected" / "no customer identified" | booking called before address/identify | prompt enforces order; run `customer_lookup` and `match_address`/`create_address` first |

Useful log lines: `[hcp] call_started req` (shows `leadSourceNumber`), `[hcp] customer_lookup` (matchCount), `[hcp] fn/book_job resp`.

---

## 8. TL;DR

HCP forwards the caller's dialed **tracking line** through a Twilio Function that `registerPhoneCall`s into Retell with `to_number` = the tenant DID and `lead_source_number` = the tracking line. Pre-registration means **`call_inbound` never fires** — the backend creates the session at **`call_started`** (reading `from_number`, `to_number`, and `lead_source_number`), identifies the caller mid-call via **`/fn/customer_lookup`**, and `book_job` resolves `customer_id` + `address_id` + `lead_source` from session state. The stamped `lead_source` **must be an exact HCP-configured lead source name** or HCP rejects the job with "Lead source not found".
