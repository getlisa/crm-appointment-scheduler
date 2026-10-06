# Housecall Pro Call Flows and the Pierce Electric Lead-Only Change

Last verified: 2026-10-05 against the Retell agent exports in `retell/`, the backend handlers in `src/services/housecallpro/`, Pierce Electric's live Housecall Pro (HCP) account, and the email thread with Laura Pierce.

**Status: built.** Pierce Office Hours now calls `create_lead` (`src/services/housecallpro/handlers/lead.ts`). `book_job` stays for Zephyr. The migrations `migrations/20261005_001_housecallpro_job_types.sql` and `20261005_002_housecallpro_leads.sql` still need to be applied to Supabase.

## TL;DR

- Two HCP tenants run on Clara today: Pierce Electric and Zephyr Heating and Air. Each has an Office Hours agent and an After Hours agent.
- Office Hours agents identify the caller in HCP, create the customer if new, then match or create the address. Zephyr then logs an unscheduled job with `book_job`; Pierce logs a lead with `create_lead`.
- After Hours agents take a message and call `escalate`. No HCP writes.
- Pierce Electric is lead-only. New callers and existing customers both get an HCP lead. No job. No estimate. Laura converts leads herself.
- Creating a lead in HCP always creates or requires a customer. HCP documents this. Our tests confirmed it. Laura has accepted it.

## 1. Tenants and agents

| Tenant | Agent | Version | Dialed number | Tools | Writes to HCP |
|---|---|---|---|---|---|
| Pierce Electric | Office Hours | v6 (`llm_07d012403bf79a92a2eddd9dbd8c`) | +1 707 622 3573 | `customer_lookup`, `lookup_customer_fuzzy`, `confirm_customer`, `create_customer`, `match_address`, `create_address`, `book_job`, `set_job_type`, `create_lead`, `end_call` | customer, address, lead |
| Pierce Electric | After Hours | v5 (`llm_70dd7b08d0431b4ba1bc8a016071`) | same line, after-hours routing | `escalate`, `end_call` | none |
| Zephyr Heating and Air | Office Hours | v3 (`llm_5b93a87bda2d0ebba94d5f96708c`) | +1 747 837 3403 | same eight tools as Pierce Office Hours | customer, address, job |
| Zephyr Heating and Air | After Hours | v3 (`llm_1cf81c06aa11ad26685369ac33b6`) | same line, after-hours routing | `escalate`, `end_call` | none |

All four agents: model `gpt-4.1`, agent speaks first, no knowledge base attached yet, PII redaction post-call.

Tenant credentials and notification recipients live in the `housecallpro_tokens` table keyed by dialed number (`src/services/housecallpro/db/tokens.ts`). Pierce notifications go to laura@pierce-inc.com. Zephyr notifications go to dan@zephyrheatingandair.com.

Note on drift: `retell/hcp-pierce/prompt.md` is the authoring source and the checked-in v6 export has been synced to it (including the `create_lead` tool). Neither is published to Retell yet. Originally the export was behind `prompt.md`: It adds the `options` branch for match_address, the three-call cap, and the "number you are calling from is fine" rule for callback numbers. Treat `prompt.md` as the current Pierce Office Hours prompt.

## 2. Backend tool contract (shared by both Office Hours agents)

Routes: `src/routes/housecallpro.ts:540-547`. Every tool call carries the Retell call id. The backend resolves the call session, the tenant API key, and the lead-source tracking line before dispatching.

