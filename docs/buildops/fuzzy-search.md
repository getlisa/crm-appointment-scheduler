# BuildOps Integration — Customer Identification & Fuzzy Search

Implementation: [`src/services/buildops/fuzzy-search.ts`](../../src/services/buildops/fuzzy-search.ts), [`src/services/buildops/handlers/fuzzy-lookup.ts`](../../src/services/buildops/handlers/fuzzy-lookup.ts), [`src/services/buildops/db/customers.ts`](../../src/services/buildops/db/customers.ts)

---

## Two-Phase Lookup

### Phase 1 — Exact Phone Match

Before any fuzzy logic runs, the inbound `from_number` is normalized to last-10 digits and checked against the `all_numbers` GIN array on `buildops_customers`:

```sql
SELECT * FROM buildops_customers
WHERE tenant_id = $1
  AND is_active = true
  AND all_numbers @> ARRAY[$2]
```

This is O(1) thanks to the GIN index. Results:
- **1 match** → customer auto-confirmed; agent proceeds directly to property resolution
- **2+ matches** → agent reads names, caller picks; `confirm_customer` sets `matchedCustomerId`
- **0 matches** → Phase 2 begins

Fallback: if `all_numbers` is not yet populated, the query also checks `normalized_phone_primary` / `normalized_phone_secondary` columns.

---

### Phase 2 — Fuzzy Search (triggered by agent calling `lookup_customer_fuzzy`)

When Phase 1 finds nothing, the agent asks the caller for their name, address, or ZIP. Those inputs are passed to `handleLookupFuzzy()`, which:

1. Calls `getFuzzyCandidates()` → DB query (see below)
2. Scores each candidate → `scoreCandidates()`
3. Assigns a confidence tier → `computeMatchSignals()` + `assignTier()`
4. Returns `found`, `multiple_matches`, or `not_found`

---

## DB Candidate Retrieval (`getFuzzyCandidates`)

Two independent sub-queries are run and merged (deduped by customer ID):

| Sub-query | Condition | Table |
|---|---|---|
| By name/zip | `name ILIKE '%{name}%'` and/or `addresses @> [{zip: ...}]` | `buildops_customers` |
| By address | `address->>'line1' ILIKE '%{first 4 words}%'` → join back to customer | `buildops_properties` |

Limit: 200 rows from the name/zip query, 50 from the property address query. Results from the property query are hydrated with `propertyAddresses` on the customer object for scoring.

---

## Scoring Algorithms

All implemented in `src/services/buildops/fuzzy-search.ts`.

### Jaro-Winkler

Standard string similarity with a prefix bonus (first 4 characters weighted higher). Used for name-to-name comparison.

```
score ∈ [0, 1]:  0 = completely different, 1 = identical
prefix bonus: min(shared_prefix_length, 4) × 0.1 × (1 − jaro)
```

### Soundex

Phonetic encoding (NARA standard). Each name token is encoded as a 4-character code (letter + 3 digits). Used to detect phonetic matches like "Smyth" ↔ "Smith".

### Token-Set Ratio (Jaccard)

Splits both strings into word tokens, computes Jaccard similarity on the token sets. Handles word order variation and extra words ("ABC Heating and Cooling" vs "ABC Cooling"):

```
tokenSetRatio(a, b) = |tokens_a ∩ tokens_b| / |tokens_a ∪ tokens_b|
```

### Address Normalization

Applied before any address comparison:
- Expand USPS abbreviations: `St` → `Street`, `Ave` → `Avenue`, `Blvd` → `Boulevard`, etc.
- Strip punctuation and normalize whitespace
- Lowercase

---

## Weighted Scoring

`scoreCandidates()` computes a weighted composite score per candidate:

| Field | Weight | Method |
|---|---|---|
| Last name / company name | 0.25 | Jaro-Winkler + Soundex bonus |
| Address (line 1) | 0.30 | Token-set ratio on normalized strings |
| ZIP code | 0.15 | Exact match = 1.0, else 0 |
| Phone | 0.15 | Exact match of last-10 digits = 1.0, else 0 |
| First name | 0.10 | Jaro-Winkler |
| City | 0.05 | Jaro-Winkler |

Final score = sum of (field_score × weight), clamped to [0, 1].

---

## Threshold Bands

After scoring, `applyThreshold()` assigns one of three decisions:

| Band | Score | Decision |
|---|---|---|
| Accept | ≥ 0.90 | `found` — single best candidate is auto-accepted |
| Disambiguate | 0.75 – 0.89 | `multiple_matches` — up to 3 candidates returned |
| Handoff | < 0.75 | `not_found` — no usable match |

---

## Confidence Tiers

Tiers are assigned independently of the score bands using match signal rules (from `computeMatchSignals()` + `assignTier()`). Tier determines what happens after identification:

| Tier | Meaning | Job handling |
|---|---|---|
| 1 | High confidence — phone or strong name+address match | Job created immediately |
| 2 | Medium confidence — name match without phone verification | Job created with `needs_review = true` |
| 3 | Low confidence | No job — `transfer_call` to human |

Key signals evaluated per candidate:
- `phoneMatch` — caller's number found in candidate's `all_numbers`
- `nameMatchExact` — normalized exact name match
- `nameMatchFuzzy` — Jaro-Winkler ≥ threshold
- `nameMatchWeak` — first-name-only match
- `nameMismatch` — name clearly doesn't match
- `addressMatch` — full address string match
- `addressQueryMatch` — address sub-string match via `addressQueryMatch()`
- `addressSimilarity` — token-set ratio score on address
- `companyNameFuzzy` — Jaro-Winkler score on company name
- `queryHasFullName` — query contained both first + last name
- `locationsForCompany` — count of rows with identical name (multi-location companies)
- `locationsForExactPhone` — count of rows sharing the same phone

---

## Multiple Matches Handling

### 2–3 candidates (Tier 2 `multiple_matches`)

The agent reads the candidate names back to the caller. Caller selects their account by name. Agent calls `confirm_customer` with the chosen `candidate_id`.

### 4+ candidates OR all weak-name matches

When all Tier 2 candidates are weak-name-only matches (first name only, no last name), the response includes `message: "need_last_name"`. The agent asks the caller for their last name, then re-calls `lookup_customer_fuzzy` with the updated name input. The returned candidates list is always capped at 3 for agent readability.

### Pre-tree short-circuit (name+address mismatch)

If the query includes both a full name AND an address, and the address matches at least one candidate's properties, but **none** of the matching candidates have a name that resembles the given name — this is a strong signal that the caller provided the wrong name for that address. The lookup returns `not_found` with `message: "name_address_mismatch"` instead of presenting incorrect candidates.

Example: query `name="Rahul Jason"` + `address="2 London Road"` → database has "Rahul Saxena" and "Rahul Singh" at that address → none match "Jason" → `not_found` immediately.

### Cross-validation (Tier 1 gating)

Before a Tier 1 accept is returned, `crossValidate()` checks for internal consistency:
- If the query provided a name and an address, but the best candidate's address doesn't match the given address, the accept is rejected
- If the best candidate's name is a clear mismatch against the given name, the accept is rejected
- Failed cross-validation → `handed_off` status + `not_found`

---

## Sorting

Before thresholding, candidates are sorted:
1. Tier (ascending — tier 1 first)
2. `addressSimilarity` (descending)
3. `companyNameFuzzy` (descending)

The top candidate in the sorted list is used as the "best match" for Tier 1 accept decisions.
