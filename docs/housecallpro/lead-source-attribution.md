# HouseCall Pro Lead-Source Attribution (HCP → Twilio → Retell)

**Feature:** capture *which HouseCall Pro tracking line a customer originally dialed* and surface it to the Retell voice agent and this backend as `lead_source_number`, so the agent knows the marketing/lead source and jobs can be attributed to it.

**Status:** live. Backend side shipped in PR #24 (`lead_source_number` in the inbound webhook response). Telephony side is a dedicated Twilio number + Twilio Function that fronts the Retell agent.

---

## 1. Problem statement

A customer dials one of the business's HouseCall Pro **tracking / lead-source numbers** (e.g. a Google LSA line, a Yelp line, a truck-wrap line). HCP's native voice flow forwards that call to our AI voice agent (Retell). We need the agent — and this backend — to know **which HCP line was dialed**, not just who's calling.

What we get "for free" on the receiving end is only:

- `from_number` — the customer's mobile number.
- `to_number` — the final endpoint the call landed on.

The identity of the **intermediate HCP tracking line** (the actual lead source) is the piece we need, and it is the piece that ordinary call forwarding erases before it reaches Retell.

---

## 2. Why the naïve approaches don't work

### 2a. HCP native forwarding straight into a Retell-owned number

This is the obvious setup, and it loses the data. Observed inbound webhook payload when HCP forwarded directly to the Retell number (note: only the **customer** number survives; no trace of the dialed HCP line):

```json
{
  "call_inbound": {
    "override_agent_id": "agent_a08ec7149d923ea9923b3872de",
    "dynamic_variables": {
      "status": "not_found",
      "from_number": "+14155201480",
      "new_number_detected": "true",
      "...": "..."
    }
  }
}
```

Two compounding reasons:

- **HCP routes over the PSTN / carrier network.** Traditional carrier hand-offs drop application-layer routing context. The original-dialed-number metadata (SIP `Diversion` / `History-Info`) is not guaranteed to survive a carrier forward, and in practice does not survive HCP's.
- **Retell-owned numbers are a managed black box.** Numbers bought *inside* Retell run on Retell's own managed Twilio account. Their configuration only parses standard `from`/`to` and hands you the customer number — you get **no programmatic interception point** to read forwarding metadata or inject custom SIP headers. You cannot change that behavior on a Retell-owned number.

### 2b. "But HCP numbers are Twilio numbers — can't they pass headers?"

Empirically true but insufficient. Lookups confirmed HCP's telephony stack runs on **Twilio** — every HCP number is a Twilio-leased carrier number. However, HCP's numbers and our systems live in **separate, isolated Twilio parent accounts**. Twilio account *A* (HCP) cannot inject proprietary programmatic headers or session context into the webhooks of Twilio account *B* (ours) over a standard voice forward — it's treated as a generic external carrier transfer, and advanced routing context is scrubbed.

### 2c. Retell "Bring your own SIP / Termination URI" wizard

This is the wrong wizard for inbound. The field is explicitly labelled **"Termination URI (NOT Retell SIP server URI)"** — it's for Retell to send calls *outbound to your PBX* (3CX/FreePBX/etc.), i.e. it makes Retell the SIP **client**. For our flow we need Retell to be the SIP **server** that our Twilio number dials into. Don't use this page.

---

## 3. The finding that cracked it

Before building any SIP bridge, we ran a 30-second empirical probe: a throwaway Twilio Function on **our own** Twilio number that logs the entire inbound payload.

```javascript
exports.handler = function (context, event, callback) {
  console.log("RAW TWILIO EVENT:", JSON.stringify(event, null, 2));
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.say("Diagnostic test complete.");
  callback(null, twiml);
};
```