| Tool | Returns | Backend behaviour |
|---|---|---|
| `customer_lookup` | `found`, `not_found`, `multiple_matches` | Searches HCP by the caller's number. Idempotent: a second call returns the same match. On `not_found` it records nothing so the fuzzy lookup can still run. Every result also carries `ask_lead_source`, true when the dialed line maps to no HCP lead source — the agent's cue to ask "how did you hear about us?" later in the call. |
| `lookup_customer_fuzzy` (name, optional zip, address, old_phone) | `found`, `multiple_matches`, `not_found` | Three confidence tiers. Tier 1 returns `found`. Tier 2 returns `multiple_matches` with candidates. Tier 3 returns `not_found` with reason `low_confidence_matches`. A clear name mismatch against a found address returns `not_found` with reason `name_address_mismatch`. |
| `confirm_customer` (candidate_id) | `confirmed` | Pins the chosen candidate to the session. |
| `create_customer` (first_name, last_name, optional email, mobile_number, company, notes) | `created` | Mobile defaults to the caller's number. Customer gets a `Clara` tag, a note stamped with the call date, and `lead_source` set to the name mapped from the dialed tracking line. If the line is unmapped, no `lead_source` is sent. HCP rejects unknown lead-source names, so an `lsrc_` id is never sent. |
| `match_address` (spoken_address) | `matched`, `options`, `ambiguous`, `not_found`, `no_addresses` | Scores the spoken address against the customer's saved addresses. A spoken address with no digits ("the address on file") returns `matched` if one address exists, otherwise `options` with the list to read back. Below the confidence floor returns `not_found`. Two close scores return `ambiguous` with up to three candidates. |
| `create_address` (street, city, state, zip, optional street_line_2, country) | `created` | Adds the address to the identified customer and selects it. |
| `book_job` (service_type, issue, optional scheduled_start, scheduled_end, address_id) | `created` with `work_status: "new job"`, `scheduled: false` | Creates an unscheduled HCP job. No `schedule`, no `line_items`. Issue and requested window go into job notes. `lead_source` is attributed from the tracking line. If HCP replies "Lead source not found" the job is retried without it. The requested window is stored in our own `callsessions` table only. Sends the notification email best-effort. |
| `set_job_type` (job_type) | `set`, `unknown_job_type` | Pierce only. Resolves the agent's job-type NAME to the tenant's `jbt_…` in `housecallpro_job_types` and pins it to the call session. No HCP write. An unconfigured name returns `unknown_job_type` and tells the agent to continue — the lead is worth more than the classification. |
| `create_lead` (issue, optional service_type, lead_source, scheduled_start, scheduled_end, address_id) | `created` with `scheduled: false` | Pierce's ending. Creates an HCP lead against the customer pinned to the session. Service type, issue and the part-of-day preference go into the lead's `note` (singular — see 7.4). The job type comes off the session (set earlier by `set_job_type`) and is sent as top-level `job_type_uuid`; a `job_type` argument is still honoured if that call was skipped, and no job type at all is dropped rather than failing the lead. `lead_source` comes from the dialed tracking line and that wins outright — it is a fact about which number rang, captured at `call_started`, so a spoken answer never overrides it. Only when the line maps to nothing is Clara asked; the attribution is then stamped `Clara` (one fixed name meaning the agent collected it) and the caller's actual words land on the lead note as `Heard about us :-`. On "Lead source not found" the lead is retried without it.

**`Clara` is not yet a configured lead source in Pierce's account** — the closest are `Claude` (editable, likely a mistyped Clara) and `CSR AI` (HCP built-in). Create it in Settings → Lead Sources or agent-collected attribution silently falls back to none. Row persisted to `housecallpro_leads`. Sends the `lead_created` email best-effort. |
| `escalate` (escalation_type, summary, optional caller_name, callback_number) | `captured` | Sends the notification email with the same structured notes block as the booking email. No HCP write. |

Error paths: a tool call with no live session returns `error: session not found`. Any thrown error returns `error: internal`. Both agents are told to retry once, then fall back to message-taking.

### 2.1 Caller identification in depth

Source: `src/services/housecallpro/handlers/customer-lookup.ts`, `handlers/fuzzy-lookup.ts`, `fuzzy-search.ts`, `db/customers.ts`, `supabase/housecallpro-cron/index.ts`.

**The cache.** Identification never queries HCP live. It reads the `housecallpro_customers` table in Supabase. A pg_cron edge function pulls one page of about 100 customers per tenant per run from HCP's customer list and upserts rows whose `updated_at` changed. Each row stores first name, last name, company, email, `mobile_number`, tags, lead source, and the list of address ids. It does not store home or work numbers, and it does not store address text. A customer created by Clara is upserted into the cache immediately, so the next call can find them.

**Step 1, phone match (`customer_lookup`).** The caller's number is reduced to its last 10 digits and compared to the generated column `normalized_mobile`, which is the last 10 digits of `mobile_number` only.

| Cache rows with that mobile | Result | Session |
|---|---|---|
| exactly one | `found` with first and last name | customer pinned, `match_tier = phone` |
| none | `not_found` | nothing pinned, fuzzy lookup allowed |
| two or more | `multiple_matches` with candidate list | agent asks last name or address, then `confirm_customer` |

A caller whose number is only in HCP's home or work field, or who calls from a spouse's phone, a new phone, or an office line, gets `not_found` here even though they are a registered customer.

**Step 2, name match (`lookup_customer_fuzzy`).** The agent asks for first and last name together and calls the tool. Optional arguments: `zip`, `address`, `old_phone`.

Candidate gathering: the name is split into tokens, and every token is matched with `ILIKE %token%` against first name, last name, and company name, tenant-scoped, capped at 200 rows. "Matt Sollett" pulls every row containing "matt" or "sollett" anywhere in those three fields. `zip` is accepted but not used in the query or the tiering, so it has no effect today.

Phone used for scoring: `old_phone` if the caller gave one, otherwise the number they are calling from. It is compared against the cached mobile only.

Signals computed per candidate:
- `nameExact`: normalized full name equal.
- `nameFuzzy`: the higher of token-set Jaccard and bigram Dice on the full name.
- `nameMatchStrong`: exact, or last name exact with first name at least 0.75 similar, or both names fuzzily close, or `nameFuzzy` at least 0.75.
- `nameMatchWeak`: first name only given and at least 0.8 similar.
- `phoneExact`: the query phone is the candidate's cached mobile.
- `customersForName`: how many candidates share that exact full name.
- `customersForExactPhone`: how many candidates share that phone.
- Address signals: always zero in this path, because cached rows carry no address text. Every tier rule that needs an address match is unreachable here.

Tier rules that can fire with the data available:

| Tier | Rule | Condition | Outcome |
|---|---|---|---|
| 1 | `phone_match_single_customer` | `old_phone` matches one cached mobile | `found`, pinned as `tier1` |
| 1 | `name_exact_single_customer` | exact full name, only one customer with it | `found`, pinned as `tier1` |
| 2 | `phone_match_multiple_customers` | `old_phone` matches two or more customers | `multiple_matches`, agent asks a detail, `confirm_customer` |
| 2 | `name_exact` | exact full name shared by two or more customers | `multiple_matches` with up to three candidates |
| 3 | `name_fuzzy_weak` | `nameFuzzy` above 0.7 but not exact | `not_found`, reason `low_confidence_matches` |
| 3 | `no_strong_match` | anything else | `not_found`, reason `low_confidence_matches` |

Tier 1 passes a cross-validation step before acceptance. If the agent also supplied an address and the name is below 0.6 similar, the match is rejected as `retell_data_mismatch`. If the phone maps to several customers and the name does not fit, it is rejected as `ambiguous_phone_mapping`.

**What this means for a registered customer calling from a different number.**

1. `customer_lookup` returns `not_found`.
2. The agent asks for first and last name and calls the fuzzy lookup.
3. If the spoken name normalizes to exactly the stored first and last name, and no other customer shares it, the caller is identified without any further question. Pinned as `tier1`, rule `name_exact_single_customer`.
4. If two or more customers share the exact name, the agent asks one distinguishing detail and calls `confirm_customer` with the chosen id.
5. If the caller mentions their old number, the agent passes it as `old_phone`. A match on the cached mobile identifies them as Tier 1 regardless of name spelling.
6. If the name is close but not exact ("Jon Smith" for "John Smith", "Matt" for "Matthew", a maiden name, a transcription slip), the lookup returns `not_found`. The agent then collects name and email and calls `create_customer`. This produces a duplicate customer in HCP.
7. After identification, `match_address` loads the customer's addresses live from HCP and the flow continues. The new number is not written back to HCP. The job notes carry it if the caller said it is their best callback number. The next call from that number goes through the same name path again.

**Known gaps in identification.**

- Home and work numbers are not cached, so callers on a landline that HCP already has are treated as unknown by phone.
- No address text in the cache, so the address-based tiers never fire and a near-miss name cannot be rescued by a matching address.
- Near-miss names fall to Tier 3 and lead to a duplicate customer.
- `zip` is dead input.
- The matched customer's mobile is never updated in HCP, so the same caller is re-identified by name every time.
- On any `not_found` the session status is set to `handed_off`, but nothing reads that status, so it has no effect on the flow.

### 2.2 Notification emails, emergency versus non-emergency

Source: `src/services/housecallpro/emailNotificationService.ts`, `handlers/job.ts:214-227`, `handlers/escalate.ts`.

**Transport.** SendGrid REST call from the backend. Sender is `SENDER_MAIL` or `noreply@justclara.ai`, display name "Clara AI". Recipients come from the tenant row: `emailto` as To, `ccMail` as Cc. If `SENDGRID_API_KEY` is unset the send is skipped with reason `sendgrid_not_configured`. Sends are fire-and-forget: a SendGrid failure is logged and never surfaces to the caller or the agent. No post-call email exists; the Retell `call_ended` webhook only updates session status.

**Only two email kinds exist.** The kind is chosen by which tool fired, not by urgency.

| | Office Hours, `book_job` | After Hours, `escalate` |
|---|---|---|
| Kind | `job_booked` | `escalation` |
| Subject | `New Job Booked — <Customer> \| #<job number>` | `Service Request — <Caller> (<escalation_type>)` |
| Badge | green "Job Booked" | orange "Service Request" |
| Rows | Customer, Callback Number, Service Address, Notes, Job Number | Caller, Callback Number, Service Address (only if known), Type, Notes |
| Notes content | the exact HCP job notes: `Service :- <type>` then `Issue Description :- <caller's account>` | `Issue Description :- <summary>` |
| Callback Number source | the number the caller dialed from (`session.caller`), never the spoken callback number | `callback_number` argument, falling back to the dialed-from number |
| Trigger | once per successful job creation | once per `escalate` call |