Forwarding an HCP tracking line to that number and reading the Twilio logs showed the HCP line **does** survive — in **`event.CalledVia`** (Twilio's parameter for the number that forwarded the call). It survives precisely because, once the leg lands on **our** Twilio number, it is a Twilio-in-network hop and Twilio can populate `CalledVia`.

**Conclusion:** the lead-source number is recoverable — but only if we catch the call **on our own Twilio number, programmatically, before it reaches Retell.** That is the whole reason we buy a dedicated Twilio number and attach a Function, rather than forwarding straight to Retell.

> ⚠️ `CalledVia` is only populated when the forwarding leg is a Twilio number in the same account context. If HCP ever forwards from a non-Twilio carrier, `CalledVia` is absent and the code below falls back to `"unknown"`. Fallbacks: read `event.To` (with 1:1 line→number mapping) or an explicit HCP-supplied SIP header. See §7.

---

## 4. Solution architecture

Buy our **own** voice-enabled Twilio number, point HCP's forwarding at it, and have a Twilio Function intercept the call, register it with Retell (carrying the lead source), and bridge the audio to Retell over SIP.

```
[ Customer ]
     │  dials a marketing/tracking line
     ▼
[ HouseCall Pro tracking number ]
     │  HCP native voice-flow forward  (in-network → CalledVia preserved)
     ▼
[ OUR Twilio number  +1 (747) 677-1558 ]
     │  "A call comes in" → Twilio Function
     ▼
[ Twilio Function  /route-call ]
     │  reads event.CalledVia  (= the HCP line)
     │  Retell registerPhoneCall({ agent_id, from_number, to_number: hcpLine,
     │                             dynamic_variables: { lead_source_number } })
     │  → returns call_id
     ▼  <Dial><Sip>sip:{call_id}@sip.retellai.com</Sip></Dial>
[ Retell AI agent (SIP) ]
     │  fires inbound webhook to THIS backend
     ▼
[ /api/housecallpro/retell/webhook ]  → echoes lead_source_number in dynamic_variables
```

Why each piece is load-bearing:

- **Our own Twilio number** (not Retell's) = the only place we get a programmable interception point where `CalledVia` is readable.
- **Voice capability is mandatory** — the number must both terminate the inbound PSTN leg and originate the outbound SIP leg to Retell. SMS/MMS are incidental and unused.
- **The Twilio Function** extracts the three distinct numbers and pre-registers the call with Retell, binding the lead source before any audio reaches the agent.
- **SIP dial to `sip:{call_id}@sip.retellai.com`** hands the media to the exact pre-registered Retell session.

---

## 5. The Twilio Function (`hcp-retell-router` / `/route-call`)

Deployed source (Retell key redacted — see §8 security note; it must move to an env var):

```javascript
const Retell = require("retell-sdk");
const client = new Retell({ apiKey: context.RETELL_API_KEY }); // TODO: env var, not hardcoded

exports.handler = async function (context, event, callback) {
  console.log("Full event:", JSON.stringify(event)); // diagnostic — read in the Functions log pane

  const twiml = new Twilio.twiml.VoiceResponse();
  const hcpLine = event.CalledVia || "unknown"; // the original HCP tracking line

  const phoneCallResponse = await client.call.registerPhoneCall({
    agent_id: "agent_21334d8120e975619dbf31af98", // main router agent
    from_number: event.From,   // the customer
    to_number: hcpLine,        // the HCP lead-source line (intentional; see note)
    direction: "inbound",
    retell_llm_dynamic_variables: {
      lead_source_number: hcpLine,
    },
  });

  const dial = twiml.dial();
  dial.sip(`sip:${phoneCallResponse.call_id}@sip.retellai.com`);
  return callback(null, twiml);
};
```

**The `to_number` inversion (intentional):** the Twilio number itself is identical on every call and therefore useless as a lead-source signal. So the Function passes the **originally dialed HCP line** as `to_number` *and* as the `lead_source_number` dynamic variable. That lets **one** Twilio number + **one** Retell agent serve **many** HCP tracking lines while the agent still knows the source. (This is also why our backend reads `to_number` as the lead source — see §6.)

---

## 6. Backend tie-in (this repo)

Retell fires the inbound webhook to `POST /api/housecallpro/retell/webhook` ([src/routes/housecallpro.ts](../../src/routes/housecallpro.ts)). Because the Function set `to_number = hcpLine`, the webhook sees the HCP line as `call_inbound.to_number`. PR #24 echoes it back to the agent as a dynamic variable, on **all four** inbound paths (`found` / `multiple_matches` / `not_found` / `error`):

```json
{
  "call_inbound": {
    "override_agent_id": "agent_...",
    "dynamic_variables": {
      "lead_source_number": "<call_inbound.to_number = the HCP line>",
      "from_number": "<customer>",
      "status": "found",
      "...": "..."
    }
  }
}
```

Agents consume it as `{{lead_source_number}}`.

> **Multi-line caveat (important).** Tenant resolution currently keys off `to_number` (`resolveByInboundNumber` → `housecallpro_tokens.no`), and `housecallpro_tokens` has `unique(tenant_id)`. Now that `to_number` carries the *HCP line*, that line must be the value stored in `no`, and a client with **multiple** lead-source lines can't be represented as multiple token rows. Planned fix: resolve the tenant by the Retell **`agent_id`** (with a `to_number` fallback) so `lead_source_number` can vary freely per call while all lines map to one client. Tracked as a follow-up, not yet implemented.

---

## 7. Failure modes & troubleshooting

Diagnostic order when a call misbehaves:

1. **Twilio → number → Call logs** — did Twilio receive the call, and did `/route-call` return 200?
2. **Twilio → Functions → live logs** — did `Full event:` print, and is `CalledVia` populated?
3. **Retell dashboard** — was the call registered, and did the SIP leg connect?

Most likely failures:

| Symptom | Cause | Fix |
|---|---|---|
| `lead_source_number` is `"unknown"` | `event.CalledVia` empty — HCP forwarded from a non-Twilio carrier leg | Fall back to `event.To` with a 1:1 HCP-line→Twilio-number mapping, or an explicit SIP header |
| Calls stop routing after a redeploy | Functions service was deleted/recreated → the `-2767` domain suffix changed | Re-point the number's Voice config at the new Function URL |
| Routing breaks with no code change | `retell-sdk` pinned to `*` pulled a new major version | Pin `retell-sdk` to the known-good version |
| Second HCP line 404s (`unknown inbound number`) | Tenant resolved by `to_number`; only the registered line matches | Implement the `agent_id` resolution fallback (§6) |
| Caller hears Twilio's default failure | `registerPhoneCall` threw; Function has no `try/catch` | Wrap in try/catch with a spoken fallback + forward to a human line |

---

## 8. Security & hardening follow-ups

- **Move the Retell API key out of the Function source** into a Twilio env var (`RETELL_API_KEY`, read as `context.RETELL_API_KEY`) and **rotate** the current key — it has been sitting in plaintext in the editor.
- **Pin `retell-sdk`** to an explicit version (it is `*`).
- **Wrap `registerPhoneCall` in try/catch** with a `twiml.say(...)` fallback and human transfer.
- **Point the backup voice handler at a genuinely independent fallback** (it currently points at the same `/route-call`, so it only survives a transient invocation blip, not a bug/outage).
- **Delete the leftover `/welcome` boilerplate** function.
- Optionally set a **status-callback URL** for call analytics, and add an **emergency address** only if outbound calling is ever introduced (inbound-only needs none).

---

## 9. Configuration reference (everything needed to rebuild)

All in one Twilio project, US1 region. Identifiers are not secrets on their own (the API key/auth token are the secrets — keep those out of the repo):

```
Twilio project           Clara Voice
Account SID              AC******************************  (see Twilio console → Account Info)
Region                   US1

Twilio number            +1 (747) 677-1558   (E.164 +17476771558)
  friendly name          HCP-Call-Router
  type / capabilities    US local · Voice (+ incidental SMS/MMS)

Functions service        hcp-retell-router
  service domain         hcp-retell-router-2767.twil.io   (the -2767 is fragile; see §7)
  environment            ui
  function (live)        /route-call → https://hcp-retell-router-2767.twil.io/route-call
  function (unused)      /welcome  (delete)
  runtime                Node.js v22
  dependency             retell-sdk  (⚠ version "*", on page 2 of the Dependencies table)
  env var                Add Twilio Credentials = on; RETELL_API_KEY should be added here

Retell agent (router)    agent_21334d8120e975619dbf31af98
Retell SIP endpoint      sip.retellai.com   (dialed as sip:{call_id}@sip.retellai.com)
```

### Setup steps

**Twilio — buy the number**
1. Phone Numbers → Manage → **Buy a number** → Country = United States, Area code `747`, capability **Voice** checked → Buy.
2. Rename it (Edit friendly name) to `HCP-Call-Router` for self-documentation.

**Twilio — the Function**
3. Develop (`</>`) → Functions & Assets → Services → **Create Service** `hcp-retell-router`.
4. **Add Function** → path `/route-call`; paste the §5 code.
5. Settings & More → **Dependencies**: runtime Node.js v22; add `retell-sdk` (pin the version).
6. Settings & More → **Environment Variables**: add `RETELL_API_KEY` (don't hardcode).
7. **Save**, then **Deploy All** (dependency/runtime changes only go live after Deploy All). Confirm "Latest version is deployed" and that the public URL resolves.

**Twilio — bind the number to the Function**
8. Phone Numbers → Active numbers → `+1 (747) 677-1558` → **Voice & Fax** → *A Call Comes In*:
   - Configure with: **Function**
   - Service: `hcp-retell-router`  ·  Environment: `ui`  ·  Path: `/route-call`
   - Save. (Prefer selecting the Function by service/env/path over pasting the URL — the binding then survives redeploys.)

**HouseCall Pro**
9. In HCP's native voice-flow / call-tracking settings, change each tracking line's forwarding destination to `+1 (747) 677-1558` (instead of the old Retell-owned number). Retire the Retell-owned number from this loop.

**This backend**
10. Ensure `housecallpro_tokens.no` holds the HCP line(s) (single-line today), `agent_id` populated. The webhook at `/api/housecallpro/retell/webhook` already returns `lead_source_number`. Plan the `agent_id`-based tenant resolution before a second line goes live (§6).

---

## 10. TL;DR

HCP hides the dialed tracking line behind a carrier forward, and Retell-owned numbers give no interception point — so the lead source is lost. We forward HCP into **our own** Twilio number, where a Twilio Function reads `event.CalledVia` (the HCP line), registers the call with Retell carrying `lead_source_number`, and SIP-dials the agent. This backend's inbound webhook echoes `lead_source_number` (from `to_number`) to the agent as `{{lead_source_number}}`. One Twilio number + one router agent can serve many HCP lines; the outstanding work is moving tenant resolution to `agent_id` so multiple lead-source lines can share one client.