Example received by Laura on 2026-09-24: subject "Service Request — Logan Pritchard (general)", Type "general", Notes "Issue Description :- Logan Pritchard is requesting a straightforward install of a dedicated two hundred forty volt…".

**Emergency, Office Hours.** There is no emergency signal in `book_job`. The tool takes `service_type`, `issue`, optional `scheduled_start`, `scheduled_end`, `address_id`. The prompt tells Clara to "state the urgency plainly at the start of the `issue` text". So an emergency booking produces the same subject, same green badge, same rows as any other booking. The only difference is the first words of the Issue Description line inside the Notes row, for example "URGENT: no power to the whole house…". Nothing in the subject line distinguishes it. The job in HCP is a normal unscheduled "new job" with the urgency in its notes.

**Emergency, After Hours.** `escalate` carries `escalation_type` of `emergency`, `billing`, or `general`. That value lands in two places: the subject suffix "(emergency)" and the Type row. Badge colour and layout are identical for all three types. The session row is updated with `escalation_type`, `escalation_summary`, and status `escalated`. On an emergency call the prompt skips the email and availability questions, so the Notes row holds name, number, address, and the issue only.

**What does not exist today.**
- No SMS. Both Pierce prompts say "the text goes to (707) 644-4497". No code sends a text. Only the email is sent.
- No emergency-specific template, colour, priority header, or separate recipient list.
- No notification when a call ends without `book_job` or `escalate` being reached (spam, abandoned call, tool failure fallback to message-taking). Those calls leave only the Retell post-call fields (`is_emergency`, `intent`, `call_summary`) which are not emailed.
- No notification on `create_customer` alone.
- The spoken callback number on Office Hours bookings reaches Laura only if Clara prepends it to `issue`, as the prompt instructs. The Callback Number row always shows the dialed-from number.

**Implication for the lead-only change.** Laura asked for an "immediate notification with the caller's name, telephone number, service address, and a brief description of the emergency" and for the lead to be "clearly flagged as urgent". That needs a third kind, or an `urgent` flag on the lead tool, that changes the subject (for example "URGENT Lead — <Caller>"), the badge, and the Type row, independent of office or after hours.

## 3. Pierce Electric Office Hours (v6, `prompt.md`)

Persona: Clara, a human-sounding front desk receptionist. Never says AI, virtual, assistant, or automated. If asked "are you a robot?", she redirects to helping without lying outright. Clara answers only after Laura's line rings unanswered for roughly 15 to 20 seconds, so she is efficient and does not apologise for the wait.

Hard rules in force on every call:
- No transfer, ever. No live transfer exists on this line.
- No pricing, cost ranges, or estimates. No after-hours surcharge is mentioned.
- No booked day or time. Jobs are logged unscheduled and the office picks the time.
- No diagnosis over the phone.
- Never read `customer_id` or `address_id` aloud.
- Ask each detail once. One question per turn. Never ask new-or-existing; `customer_lookup` answers that.
- Never ask how many addresses are on file; `match_address` answers that.
- Numbers, ZIPs, and street numbers are read back digit by digit. Email is acknowledged only, never read back or spelled.

### Call flow

1. Greeting: "Thanks for calling Pierce Electric, this is Clara. How can I help you today?" Never greet by name in the opening.
2. Spam filter runs first. Flagged calls get "Thanks for calling Pierce Electric, but we're not interested. Take care." then `end_call`. No tools, no details. Unclear calls get one probe: "Could you tell me a bit more about the reason for your call today?"
3. Understand and engage: wait for the caller to finish, acknowledge in one or two sentences, no troubleshooting. If there is an active safety hazard, say "For your safety, please call 911 or your utility company right away." first.
4. Identify: call `customer_lookup`.
   - `found`: greet by first name, skip to step 5.
   - `not_found`: ask first and last name together, call `lookup_customer_fuzzy`. If still `not_found`, collect first name, last name, email (asked once), then `create_customer`.
   - `multiple_matches`: ask one distinguishing detail (last name or address), then `confirm_customer`.
5. Capture the issue first and only once. Classify into a canonical `service_type` ("EV Charger Installation", "Panel Replacement", "Outlet Repair", "Lighting Repair", "Electrical Repair", "Electrical Maintenance", "Estimate / Quote", "Commercial Electrical - <work>", or "Other/General - <intent>"). Capture the caller's full account as `issue` in their own words. One follow-up allowed if the job is unclear.
6. Address: ask for the service address and call `match_address` with the caller's words.
   - `matched`: continue.
   - `options`: read the saved addresses back as street and city, ask which one, call `match_address` again with the choice.
   - `ambiguous` or `not_found`: ask for street number, street name, and ZIP together, call once more. If still not matched, collect street, city, state, ZIP and call `create_address`.
   - `no_addresses`: collect the full address and call `create_address`.
   - Cap: at most three `match_address` calls per call.
7. Callback number: ask, read back digit by digit. If the caller says the number they are calling from is fine, accept it. If it differs, prepend it to `issue`.
8. Part-of-day preference: morning, afternoon, or evening. Pass as `scheduled_start` in ISO-8601 Pacific time (09:00, 14:00, 18:00). Never read back or confirm a time.
9. Call `book_job` with `service_type`, `issue`, and optional window. On success, tell the caller the request is logged and the team will follow up.
10. Confirm in one summary: name, callback number, address, service type. Email is not included.
11. "Is there anything else I can help you with before I let you go?" Then close: "Thanks for calling Pierce Electric, [Name]. Have a great day." then `end_call`.

### Edge cases

| Situation | Behaviour |
|---|---|
| Pricing question | Scripted line, then into the identify-and-book flow. |
| Asks for Laura, Matt, or a live person | "There's no one available for me to transfer you to right now, but I can get your information over to the team so they can call you back." Then identify-and-book. |
| Asks for a specific time | "I'll pass everything along to the team and someone will reach out to find a time that works for you." Continue. |
| Active safety hazard (sparks, smoke, fire, shock risk, exposed wires) | 911 or utility line first, then continue the flow. Urgency stated at the start of `issue`. |
| Urgent but not a hazard (no power, breaker won't reset, storm damage) | May ask "Is this something urgent that you'd like our team to know about right away, or is a regular follow-up fine?" Either way book the job and flag urgency in `issue`. Never promise a callback time, electrician, or same-day service. |
| Commercial, general contractor, or property manager | Ask whether it is on behalf of a general contractor or property manager, or their own property. Company name goes into `create_customer.company` for new callers and into `issue`. |
| Billing or payment question | Identify with `customer_lookup`, take a note and callback number. Do not book a job. |
| General question answered from the prompt | Answer headline first, offer to expand. Do not force intake if there is no service need. |
| Question not covered | "I don't have that information handy, but I'll pass your question along to the team and someone will follow up with you directly." Then intake. |
| Technical question needing a site visit | "That's something one of our electricians would really need to see in person." Then intake. |
| Location unclear or outside service area | Take the details; the team confirms coverage. Service area not yet confirmed (Benicia, Vallejo, Fairfield likely). |
| Frustrated or uncooperative caller | Let them vent, one gentle re-attempt for missing details, then book with whatever was given if identified; otherwise close warmly. |
| Tool error, caller cannot be identified or booked | Retry once. Then revert to message-taking: name, callback number, address, issue. Never mention a tool or system. |
| Caller corrects a read-back | Repeat only the corrected version once. |
| Casual greeting or "how are you" | Brief warm reply, then into the call. |

Post-call analysis fields: `call_summary`, `caller_first_name`, `caller_last_name`, `caller_phone`, `service_address`, `customer_email`, `intent` (enum: New Estimate / Quote Request, Schedule Installation, Residential Repair Request, Existing Customer - Billing / Payment, Existing Customer - Service Follow-up, Commercial Job (General Contractor / Property Manager), General Question, Spam / Solicitation, Other), `is_commercial`, `issue_description`, `is_emergency`, `is_spam`, `call_successful`.

Notifications: text to (707) 644-4497 and email to laura@pierce-inc.com, sent by the backend from the booked job. Clara does not mention this.

## 4. Pierce Electric After Hours (v5)

Same persona and hard rules as Office Hours, plus: no HCP tools. Clara never says the office is closed dismissively. Greeting: "Thanks for calling Pierce Electric, this is Clara. How can I help you tonight?"

### Call flow

1. Spam filter, identical to Office Hours. Flagged calls end with no `escalate`.
2. Understand and engage. 911 or utility instruction first for a hazard.
3. Emergency question, always: "Is this an emergency, or would you like someone to follow up with you during regular business hours?"
4. Detail collection, one question at a time, in order:
   1. Job type, only if the reason is generic.
   2. First and last name together. Never ask to spell.
   3. Callback number, read back digit by digit.
   4. Service address. Accept a decline without pushback.
   5. Email, asked once, acknowledged only. Skipped on emergencies.
   6. Reason for the call, full account. One follow-up if vague.
   7. Availability, mornings or afternoons. Skipped on emergencies.
5. Call `escalate` silently with `escalation_type` of `emergency`, `billing`, or `general`, and the full account in `summary`.
6. Confirm name, callback number, address, reason. Reassure: "I've got everything noted, and the team will take care of you as soon as they're back in the office."
7. "Is there anything else?" then close: "Thanks for calling Pierce Electric, [Name]. Someone from the team will be in touch during business hours. Have a good night." then `end_call`.

### Edge cases

| Situation | Behaviour |
|---|---|
| Caller confirms emergency | Empathise, collect fast (skip email and availability), `escalate` as `emergency`, close with "I'll flag this so the team can follow up as soon as possible." No callback time, no electrician, no cost mentioned. |
| Caller says not an emergency | Standard flow, no urgency framing. |
| Billing or payment | Name, callback number, brief note, `escalate` as `billing`. |
| Live agent request | "There's no one available for me to transfer you to right now…" then detail collection. |
| Commercial or general contractor | Ask the role question, include company and role in `summary`. |
| Uncooperative caller | One gentle re-attempt, then `escalate` with partial details and close warmly. |
| Tool failure | Retry once, then reassure the caller the message was captured. |
| Pricing, scheduling, technical, unknown question | Same scripted lines as Office Hours, then detail collection. |

Post-call fields: same set as Office Hours.

## 5. Zephyr Heating and Air Office Hours (v3)

Persona: Clara, a front desk assistant. Unlike Pierce, Clara discloses herself: "Hi, thanks for calling Zephyr Heating and Air. I'm Clara, a virtual assistant for the team. The team is busy right now, but your call is important — I'm here to gather your details and make sure someone gets back to you as quickly as possible." Backchannels ("mm-hmm", "right", "got it") and fillers are encouraged. HVAC-aware language.

Hard rules: no transfer, no pricing, no technician availability promise, no booked time, no re-asking.

The prompt text still describes a message-taking flow (ask new-or-existing, name, callback number without read-back, address, email, reason, availability, wind-down). The agent carries the full HCP tool set, with tool descriptions that drive the identify, match, and book sequence (`customer_lookup`, then fuzzy lookup or `create_customer`, then `match_address` or `create_address`, then `book_job` with `service_type` like "AC Repair" and the full `issue`). The prompt has not been updated to the Pierce-style identify-and-book instructions, so the model follows the tool descriptions for the HCP steps. This is a known gap.

### Call flow as the prompt describes it

1. Greeting with disclosure.
2. Spam filter. Flagged: "Thanks for calling Zephyr Heating and Air. We're not accepting any solicitations or promotional calls at this time. Have a great day." then `end_call`.
3. Understand and engage with HVAC language ("no AC in this heat", "no heat in this weather").
4. Detail collection in order: new or existing, name, callback number (not read back), property address, email (asked once), reason with one follow-up ("not cooling at all, or running but not as cold as it should be?"), availability.
5. Wind-down: "Perfect — I've got everything I need. The team's going to take good care of you." Then "Is there anything else?" Then close: "Thank you so much for calling Zephyr Heating and Air. Someone will be in touch with you shortly. Have a great rest of your day!" then `end_call`.

### Edge cases

| Situation | Behaviour |
|---|---|
| Pricing | "I'm not able to give out pricing over the phone — but someone from the team will go over all of that with you directly." |
| Asks for Dan or a live person | "I completely understand — the team is fully tied up right now, but I promise if you leave your details with me, someone will get back to you as quickly as possible." |
| Specific time requested | "I'll pass everything along to the team and someone will reach out to find a time that works for you." |
| Emergency | Empathise, collect details, flag internally. Zephyr has no on-call crew. No callback time or dispatch promised. |
| General question | Answer from the Zephyr knowledge base only. If unsure, the team follows up. |
| Caller declines address or email | Accept immediately. |

No post-call analysis fields are configured on either Zephyr agent.

## 6. Zephyr Heating and Air After Hours (v3)

Same persona and disclosure as Office Hours, plus Clara states the office is closed. Office hours Monday to Friday 8:00 AM to 5:00 PM Pacific. Office at 8821 Shirley Ave, Northridge, CA 91324. A `{{caller_name}}` variable may be injected; if it holds a real name, Clara greets by first name and skips the name question.

### Call flow

1. Greeting: "Hi, thanks for calling Zephyr Heating and Air. I'm Clara, a virtual assistant for the team. The office is closed right now, but I'm here to take down your details and make sure someone follows up with you as soon as we open."
2. Spam filter, same line as Office Hours.
3. Understand and engage.
4. Detail collection: name (skipped if known), callback number (not read back), property address, email (asked once), reason with one follow-up, availability.
5. Call `escalate` silently with `emergency` (urgent no-heat or no-cooling), `billing`, or `general`.
6. Wind-down: "I've got everything noted. The team's going to make sure you're taken care of as soon as we're back in the office." Then "Is there anything else?" Then close: "Thank you so much for calling Zephyr Heating and Air. Someone from the team will be in touch with you during business hours. Have a good night!" then `end_call`.

### Edge cases

| Situation | Behaviour |
|---|---|
| Emergency (no cooling in a heat wave, no heat in a cold spell) | Empathise, collect details, `escalate` as `emergency`. No dispatch, no callback time. |
| Billing | Name, callback number, brief note, `escalate` as `billing`. |
| Live agent request | "the office is closed right now and I'm not able to connect you with anyone directly…" then detail collection. |
| Pricing | "I'm not able to give out pricing — but the team will go over all of that with you when they follow up." After-hours surcharges are never mentioned. |
| Spanish speaker | Clara switches to Spanish: "Claro, puedo continuar en español. La oficina está cerrada en este momento, pero puedo tomar sus datos…" |
| General question | Knowledge base only; otherwise the team follows up during business hours. |

## 7. Lead creation creates a customer (the fact, with evidence)

### 7.1 HCP documentation

Create Lead endpoint: https://docs.housecallpro.com/docs/housecall-public-api/8961eaf9f1c28-create-lead

Endpoint description, verbatim:

> Create a lead with the ID for an already existing customer.

Glossary on the same page, verbatim:

> When creating a lead on Housecall Pro, an associated Customer must also be created

> A lead is used to track prospective work. There is no schedule, dispatch, or invoice information associated with a lead

> If a lead is marked as won, it can be copied to a job or an estimate

There is no customer-less lead in the API. Either we pass an existing `customer_id`, or HCP creates the customer as part of the lead.

### 7.2 Our test runs in Pierce Electric's HCP account, 2026-09-30

Each test lead produced a customer record in Pierce's customer list. Pulled from the live HCP API on 2026-10-01:

| Lead # | Lead id | Customer created | Customer id | Created (UTC) | Pipeline status |
|---|---|---|---|---|---|
| 126 | `lea_edd45a69be7e4c2e948fcf0d12492df0` | Clara Test | `cus_2fe64ad7a1484ca3bb80c1b1c8534bdd` | 2026-09-30 02:10 | Second Contact |
| 127 | `lea_a5980933d9204ddc9630f3567047c662` | Clara Test (same customer reused) | `cus_2fe64ad7a1484ca3bb80c1b1c8534bdd` | 2026-09-30 02:10 | Second Contact |
| 128 | `lea_77b8aaabe5a0497dbee51ce5a909f5f1` | Clara Fresh | `cus_a3650b476cbf45f1983b80dc427b4fb6` | 2026-09-30 02:28 | Second Contact |

"Clara Fresh" and "Clara Test" now appear under Customers in Pierce's HCP. Earlier job-booking tests (Sep 16 to Sep 24) left "Clara AI" (two records), "Clara Subham" (company "Clara AI"), and "Clara a I." as customers. Screenshots of the auto-created customers were sent to Laura in the 2026-09-30 email (Gmail message id `1a0f20efaebb0a4b`).

Side finding: all three test leads landed in pipeline status "Second Contact" with the tag "Pipeline Automation". Pierce has an HCP automation that moves "New Lead" to "Second Contact". Laura has chosen to leave it as is.

### 7.3 Email thread with Laura Pierce

Subject "Re: Fwd: Service Request — Logan Pritchard (general)", Gmail thread id `1a0d3e6e1707a5f0`.

- 2026-09-24, Laura: "Would it be possible for her to capture a new customer as a lead first… I'd prefer to review the lead and convert it to the appropriate job or estimate myself."
- 2026-09-25, Laura: "For all new callers, please have Clara create a lead rather than a customer profile or job." and "Clara should only create the lead record for my review and should not automatically generate an estimate."
- 2026-09-30 04:24 PT, Subham: "I successfully created New Leads- but HousecallPro automatically creates them as customers- regardless."
- 2026-09-30 10:42 PT, Subham: "we can set new and existing callers to be created strictly as leads with no job or estimate attached."
- 2026-09-30 13:49 PT, Laura: "My understanding of how House Call Pro works is you have to create a customer before you can assign it as a 'lead'." Then: "When incoming caller is not already in our customer list, Clara will: Capture customer info (name, address for service, cell phone, email and nature of the call) and assign it as a lead. From there I will decided to assign it as an estimate, book a job, etc."
- 2026-09-30 14:08 PT, Subham sent the HCP Create Lead doc link and stated the customer auto-creation is an API-level behaviour we cannot bypass.
- 2026-09-30 14:47 PT, Laura: "Okay that all sounds great".

### 2.3 Why book_job is still on the Pierce agent

The Pierce Office Hours agent carries both `book_job` and `create_lead`. Nothing was removed from the tool list; `create_lead` was added to it. The backend is the same shape — all eight original `/fn/` routes are untouched and `/fn/create_lead` is a ninth.

`book_job` is therefore reachable on a Pierce call and must never be chosen. Two guards, because the tool being present is the risk:

- Its tool description on the Pierce agent opens with "DO NOT CALL THIS TOOL ON THIS LINE" and says why.
- The prompt rules it out twice: in the HCP section (`prompt.md:293`) and in the CORE RULE block (`prompt.md:495`).

If a Pierce job ever appears from a Clara call, this is the thing that failed — check the Retell transcript for a `book_job` invocation before looking anywhere else.

## 7.4 POST /leads field support, probed live 2026-09-30

Several keys that appear in the lead RESPONSE are ignored on write. Verified by creating probe leads #133-#135 in Pierce's account and reading them back through the API and the UI.

| Key | Accepted | Notes |
|---|---|---|
| `customer_id` | yes | Top level. Required — `{}` returns 400 "Customer is required". |
| `customer` (inline object) | yes | Creates the customer as a side effect. We do not use it; `create_customer` runs first so the customer is in our cache. |
| `customer: { id }` | **no** | 400 "Customer must have one of first name, last name, email, or phone number". The id is only honoured as top-level `customer_id`. |
| `address_id` | yes | Populates the lead's address. |
| `note` | yes | Lands in the lead's Private Notes. **Singular.** |
| `notes` | **no** | Accepted by the API and silently dropped. Lead #133 sent it; Private Notes came back empty. |
| `tags` | yes | `["Clara"]` shows on the lead alongside the automation's own tag. |
| `lead_source` | yes | Exact configured NAME only. Unknown name → 400 "Lead source not found". |
| `job_type_uuid` | yes | **Top level.** |
| `job_fields.job_type_uuid` | **no** | Response-only. Lead #133 sent this shape and read back `null`. |

There is no `PUT`/`PATCH /leads/{id}` and no `GET /leads/{id}/notes` — both 404. A lead cannot be corrected through the API after creation.

`GET /lead_sources` (39 rows for Pierce) and `GET /job_fields/job_types` (6 rows for Pierce) both return 200. `GET /company/lead_sources` and `GET /job_fields/lead_sources` are 404.

Probe leads #133, #134, #135 on customer "Clara Fresh" are still in Pierce's pipeline and should be deleted from the UI.

## 8. Target flow for Pierce Electric Office Hours (lead-only)

After Hours stays on `escalate` only. Zephyr is not affected.

What changes: `book_job` is replaced by lead creation for every legitimate service call. Steps 1 to 8 of the current flow stay the same (spam filter, engage, identify, issue, address, callback number, part-of-day).

1. Spam filter first. Solicitors, vendors, salespeople, and job seekers: no lead, no customer. Details stay in the call summary only.
2. `customer_lookup` by caller number, then fuzzy lookup by name if needed.
3. New caller: collect name, phone, email, service address, full issue, preferred timeframe. Create the lead. HCP creates the customer as a side effect. Lead gets the `Clara` tag.
4. Existing customer: identify the nature of the call (existing job, estimate request, or new service request). Create the lead against the existing `customer_id`. Laura also asked for a message in HCP chat for this case.
5. No `book_job`. No estimate. Laura converts the lead to a job or estimate.
6. Emergency: flag the lead as urgent in the notes and send the immediate notification email with name, phone, address, and a short description.
7. Lead source: automatic from the dialed tracking line when mapped. Otherwise Clara asks "How did you hear about Pierce Electric?" and the answer is mapped to a configured lead-source name. Unmapped answers send no `lead_source` (HCP rejects unknown names).
8. Notification email template: mark the request clearly as "lead only" so Laura sees at a glance that nothing was scheduled.

## 9. Open items

- Apply `migrations/20261005_001_housecallpro_job_types.sql` and `20261005_002_housecallpro_leads.sql` to Supabase. `create_lead` fails without them.
- Publish the updated Pierce Office Hours prompt + `create_lead` tool in Retell, then re-export. The checked-in v6 export has been edited to match `prompt.md` and is what to publish, not what Retell currently serves.
- The mid-call "how did you hear about us?" answer maps to an enum of 11 configured HCP names on the tool. Confirm that list with Laura; the other 28 of her 39 are internal-only.
- Whether existing-customer calls should also post to HCP chat, and which API supports that.
- The urgent/emergency lead flag Laura asked for. Needs its own email kind; `create_lead` currently puts urgency at the start of the issue text only.
- Whether to keep the "Pipeline Automation" rule that moves new leads to "Second Contact". Laura's current answer: leave it. Settings → Pipeline → Automations → Leads, the `New Lead` row: SMS + Update status → Second Contact, no delay, no conditions.
- Zephyr Office Hours prompt still reads as message-taking while the agent carries HCP tools. Align the prompt with the Pierce identify-and-log wording or confirm that Dan wants message-taking only.
